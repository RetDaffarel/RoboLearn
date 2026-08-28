import RoboBLE from './bluetooth.js';

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, getIdTokenResult,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, setDoc, getDoc, collection, getDocs, deleteDoc, query, where,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

/* True on phones/tablets — used to decide whether elements get the
   native HTML5 draggable="true" attribute at all. Real bug this fixes:
   on some touch browsers (notably Chrome Android), draggable="true"
   makes the browser try to handle the gesture with its OWN (broken —
   touch never fully fires native dragstart) drag machinery, which can
   silently swallow the touch events before our custom touch-drag JS
   (see attachTouchDrag below) ever sees them — the exact "literally no
   reaction at all" symptom. Skipping the attribute entirely on touch
   devices avoids that fight; desktop mouse dragging is unaffected. */
const IS_TOUCH_DEVICE = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);


/* ── Firebase init ──────────────────────────────────────────── */
const firebaseConfig = {
  apiKey: "AIzaSyClJqYp8PsO8rik5TPCh-zWFGuR3ZjYZdk",
  authDomain: "robolearndb.firebaseapp.com",
  projectId: "robolearndb",
  storageBucket: "robolearndb.firebasestorage.app",
  messagingSenderId: "244450253725",
  appId: "1:244450253725:web:4c320c55c91713b653ed74",
  measurementId: "G-TFKX7YMV6J",
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// Firestore with offline persistence — cached reads/writes work without
// internet, and auto-sync once the connection comes back.
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

let currentUser = null; // set by onAuthStateChanged below
let currentUserRole = 'siswa'; // 'siswa' | 'guru' | 'admin' — from the ID token's custom claim, never trust anything else client-side

/* ── Project persistence — Firestore SDK directly, NOT the FastAPI
   backend. This is what makes offline actually work: writes here
   go through `persistentLocalCache`, so they succeed instantly
   even offline and sync automatically once the connection returns.
   The Python backend's /api/projects/save & GET are no longer
   called from here (still fine to keep around for other consumers,
   e.g. a future teacher dashboard using the Admin SDK).

   Students can now have MULTIPLE saved projects (previously this was
   one doc per student, keyed by uid, always overwritten). Each project
   is its own doc in the `projects` collection with a `student_id`
   field — mirrors the same pattern already used for `quests`
   (client-generated doc id via doc(collection(db,'projects'))).
   NOTE: firestore.rules needs a rule for this collection restricting
   read/write to student_id == request.auth.uid (still pending from
   the earlier security review — same gap noted for `quests`).      */
let myProjects       = [];   // this student's own saved projects, freshest first
let currentProjectId = null; // which one is open in the Code page; null = new/unsaved

function renderProjectList() {
  const list = document.getElementById('project-list');
  if (!list) return;
  list.innerHTML = '';
  if (!myProjects.length) {
    list.innerHTML = '<div class="canvas-empty-hint">Belum ada proyek tersimpan. Yuk mulai yang pertama!</div>';
    return;
  }
  myProjects.forEach(p => {
    const row = document.createElement('div');
    row.className = 'dash-row';
    const savedWhen = p.saved_at ? new Date(p.saved_at).toLocaleString('id-ID') : '';
    row.innerHTML = `
      <div class="dash-row-top">
        <div>
          <div class="dash-row-email">${p.project_name || 'Untitled'}${p.id === currentProjectId ? ' <span style="color:var(--accent-orange);font-size:10px;">(sedang dibuka)</span>' : ''}</div>
          <div class="dash-row-sub">Terakhir disimpan ${savedWhen}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="dash-icon-btn delete-project-btn" title="Hapus proyek" aria-label="Hapus proyek">🗑️</button>
          <button class="dash-btn">Buka</button>
        </div>
      </div>
    `;
    row.querySelector('.dash-btn').addEventListener('click', () => openProject(p));
    row.querySelector('.delete-project-btn').addEventListener('click', () => deleteProject(p));
    list.appendChild(row);
  });
}

async function deleteProject(project) {
  const name = project.project_name || 'Untitled';
  if (!confirm(`Hapus proyek "${name}"? Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    await deleteDoc(doc(db, 'projects', project.id));
    myProjects = myProjects.filter(p => p.id !== project.id);
    // If the project being deleted is the one currently open in the Code
    // editor, fall back to a blank canvas so we're not left pointing at
    // a project doc that no longer exists (next Save would just recreate
    // it under the same id via setDoc's merge).
    if (currentProjectId === project.id) {
      currentProjectId = null;
      programBlocks = seedBlocks([{ type: 'event_flag', params: {} }]);
      document.getElementById('prog-name').value = 'My Program';
      historyStack = [];
      redoStack = [];
      renderCanvas();
    }
    renderProjectList();
    showToast('🗑️ Proyek dihapus');
  } catch (err) {
    showToast(`Gagal hapus: ${err.message}`);
  }
}

async function loadMyProjects() {
  try {
    const snap = await getDocs(query(collection(db, 'projects'), where('student_id', '==', currentUser.uid)));
    myProjects = snap.docs.map(d => ({ ...d.data(), id: d.id }))
      .sort((a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''));
  } catch (err) {
    console.warn('Load projects failed (probably offline + no cache yet):', err.message);
    myProjects = [];
  }
  renderProjectList();
}

/* Opens a specific saved project into the Code page's canvas. */
function openProject(project) {
  currentQuestId = null;
  currentQuestObj = null;
  currentAssignmentGoal = DEFAULT_ASSIGNMENT_GOAL;
  hideQuestBanner();
  updateQuestTabVisibility();
  currentProjectId = project.id;
  programBlocks = seedBlocks(project.blocks || []);
  document.getElementById('prog-name').value = project.project_name || 'Untitled';
  historyStack = [];
  redoStack = [];
  renderCanvas();
  renderProjectList(); // refresh the "(sedang dibuka)" tag
  activateNavButton('code');
  switchPage('code');
}

async function saveProjectToFirestore() {
  if (!currentUser) { showToast('Silakan masuk terlebih dahulu.'); return; }
  try {
    const projectName = document.getElementById('prog-name').value;
    const savedAtISO = new Date().toISOString();
    // No project open yet (fresh "+ Buat Proyek Baru", or first-ever
    // save) -> create a brand-new doc instead of overwriting another
    // project. Once created, keep saving to that same doc id.
    if (!currentProjectId) {
      const newDocRef = doc(collection(db, 'projects'));
      currentProjectId = newDocRef.id;
    }
    await setDoc(doc(db, 'projects', currentProjectId), {
      id:           currentProjectId,
      project_name: projectName,
      student_id:   currentUser.uid,
      blocks:       programBlocks,
      saved_at:     savedAtISO,
    }, { merge: true });
    // Keep the Home card's project list in sync immediately — it
    // previously only refreshed on app load, so a freshly saved
    // project never showed up on Home until a full page reload.
    await loadMyProjects();
    showToast(navigator.onLine
      ? '💾 Project tersimpan'
      : '💾 Tersimpan secara lokal — akan sync otomatis saat online');
  } catch (err) {
    console.warn('Save to Firestore failed:', err.message);
    showToast(`Gagal menyimpan: ${err.message}`);
  }
}

/* ── Quests — each sensor now has its own progression track of 3
   stages (easy → medium → hard). A stage is locked until the previous
   stage in the SAME track is completed (score >= QUEST_PASS_SCORE).
   Every quest still just swaps the AI Assessment's `assignment_goal`
   and starts the student from a blank canvas — the actual teaching
   happens through the editor + AI feedback loop, not a scripted
   tutorial. Passing is recorded per-student in Firestore (same
   `quest_progress` collection/shape as before — only the id scheme
   changed, e.g. 'ultrasonic' -> 'ultrasonic_easy'), so old progress
   docs for the previous flat quest ids simply won't match anything
   anymore and stages will show as not-yet-completed.               */
const QUEST_PASS_SCORE = 70;
const LEVEL_LABEL = { easy: 'Mudah', medium: 'Sedang', hard: 'Sulit' };

/* ── Quest icons — inline SVG instead of emoji ────────────────────
   Emoji render inconsistently across OS/device emoji fonts (Android's
   Noto Color Emoji vs Apple's set vs others) — different visual size,
   baseline, and weight per device. That's the likely root cause of the
   quest-tile badge/icon overlap bug patched earlier (just added more
   padding as a buffer, not a real fix). SVG with currentColor renders
   pixel-identical everywhere. questIconHTML() falls back to returning
   the raw string untouched for any key it doesn't recognize — that's
   what lets teacher-typed custom quest icons (still plain emoji text,
   out of scope for this pass) keep working exactly as before. */
const ICON_SVG = {
  ultrasonic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><path d="M5.3 12.3a9 9 0 0 1 13.4 0"/><path d="M2.2 9.2a13 13 0 0 1 19.6 0"/></svg>',
  gripper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v5"/><path d="M8 8c-2.2 0-4 1.8-4 4s1.3 3.6 3 4"/><path d="M16 8c2.2 0 4 1.8 4 4s-1.3 3.6-3 4"/><path d="M7 16l-1.3 5"/><path d="M17 16l1.3 5"/><circle cx="12" cy="5.5" r="2.5"/></svg>',
  led_buzzer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 18h5"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.5.4.8 1 .8 1.7v.6h6.4v-.6c0-.7.3-1.3.8-1.7A7 7 0 0 0 12 2z"/></svg>',
  line_follower: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22 8 2"/><path d="M20 22 16 2"/><path d="M12 2v3"/><path d="M12 9.5v3"/><path d="M12 17v3"/></svg>',
  locked: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
};
/* Curated subset (and display order) offered in the teacher's "create
   quest" icon picker — a reasonable spread of themes, not literally
   every key in ICON_SVG (ultrasonic/gripper/etc. are sensor-track-
   specific and would be a confusing default set for a general quest). */
/* Only icons ALREADY used elsewhere in this app (the built-in quest
   tracks' icons) — kept deliberately narrow per request, rather than
   inventing a broader icon set the rest of the site never uses. */
const QUEST_PICKER_ICONS = ['target', 'ultrasonic', 'gripper', 'led_buzzer', 'line_follower', 'locked'];
function questIconHTML(key) {
  return ICON_SVG[key] || key; // unknown key (e.g. raw teacher-typed emoji) — pass through as-is
}

/* Renders the icon dropdown (toggle button + collapsible options panel)
   inside the quest form and wires up open/close/select. `selectedKey`
   is whichever icon the quest currently has (existing quest being
   edited) or 'target' as the default for a brand-new quest. Selecting
   an option updates the hidden #qf-icon input's value exactly like
   before — every other piece of code (openQuestForm, the submit
   handler) reads that value the same way regardless of the widget. */
function renderQuestIconPicker(selectedKey) {
  const toggle  = document.getElementById('qf-icon-toggle');
  const preview = document.getElementById('qf-icon-toggle-preview');
  const panel   = document.getElementById('qf-icon-panel');
  const hiddenInput = document.getElementById('qf-icon');

  function closePanel() {
    panel.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
  }
  function openPanel() {
    panel.classList.remove('hidden');
    toggle.setAttribute('aria-expanded', 'true');
  }

  preview.innerHTML = questIconHTML(selectedKey);
  panel.innerHTML = '';
  QUEST_PICKER_ICONS.forEach(key => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'icon-dropdown-option' + (key === selectedKey ? ' selected' : '');
    opt.innerHTML = questIconHTML(key);
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-label', key);
    opt.addEventListener('click', () => {
      hiddenInput.value = key;
      preview.innerHTML = questIconHTML(key);
      panel.querySelectorAll('.icon-dropdown-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      closePanel();
    });
    panel.appendChild(opt);
  });

  // Re-wiring these fresh each render (openQuestForm can be called
  // repeatedly) — clone-and-replace is the simplest way to drop any
  // previously attached listeners instead of stacking duplicates.
  const freshToggle = toggle.cloneNode(true);
  toggle.replaceWith(freshToggle);
  freshToggle.addEventListener('click', e => {
    e.stopPropagation();
    panel.classList.contains('hidden') ? openPanel() : closePanel();
  });
  document.addEventListener('click', e => {
    if (!document.getElementById('qf-icon-dropdown').contains(e.target)) closePanel();
  });
}

const QUEST_TRACKS = [
  {
    trackId: 'ultrasonic', icon: 'ultrasonic', title: 'Sensor Ultrasonik',
    stages: [
      {
        level: 'easy', id: 'ultrasonic_easy', title: 'Berhenti Sebelum Menabrak',
        desc: 'Robot maju lalu berhenti begitu ada penghalang di depannya.',
        goal: "Gunakan blok 'read ultrasonic' dan kondisi (IFLT) agar robot bergerak maju, lalu berhenti otomatis begitu jaraknya kurang dari sekitar 10 cm dari penghalang.",
        relevantChecks: ['motion_blocks_present', 'sensor_usage_detected', 'event_trigger_set'],
      },
      {
        level: 'medium', id: 'ultrasonic_medium', title: 'Mundur & Berbelok',
        desc: 'Setelah berhenti, robot mundur sedikit lalu berbelok menghindari penghalang.',
        goal: "Robot maju sampai mendeteksi penghalang (jarak < 10 cm), lalu berhenti, mundur sebentar, dan berbelok ke salah satu arah supaya bisa menghindar dari penghalang tersebut.",
        relevantChecks: ['motion_blocks_present', 'sensor_usage_detected', 'event_trigger_set'],
      },
      {
        level: 'hard', id: 'ultrasonic_hard', title: 'Patroli Otomatis',
        desc: 'Robot terus berjalan berputar-putar sambil selalu menghindari halangan, tanpa berhenti total.',
        goal: "Buat robot bergerak maju secara terus-menerus (loop/forever) sambil terus membaca sensor ultrasonik; setiap kali mendeteksi penghalang, robot otomatis berbelok menghindar lalu lanjut maju lagi — robot tidak boleh berhenti total di satu tempat.",
        relevantChecks: ['motion_blocks_present', 'sensor_usage_detected', 'event_trigger_set', 'loop_structure_used'],
      },
    ],
  },
  {
    trackId: 'gripper', icon: 'gripper', title: 'Gripper / Arm',
    stages: [
      {
        level: 'easy', id: 'gripper_easy', title: 'Buka-Tutup Gripper',
        desc: 'Kenalan sama gripper — buka lalu tutup untuk simulasikan mengambil benda.',
        goal: "Gunakan blok 'buka gripper' lalu 'tutup gripper' secara berurutan untuk mensimulasikan mengambil sebuah objek.",
        relevantChecks: ['motion_blocks_present', 'event_trigger_set'],
      },
      {
        level: 'medium', id: 'gripper_medium', title: 'Pick and Place',
        desc: 'Gabungkan gripper dengan gerakan motor untuk memindahkan objek dari satu titik ke titik lain.',
        goal: "Buat robot maju sedikit, tutup gripper (mengambil objek), mundur atau berbelok, lalu buka gripper lagi (meletakkan objek) — simulasikan proses pick and place yang lengkap dengan gerakan motor.",
        relevantChecks: ['motion_blocks_present', 'event_trigger_set'],
      },
      {
        level: 'hard', id: 'gripper_hard', title: 'Ambil Otomatis Pakai Sensor',
        desc: 'Gripper menutup sendiri begitu robot mendeteksi objek lewat sensor ultrasonik.',
        goal: "Gabungkan sensor ultrasonik dan gripper: robot maju sampai mendeteksi objek dalam jarak dekat (< 10 cm), lalu otomatis berhenti dan menutup gripper untuk 'mengambil' objek tersebut, kemudian mundur membawanya.",
        relevantChecks: ['motion_blocks_present', 'sensor_usage_detected', 'event_trigger_set'],
      },
    ],
  },
  {
    trackId: 'led_buzzer', icon: 'led_buzzer', title: 'LED RGB + Buzzer',
    stages: [
      {
        level: 'easy', id: 'led_buzzer_easy', title: 'Sinyal Siap',
        desc: 'Nyalakan LED hijau dan bunyikan satu nada sebagai tanda robot siap.',
        goal: "Gunakan blok LED (nyalakan warna hijau) dan blok suara (mainkan satu nada) agar robot memberi sinyal 'siap' saat program mulai berjalan.",
        relevantChecks: ['led_control_present', 'event_trigger_set'],
      },
      {
        level: 'medium', id: 'led_buzzer_medium', title: 'Dua Sinyal Berbeda',
        desc: 'Robot memberi sinyal warna dan nada berbeda untuk dua kondisi berbeda.',
        goal: "Buat robot memberi dua sinyal berbeda untuk dua kondisi berbeda, misalnya LED hijau + nada tinggi saat 'aman', dan LED merah + nada rendah saat 'terhalang' (bisa dipicu manual lewat blok kondisi apa pun).",
        relevantChecks: ['led_control_present', 'event_trigger_set'],
      },
      {
        level: 'hard', id: 'led_buzzer_hard', title: 'Alarm Reaktif Jarak',
        desc: 'Warna LED dan bunyi buzzer berubah otomatis mengikuti jarak dari sensor ultrasonik.',
        goal: "Gabungkan sensor ultrasonik dengan LED dan buzzer: semakin dekat jarak yang terbaca sensor, semakin 'waspada' sinyalnya (misalnya LED hijau→kuning→merah dan bunyi buzzer makin sering) — buat sistem alarm jarak yang reaktif.",
        relevantChecks: ['led_control_present', 'sensor_usage_detected', 'event_trigger_set', 'loop_structure_used'],
      },
    ],
  },
  {
    trackId: 'line_follower', icon: 'line_follower', title: 'Sensor Garis',
    stages: [
      {
        level: 'easy', id: 'line_follower_easy', title: 'Ikuti Garis Lurus',
        desc: 'Robot mengikuti jalur garis hitam sederhana selama beberapa detik.',
        goal: "Gunakan blok 'ikuti garis selama ... detik' agar robot mengikuti jalur garis hitam di lantai secara otomatis selama beberapa detik.",
        relevantChecks: ['motion_blocks_present', 'sensor_usage_detected', 'event_trigger_set'],
      },
      {
        level: 'medium', id: 'line_follower_medium', title: 'Ikuti Garis + Indikator',
        desc: 'Robot mengikuti garis sambil menyalakan LED sebagai indikator sedang berjalan.',
        goal: "Robot mengikuti garis (blok 'ikuti garis selama ... detik'), sambil menyalakan LED (misal hijau) sebagai indikator bahwa mode line-following sedang aktif, lalu mematikan/mengubah LED saat selesai.",
        relevantChecks: ['motion_blocks_present', 'sensor_usage_detected', 'led_control_present', 'event_trigger_set'],
      },
      {
        level: 'hard', id: 'line_follower_hard', title: 'Line Following Lengkap',
        desc: 'Robot mengikuti garis berulang kali dengan sinyal status yang jelas tiap tahap.',
        goal: "Buat robot mengikuti garis beberapa kali berturut-turut (bisa diulang dengan blok 'ikuti garis' beberapa kali atau loop), dengan sinyal LED/buzzer yang berbeda di awal, saat berjalan, dan saat selesai — tunjukkan alur status yang lengkap dari awal sampai akhir.",
        relevantChecks: ['motion_blocks_present', 'sensor_usage_detected', 'led_control_present', 'event_trigger_set', 'loop_structure_used'],
      },
    ],
  },
];

/* Flattens QUEST_TRACKS into individual quest objects shaped like the
   old flat QUESTS array (id/icon/title/subtitle/desc/goal), plus the
   track/level metadata renderQuestGrid needs for grouping + locking. */
function builtInQuestsFlat() {
  return QUEST_TRACKS.flatMap(track =>
    track.stages.map((stage, stageIndex) => ({
      id: stage.id,
      icon: track.icon,
      title: stage.title,
      subtitle: `${track.title} · ${LEVEL_LABEL[stage.level]}`,
      desc: stage.desc,
      goal: stage.goal,
      relevantChecks: stage.relevantChecks,
      trackId: track.trackId,
      level: stage.level,
      stageIndex,
    }))
  );
}

/* A stage is unlocked if it's the first stage of its track, or the
   previous stage in the same track has been completed. */
function isStageUnlocked(quest) {
  if (quest.stageIndex === 0) return true;
  const track = QUEST_TRACKS.find(t => t.trackId === quest.trackId);
  const prevStage = track.stages[quest.stageIndex - 1];
  return !!questProgress[prevStage.id]?.completed;
}

const DEFAULT_ASSIGNMENT_GOAL = 'Buat robot bergerak dan bereaksi terhadap lingkungannya menggunakan sensor yang tersedia.';
let currentQuestId       = null;               // null = normal "My Project" mode
let currentQuestObj      = null;               // full quest object (for the Quest info panel) — null in sync with currentQuestId
let currentAssignmentGoal = DEFAULT_ASSIGNMENT_GOAL;
let questProgress        = {};                 // { [questId]: { completed, bestScore } }

/* ── Quest info panel (right panel's "Quest" tab) — shows what the
   student is currently working on + a hint of what's required. Only
   visible while a quest is active; starting a new/other project (or
   opening a saved one) hides the tab entirely since there's no quest
   context to show.                                                 */
function renderQuestInfoPanel() {
  if (!currentQuestObj) return;
  const q = currentQuestObj;
  document.getElementById('qi-icon').innerHTML = questIconHTML(q.icon || 'target');
  document.getElementById('qi-title').textContent = q.title || 'Quest';
  document.getElementById('qi-desc').textContent = q.desc || '';
  document.getElementById('qi-hint').textContent = q.hint || q.goal || '';
  const badge = document.getElementById('qi-level-badge');
  if (q.level) {
    badge.textContent = LEVEL_LABEL[q.level] || q.level;
    badge.className = `stage-level-badge level-${q.level}`;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none'; // custom teacher-made quests have no easy/medium/hard level
  }
}

/* Shows/hides the "Quest" tab depending on whether a quest is active,
   and falls back to the Robot tab if the Quest tab was open when the
   quest context disappears (e.g. student starts a new project). */
function updateQuestTabVisibility() {
  const stageTab = document.getElementById('stage-tab-btn');
  if (currentQuestObj) {
    stageTab.classList.remove('tab-hidden');
    renderQuestInfoPanel();
    // Auto-switch to the Quest tab so the student sees the brief
    // immediately instead of having to notice a new tab appeared.
    stageTab.click();
  } else {
    stageTab.classList.add('tab-hidden');
    if (stageTab.classList.contains('active')) {
      document.querySelector('.panel-tab[data-tab="robot"]').click();
    }
  }
}

/* ── Custom quests — guru/admin-created, stored in Firestore (`quests`
   collection) so every student sees them alongside the built-in
   sensor quest tracks above. Security-rule-gated: any authenticated user can
   READ, but only guru/admin can CREATE, and only the quest's own
   creator (or admin) can EDIT/DELETE it — see the rules note I gave
   the user for this collection. `allQuests()` is what UI code should
   iterate over, never the bare QUEST_TRACKS/customQuests arrays directly. */
let customQuests = [];
function allQuests() { return [...builtInQuestsFlat(), ...customQuests]; }

async function loadCustomQuests() {
  try {
    const snap = await getDocs(collection(db, 'quests'));
    customQuests = snap.docs
      .map(d => ({ ...d.data(), id: d.id, docId: d.id, custom: true }))
      .filter(q => q.active !== false);
  } catch (err) {
    console.warn('Load custom quests failed:', err.message);
    customQuests = [];
  }
}

async function createCustomQuest({ icon, title, subtitle, desc, goal, hint }) {
  // Generate the doc ID client-side FIRST so we can store it as `id`
  // inside the document too — every quest object (built-in or custom)
  // needs a stable, self-contained `id` field, since that's what
  // questProgressRef()/allQuests() key off of everywhere else.
  const newDocRef = doc(collection(db, 'quests'));
  await setDoc(newDocRef, {
    id: newDocRef.id,
    icon: icon || '🎯',
    title, subtitle: subtitle || '', desc, goal, hint: hint || '',
    created_by: currentUser.uid,
    created_by_email: currentUser.email,
    created_at: new Date().toISOString(),
    active: true,
  });
  await loadCustomQuests();
  return newDocRef.id;
}

async function updateCustomQuest(docId, { icon, title, subtitle, desc, goal, hint }) {
  await setDoc(doc(db, 'quests', docId), {
    icon: icon || '🎯',
    title, subtitle: subtitle || '', desc, goal, hint: hint || '',
  }, { merge: true });
  await loadCustomQuests();
}

async function deleteCustomQuest(docId) {
  await deleteDoc(doc(db, 'quests', docId));
  await loadCustomQuests();
}

/* Renders quests the CURRENT user created (or ALL custom quests, if
   admin) with icon-only Edit/Delete buttons each. Reused for both the
   guru page and the admin page's embedded copy, same pattern as
   renderGuruDashboard. */
function renderMyQuests(containerId) {
  const list = document.getElementById(containerId);
  if (!list) return;
  const mine = customQuests.filter(q => q.created_by === currentUser.uid || currentUserRole === 'admin');
  list.innerHTML = mine.length ? '' : '<div class="canvas-empty-hint">Belum ada quest yang dibuat.</div>';
  mine.forEach(q => {
    const row = document.createElement('div');
    row.className = 'dash-row';
    const byOther = q.created_by !== currentUser.uid;
    row.innerHTML = `
      <div class="dash-row-top">
        <div>
          <div class="dash-row-email">${questIconHTML(q.icon)} ${q.title}</div>
          <div class="dash-row-sub">${q.subtitle || ''}${byOther ? ` · dibuat oleh ${q.created_by_email || 'guru lain'}` : ''}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="dash-icon-btn edit-quest-btn" title="Edit quest" aria-label="Edit quest">✏️</button>
          <button class="dash-icon-btn delete-quest-btn" title="Hapus quest" aria-label="Hapus quest">🗑️</button>
        </div>
      </div>
    `;
    row.querySelector('.edit-quest-btn').addEventListener('click', () => openQuestForm(q));
    row.querySelector('.delete-quest-btn').addEventListener('click', async () => {
      if (!confirm(`Hapus quest "${q.title}"? Progress siswa yang sudah ada tidak ikut terhapus.`)) return;
      try {
        await deleteCustomQuest(q.docId);
        showToast('🗑️ Quest dihapus');
        renderMyQuests(containerId);
        renderQuestGrid('quest-grid-home');
        renderQuestGrid('quest-grid-learn');
      } catch (err) {
        showToast(`Gagal hapus: ${err.message}`);
      }
    });
    list.appendChild(row);
  });
}

/* Pass an existing quest object to edit it in place; call with no
   argument (or omit it) to open the form blank for a brand-new quest. */
let editingQuestDocId = null;
function openQuestForm(existingQuest = null) {
  editingQuestDocId = existingQuest ? existingQuest.docId : null;
  document.getElementById('quest-form-heading').textContent =
    existingQuest ? '✏️ Edit Quest' : '🎯 Buat Quest Baru';
  document.getElementById('qf-submit').textContent = existingQuest ? 'Simpan Perubahan' : 'Simpan Quest';
  document.getElementById('qf-icon').value = existingQuest?.icon || 'target';
  renderQuestIconPicker(existingQuest?.icon || 'target');
  document.getElementById('qf-title').value = existingQuest?.title || '';
  document.getElementById('qf-subtitle').value = existingQuest?.subtitle || '';
  document.getElementById('qf-desc').value = existingQuest?.desc || '';
  document.getElementById('qf-goal').value = existingQuest?.goal || '';
  document.getElementById('qf-hint').value = existingQuest?.hint || '';
  document.getElementById('qf-hint-status').textContent = '';
  document.getElementById('qf-hint-status').className = 'qf-hint-status';
  document.getElementById('qf-error').textContent = '';
  document.getElementById('quest-form-modal').classList.remove('hidden');
}

function questProgressRef(questId) {
  // One doc per student per quest — id embeds the uid so the security
  // rule can check it without a field lookup (unlike `projects`, which
  // now needs a student_id field check since one student has many).
  return doc(db, 'quest_progress', `${currentUser.uid}_${questId}`);
}

async function loadAllQuestProgress() {
  questProgress = {};
  for (const q of allQuests()) {
    try {
      const snap = await getDoc(questProgressRef(q.id));
      if (snap.exists()) questProgress[q.id] = snap.data();
    } catch (err) {
      console.warn(`Load quest progress failed for "${q.id}":`, err.message);
    }
  }
}

/* customQuests must be loaded BEFORE loadAllQuestProgress(), since that
   iterates allQuests() (built-in + custom) — otherwise a student's
   progress on a teacher-made quest just wouldn't be looked up at all. */
async function loadStudentHomeData() {
  await loadCustomQuests();
  await Promise.all([loadMyProjects(), loadAllQuestProgress()]);
  renderQuestGrid('quest-grid-home');
  renderQuestGrid('quest-grid-learn');
}

async function saveQuestProgress(questId, score) {
  const prevBest = questProgress[questId]?.bestScore ?? 0;
  const record = {
    student_id: currentUser.uid,
    quest_id:   questId,
    completed:  score >= QUEST_PASS_SCORE || (questProgress[questId]?.completed ?? false),
    bestScore:  Math.max(prevBest, score),
    lastScore:  score,
    updatedAt:  new Date().toISOString(),
  };
  questProgress[questId] = record;
  try {
    await setDoc(questProgressRef(questId), record, { merge: true });
  } catch (err) {
    console.warn('Save quest progress failed:', err.message);
  }
  // Refresh wherever a quest grid is currently visible
  renderQuestGrid('quest-grid-home');
  renderQuestGrid('quest-grid-learn');
}

/* `containerId === 'quest-grid-home'` renders a compact preview: one
   tile per sensor track, showing whichever stage the student should
   tackle next. `quest-grid-learn` renders the full breakdown: every
   track with all 3 stages (locked ones shown but not clickable),
   plus any teacher-made custom quests underneath. */
function renderQuestGrid(containerId) {
  const grid = document.getElementById(containerId);
  if (!grid) return;
  grid.innerHTML = '';

  if (containerId === 'quest-grid-home') {
    grid.className = 'quest-grid';
    QUEST_TRACKS.forEach(track => {
      const flat = builtInQuestsFlat().filter(q => q.trackId === track.trackId);
      // "Next up" = first stage that isn't completed yet, or the last
      // (hard) stage if the whole track is already done.
      const next = flat.find(q => !questProgress[q.id]?.completed) || flat[flat.length - 1];
      const allDone = flat.every(q => questProgress[q.id]?.completed);
      const tile = document.createElement('div');
      tile.className = 'quest-tile';
      tile.innerHTML = `
        ${allDone ? '<span class="quest-tile-badge">✅ Selesai semua</span>' : ''}
        <div class="quest-tile-icon">${questIconHTML(track.icon)}</div>
        <div class="quest-tile-title">${track.title}</div>
        <div class="quest-tile-sub">${LEVEL_LABEL[next.level]} ${allDone ? '(ulangi Sulit)' : ''}</div>
        <div class="quest-tile-desc">${next.desc}</div>
      `;
      tile.addEventListener('click', () => {
        activateNavButton('learn');
        switchPage('learn');
      });
      grid.appendChild(tile);
    });
    return;
  }

  // Full view (quest-grid-learn): group by track.
  grid.className = '';
  QUEST_TRACKS.forEach(track => {
    const section = document.createElement('div');
    section.className = 'quest-track-section';
    section.innerHTML = `<div class="quest-track-header"><span>${questIconHTML(track.icon)}</span> ${track.title}</div>`;
    const row = document.createElement('div');
    row.className = 'quest-track-row';

    builtInQuestsFlat().filter(q => q.trackId === track.trackId).forEach(q => {
      const progress = questProgress[q.id];
      const unlocked = isStageUnlocked(q);
      const tile = document.createElement('div');
      tile.className = 'quest-tile quest-stage-tile' + (unlocked ? '' : ' locked');
      tile.innerHTML = `
        <span class="stage-level-badge level-${q.level}">${LEVEL_LABEL[q.level]}</span>
        ${progress?.completed ? '<span class="quest-tile-badge">✅ Selesai</span>' : ''}
        <div class="quest-tile-icon">${unlocked ? questIconHTML(q.icon) : questIconHTML('locked')}</div>
        <div class="quest-tile-title">${q.title}</div>
        <div class="quest-tile-desc">${unlocked ? q.desc : 'Selesaikan tingkat sebelumnya dulu untuk membuka ini.'}</div>
      `;
      if (unlocked) tile.addEventListener('click', () => startQuest(q));
      row.appendChild(tile);
    });
    section.appendChild(row);
    grid.appendChild(section);
  });

  // Teacher-made custom quests keep their old flat presentation.
  if (customQuests.length) {
    const customSection = document.createElement('div');
    customSection.className = 'quest-track-section';
    customSection.innerHTML = `<div class="quest-track-header"><span>👩‍🏫</span> Quest dari Guru</div>`;
    const customRow = document.createElement('div');
    customRow.className = 'quest-grid';
    customQuests.forEach(q => {
      const progress = questProgress[q.id];
      const tile = document.createElement('div');
      tile.className = 'quest-tile';
      tile.innerHTML = `
        ${progress?.completed ? '<span class="quest-tile-badge">✅ Selesai</span>' : '<span class="quest-tile-badge custom">👩‍🏫 Guru</span>'}
        <div class="quest-tile-icon">${questIconHTML(q.icon)}</div>
        <div class="quest-tile-title">${q.title}</div>
        <div class="quest-tile-sub">${q.subtitle || ''}</div>
        <div class="quest-tile-desc">${q.desc}</div>
      `;
      tile.addEventListener('click', () => startQuest(q));
      customRow.appendChild(tile);
    });
    customSection.appendChild(customRow);
    grid.appendChild(customSection);
  }
}

/* ── Guru dashboard — student list + quest progress. Assessment
   history is fetched on-demand per student (click "Lihat Riwayat"),
   not all upfront, to avoid N+1-ing the whole class on every visit. */
/* project_id on an assessment doc is either "<uid>_quest_<questId>" (a
   quest attempt) or plain "<uid>" (freeform "My Project" mode) — see
   the fetch('/api/assess') call. Turn that back into a label a guru
   can actually read, e.g. "Berhenti Sebelum Menabrak" instead of
   "abc123_quest_ultrasonic_easy". */
function projectIdToLabel(projectId, uid) {
  const prefix = `${uid}_quest_`;
  if (projectId === uid) return 'Proyek Bebas (My Project)';
  if (projectId.startsWith(prefix)) {
    const questId = projectId.slice(prefix.length);
    const quest = allQuests().find(q => q.id === questId);
    return quest ? `${quest.icon} ${quest.title}` : `Quest: ${questId}`;
  }
  return projectId;
}

/* Groups assessment history by program (see projectIdToLabel above),
   most-recently-attempted program first; entries inside each group stay
   in the newest-first order the backend already returns them in. */
function renderGroupedHistory(assessments, uid) {
  const groups = new Map(); // label -> items[], insertion order = first-seen order = most recent overall
  for (const a of assessments) {
    const label = projectIdToLabel(a.project_id, uid);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(a);
  }
  return [...groups.entries()].map(([label, items]) => `
    <div class="dash-history-group">
      <div class="dash-history-group-title">${label} · ${items.length}x</div>
      ${items.map(a => `<div class="dash-history-item"><b>${a.score}</b> (${a.grade}) — ${new Date(a.assessed_at).toLocaleString('id-ID')}</div>`).join('')}
    </div>
  `).join('');
}

async function renderGuruDashboard(containerId = 'guru-student-list') {
  const list = document.getElementById(containerId);
  if (!list) return;
  list.innerHTML = '<div class="canvas-empty-hint">Memuat data siswa…</div>';
  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/students', { headers });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Gagal memuat data siswa');
    const students = await res.json();

    if (!students.length) {
      list.innerHTML = '<div class="canvas-empty-hint">Belum ada siswa yang mendaftar.</div>';
      return;
    }

    list.innerHTML = '';
    students.forEach(s => {
      // Namespaced by containerId — this same renderer is reused inside
      // BOTH the Guru dashboard page AND the Admin page (which embeds a
      // copy of the same student list), and both sections exist in the
      // DOM at once (just one hidden via CSS). Without the prefix, two
      // elements would share id="history-<uid>", and getElementById()
      // would always resolve to whichever was rendered first.
      const historyId = `history-${containerId}-${s.uid}`;
      const row = document.createElement('div');
      row.className = 'dash-row';
      const doneCount = Object.values(s.quest_progress || {}).filter(p => p.completed).length;
      row.innerHTML = `
        <div class="dash-row-top">
          <div>
            <div class="dash-row-email">${s.email}</div>
            <div class="dash-row-sub">${doneCount}/${allQuests().length} quest selesai</div>
          </div>
          <button class="dash-btn" data-uid="${s.uid}">Lihat Riwayat AI</button>
        </div>
        <div class="quest-badge-row">
          ${allQuests().map(q => {
            const p = (s.quest_progress || {})[q.id];
            return `<span class="quest-mini-badge ${p?.completed ? 'done' : ''}">${questIconHTML(q.icon)} ${p?.completed ? `✓ ${p.bestScore}` : 'belum'}</span>`;
          }).join('')}
        </div>
        <div class="dash-history" id="${historyId}"></div>
      `;
      row.querySelector('.dash-btn').addEventListener('click', async e => {
        const historyEl = document.getElementById(historyId);
        const isOpen = historyEl.classList.contains('open');
        if (isOpen) { historyEl.classList.remove('open'); return; }
        historyEl.innerHTML = 'Memuat…';
        historyEl.classList.add('open');
        try {
          const h = await fetch(`/api/students/${s.uid}/assessments`, { headers: await getAuthHeader() });
          const assessments = await h.json();
          historyEl.innerHTML = assessments.length
            ? renderGroupedHistory(assessments, s.uid)
            : '<div class="dash-history-item">Belum ada riwayat penilaian AI.</div>';
        } catch (err) {
          historyEl.innerHTML = `<div class="dash-history-item">Gagal memuat: ${err.message}</div>`;
        }
      });
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = `<div class="canvas-empty-hint">Gagal memuat: ${err.message}</div>`;
  }
}

/* ── Admin dashboard — invite codes + all users with inline role change. */
async function renderAdminDashboard() {
  const inviteList = document.getElementById('admin-invite-list');
  const userList    = document.getElementById('admin-user-list');
  inviteList.innerHTML = '<div class="canvas-empty-hint">Memuat…</div>';
  userList.innerHTML   = '<div class="canvas-empty-hint">Memuat…</div>';

  renderGuruDashboard('admin-student-list'); // same student/quest/AI-history view guru sees
  renderMyQuests('my-quest-list-admin');

  const headers = await getAuthHeader();

  try {
    const res = await fetch('/api/auth/invite-codes', { headers });
    const codes = await res.json();
    inviteList.innerHTML = codes.length ? '' : '<div class="canvas-empty-hint">Belum ada kode dibuat.</div>';
    codes.forEach(c => {
      const row = document.createElement('div');
      row.className = 'dash-row';
      row.innerHTML = `
        <div class="dash-row-top">
          <div>
            <span class="invite-code-text">${c.code}</span>
            <button class="dash-btn copy-code-btn" type="button" title="Salin kode">📋 Salin</button>
            <button class="dash-btn delete-code-btn" type="button" title="Hapus kode">🗑️ Hapus</button>
            <span class="dash-row-sub">— role: ${c.role}${c.note ? ` · ${c.note}` : ''}</span>
          </div>
          <span class="quest-mini-badge ${c.used_by ? '' : 'done'}">${c.used_by ? '✓ Terpakai' : 'Belum dipakai'}</span>
        </div>
      `;
      row.querySelector('.copy-code-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(c.code);
          showToast(`📋 Kode ${c.code} disalin ke clipboard`);
        } catch (err) {
          showToast('Gagal menyalin — salin manual saja: ' + c.code);
        }
      });
      row.querySelector('.delete-code-btn').addEventListener('click', async () => {
        if (!confirm(`Hapus kode ${c.code}?`)) return;
        try {
          const r = await fetch(`/api/auth/invite-codes/${c.code}`, {
            method: 'DELETE',
            headers: await getAuthHeader(),
          });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Gagal menghapus');
          showToast(`🗑️ Kode ${c.code} dihapus`);
          renderAdminDashboard();
        } catch (err) {
          showToast(`Gagal hapus: ${err.message}`);
        }
      });
      inviteList.appendChild(row);
    });
  } catch (err) {
    inviteList.innerHTML = `<div class="canvas-empty-hint">Gagal memuat: ${err.message}</div>`;
  }

  try {
    const res = await fetch('/api/admin/users', { headers });
    const users = await res.json();
    userList.innerHTML = '';
    users.forEach(u => {
      const row = document.createElement('div');
      row.className = 'dash-row';
      row.innerHTML = `
        <div class="dash-row-top">
          <div class="dash-row-email">${u.email}</div>
          <select class="role-select" data-uid="${u.uid}">
            <option value="siswa" ${u.role === 'siswa' ? 'selected' : ''}>Siswa</option>
            <option value="guru"  ${u.role === 'guru'  ? 'selected' : ''}>Guru</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </div>
      `;
      row.querySelector('.role-select').addEventListener('change', async e => {
        const newRole = e.target.value;
        if (!confirm(`Ubah role ${u.email} menjadi "${newRole}"?`)) {
          e.target.value = u.role; // revert
          return;
        }
        try {
          const r = await fetch('/api/admin/set-role', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) },
            body: JSON.stringify({ uid: u.uid, role: newRole }),
          });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Gagal mengubah role');
          showToast(`✅ Role ${u.email} diubah jadi ${newRole}`);
          u.role = newRole;
        } catch (err) {
          showToast(`Gagal: ${err.message}`);
          e.target.value = u.role; // revert on failure
        }
      });
      userList.appendChild(row);
    });
  } catch (err) {
    userList.innerHTML = `<div class="canvas-empty-hint">Gagal memuat: ${err.message}</div>`;
  }
}

document.getElementById('admin-create-invite-btn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/auth/create-invite-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) },
      body: JSON.stringify({ role: 'guru' }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Gagal membuat kode');
    const data = await res.json();
    try {
      await navigator.clipboard.writeText(data.code);
      showToast(`✅ Kode ${data.code} dibuat & disalin ke clipboard`);
    } catch {
      showToast(`✅ Kode dibuat: ${data.code} (salin manual, clipboard tidak tersedia)`);
    }
    renderAdminDashboard();
  } catch (err) {
    showToast(`Gagal buat kode: ${err.message}`);
  }
});

document.getElementById('create-quest-btn-guru').addEventListener('click', () => openQuestForm());

document.getElementById('qf-cancel').addEventListener('click', () => {
  document.getElementById('quest-form-modal').classList.add('hidden');
});

/* Calls POST /api/generate-hint so the student-facing hint is written by
   the AI from the (student-invisible) grading instruction, instead of
   guru either typing it by hand or the app just reusing `goal` verbatim —
   which used to leak the raw AI grading prompt straight into the hint box. */
async function generateHintFromAI({ title, subtitle, desc, goal }) {
  const authHeader = await getAuthHeader();
  if (!authHeader) throw new Error('Silakan masuk terlebih dahulu.');
  const res = await fetch('/api/generate-hint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify({ title, subtitle, desc, goal }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.hint;
}

document.getElementById('qf-generate-hint').addEventListener('click', async () => {
  const title    = document.getElementById('qf-title').value.trim();
  const subtitle = document.getElementById('qf-subtitle').value.trim();
  const desc     = document.getElementById('qf-desc').value.trim();
  const goal     = document.getElementById('qf-goal').value.trim();
  const statusEl = document.getElementById('qf-hint-status');
  const genBtn   = document.getElementById('qf-generate-hint');

  if (!title || !desc || !goal) {
    statusEl.textContent = 'Isi judul, deskripsi, dan instruksi AI dulu sebelum generate hint.';
    statusEl.className = 'qf-hint-status error';
    return;
  }

  genBtn.disabled = true;
  statusEl.className = 'qf-hint-status';
  statusEl.textContent = '✨ Membuat hint…';
  try {
    const hint = await generateHintFromAI({ title, subtitle, desc, goal });
    document.getElementById('qf-hint').value = hint;
    statusEl.textContent = 'Hint dibuat. Boleh diedit lagi kalau perlu.';
  } catch (err) {
    statusEl.textContent = `Gagal generate hint: ${err.message}`;
    statusEl.className = 'qf-hint-status error';
  } finally {
    genBtn.disabled = false;
  }
});

document.getElementById('qf-submit').addEventListener('click', async () => {
  const title    = document.getElementById('qf-title').value.trim();
  const subtitle = document.getElementById('qf-subtitle').value.trim();
  const desc     = document.getElementById('qf-desc').value.trim();
  const goal     = document.getElementById('qf-goal').value.trim();
  const icon     = document.getElementById('qf-icon').value.trim();
  let   hint     = document.getElementById('qf-hint').value.trim();
  const errEl    = document.getElementById('qf-error');
  const statusEl = document.getElementById('qf-hint-status');
  errEl.textContent = '';

  if (!title || !desc || !goal) {
    errEl.textContent = 'Judul, deskripsi, dan instruksi AI wajib diisi.';
    return;
  }

  const submitBtn = document.getElementById('qf-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Menyimpan…';
  try {
    // Guru never typed/generated a hint — generate one automatically so
    // the quest never falls back to showing the raw AI instruction to
    // students. If generation fails, save anyway (display already falls
    // back to `goal`) rather than blocking the save on an AI hiccup.
    if (!hint) {
      statusEl.className = 'qf-hint-status';
      statusEl.textContent = '✨ Membuat hint otomatis…';
      try {
        hint = await generateHintFromAI({ title, subtitle, desc, goal });
        document.getElementById('qf-hint').value = hint;
        statusEl.textContent = '';
      } catch (err) {
        statusEl.textContent = `Hint otomatis gagal dibuat (${err.message}), quest tetap disimpan.`;
        statusEl.className = 'qf-hint-status error';
      }
    }

    if (editingQuestDocId) {
      await updateCustomQuest(editingQuestDocId, { icon, title, subtitle, desc, goal, hint });
      showToast('✅ Quest diperbarui');
    } else {
      await createCustomQuest({ icon, title, subtitle, desc, goal, hint });
      showToast('✅ Quest baru dibuat — langsung muncul di daftar siswa');
    }
    document.getElementById('quest-form-modal').classList.add('hidden');
    renderMyQuests('my-quest-list-guru');
    renderMyQuests('my-quest-list-admin');
  } catch (err) {
    errEl.textContent = `Gagal menyimpan: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = editingQuestDocId ? 'Simpan Perubahan' : 'Simpan Quest';
  }
});

/* ── Navigation — the bottombar (Home / Learn / Code / Quest) already
   existed as a placeholder in the original markup; this wires it up
   for real instead of adding a separate navigation mechanism.
   Learn  = sensor documentation page (click a block, see its detail
            panel) — no canvas/state of its own, purely informational.
   Code   = the full project editor (`programBlocks`, saved to Firestore)
   Dashboard = resolves to 'guru' or 'admin' page depending on role —
   the nav button itself is only visible for non-'siswa' roles anyway
   (see updateRoleUI), so a student can never even click into this.  */
const NAV_TO_PAGE = { home: 'home', build: 'build', code: 'code', learn: 'learn', dashboard: 'dashboard' };
const ALL_PAGES = ['page-home', 'page-build', 'main', 'page-learn', 'page-guru', 'page-admin'];

function switchPage(pageName) {
  // 'dashboard' isn't a real page id — resolve it to whichever dashboard
  // fits the CURRENT role, decided at navigation time (not cached), so it
  // stays correct even if role changed since the page loaded.
  const resolvedPage = pageName === 'dashboard'
    ? (currentUserRole === 'admin' ? 'admin' : 'guru')
    : pageName;

  const pageToElId = { home: 'page-home', build: 'page-build', code: 'main', learn: 'page-learn', guru: 'page-guru', admin: 'page-admin' };
  ALL_PAGES.forEach(elId => {
    document.getElementById(elId).classList.toggle('hidden', pageToElId[resolvedPage] !== elId);
  });
  // Lets CSS target "only while X page is active" without needing a DOM
  // relationship — used by the landscape media query to show Run/AI in
  // the topbar ONLY on the Code page (previously that override applied
  // unconditionally in landscape, so Run/AI kept showing on Learn/Home/
  // etc too, ignoring the codeOnly display logic just below).
  document.body.dataset.page = resolvedPage;

  // Home/Learn(sensor docs)/Quest/dashboards only need the logo — BLE/Run/AI
  // are editor-only (Code page). 'build' added here on request — this page
  // is just sensor documentation/testing, not something that sends to the
  // robot, so there's no actual use for a BLE connect button here either.
  document.getElementById('topbar').classList.toggle('topbar-minimal', ['home', 'build', 'learn', 'guru', 'admin'].includes(resolvedPage));
  // Code page only: Run / AI Assessment controls.
  const codeOnly = ['run-btn', 'ai-toggle-btn'];
  codeOnly.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (resolvedPage === 'code') ? '' : 'none';
  });
  if (resolvedPage === 'build') { renderBuildPalette(); }
  if (resolvedPage === 'home')  renderQuestGrid('quest-grid-home');
  if (resolvedPage === 'learn') renderQuestGrid('quest-grid-learn');
  if (resolvedPage === 'guru')  { renderGuruDashboard(); renderMyQuests('my-quest-list-guru'); }
  if (resolvedPage === 'admin') renderAdminDashboard();
}

function activateNavButton(navId) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === navId));
  document.querySelectorAll('.mobile-nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === navId));
}

/* ── First-run tour (spotlight overlay) ───────────────────────
   Walks through the main features with a dark cutout highlighting
   one element at a time + a tooltip explaining it. Runs automatically
   once per browser after first login (see the onAuthStateChanged
   trigger below), and is replayable anytime via the "?" button in
   the topbar (desktop) or "Panduan" in the mobile drawer.

   Steps can specify `page` — the tour switches pages for you between
   steps (e.g. Home -> Code) using the same switchPage()/
   activateNavButton() everything else uses, so it's never a special
   case. `targetMobile` is an alternate selector tried when the
   desktop one isn't currently visible (e.g. #run-btn is hidden on
   phones in favor of the floating #mobile-run-btn) — steps whose
   target STILL can't be found (element genuinely not on screen, e.g.
   the BLE button on a very cramped layout) are skipped automatically
   rather than showing a spotlight pointing at nothing. */
/* Called once after a student lands on Home post-login. Delay lets the
   home page's data (project list, quest grid) finish rendering first,
   so the spotlight's targets exist with their real final layout. */
function maybeStartFirstRunTour() {
  let alreadySeen = true;
  try { alreadySeen = !!localStorage.getItem(TOUR_STORAGE_KEY); } catch (err) { /* private browsing — just don't auto-start */ }
  if (!alreadySeen) setTimeout(startTour, 700);
}

const TOUR_STORAGE_KEY = 'robolearn_tour_seen_v1';

const TOUR_STEPS = [
  { page: 'home', target: '#card-project', title: 'Proyek Kamu', text: 'Semua program yang sudah kamu simpan muncul di sini. Klik "Buka" untuk lanjut kerjain, atau buat proyek baru.' },
  { page: 'home', target: '#card-quest', title: 'Quest', text: 'Tantangan kecil untuk kenalan sama tiap sensor robot — hasilnya langsung dinilai AI.' },
  { page: 'code', target: '#category-sidebar', title: 'Kategori Blok', text: 'Bulatan warna-warni ini adalah kategori blok — Motion, Looks, Sound, Events, Control, Sensors, Operators, Variables. Klik salah satu untuk lihat isinya di daftar blok sebelah kanan.' },
  { page: 'code', target: '#palette', title: 'Daftar Blok', text: 'Ambil blok dari sini (drag di desktop, tekan-tahan lalu geser di HP) untuk menyusun program di canvas sebelah kanan.' },
  { page: 'code', target: '#canvas-wrap', title: 'Canvas', text: 'Susun blok-blok jadi program lengkap di sini. Blok yang menyambung akan berjalan berurutan dari atas ke bawah.' },
  { page: 'code', target: '#run-btn', targetMobile: '#mobile-run-btn', title: 'Run', text: 'Tekan ini untuk menjalankan program — ke robot asli kalau sudah terhubung, atau simulasi kalau belum.' },
  { page: 'code', target: '#ai-toggle-btn', targetMobile: '#mobile-ai-btn', title: 'Penilaian AI', text: 'Minta AI menilai program kamu dan kasih saran perbaikan, kapan saja.' },
  { page: 'code', target: '#ble-btn', title: 'Sambungkan Robot', text: 'Tekan ini untuk menyambungkan ke robot ESP32 kamu lewat Bluetooth.' },
];

let tourIndex = 0;
let tourCurrentPage = null;

function tourElementVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function tourResolveTarget(step) {
  let el = document.querySelector(step.target);
  if (tourElementVisible(el)) return el;
  if (step.targetMobile) {
    el = document.querySelector(step.targetMobile);
    if (tourElementVisible(el)) return el;
  }
  return null;
}

function positionTourUI(el) {
  const rect = el.getBoundingClientRect();
  const pad = 6;
  const spotlight = document.getElementById('tour-spotlight');
  spotlight.style.top = `${rect.top - pad}px`;
  spotlight.style.left = `${rect.left - pad}px`;
  spotlight.style.width = `${rect.width + pad * 2}px`;
  spotlight.style.height = `${rect.height + pad * 2}px`;

  const tooltip = document.getElementById('tour-tooltip');
  tooltip.style.visibility = 'hidden';
  // Measure AFTER the title/text are set (caller does that first) but
  // before final placement, so width/height reflect the real content.
  requestAnimationFrame(() => {
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let top = rect.bottom + 14;
    if (top + th > window.innerHeight - 12) top = Math.max(rect.top - th - 14, 12);
    let left = Math.min(Math.max(rect.left, 12), window.innerWidth - tw - 12);
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.visibility = 'visible';
  });
}

function renderTourStep() {
  if (tourIndex < 0) tourIndex = 0;
  if (tourIndex >= TOUR_STEPS.length) { endTour(); return; }
  const step = TOUR_STEPS[tourIndex];

  function proceed() {
    const el = tourResolveTarget(step);
    if (!el) {
      // Target isn't on screen right now (hidden by role/layout) —
      // skip straight to the next step instead of pointing at nothing.
      tourIndex++;
      renderTourStep();
      return;
    }
    document.getElementById('tour-tooltip-title').textContent = step.title;
    document.getElementById('tour-tooltip-text').textContent = step.text;
    document.getElementById('tour-step-counter').textContent = `${tourIndex + 1} / ${TOUR_STEPS.length}`;
    document.getElementById('tour-prev-btn').classList.toggle('hidden', tourIndex === 0);
    document.getElementById('tour-next-btn').textContent = tourIndex === TOUR_STEPS.length - 1 ? 'Selesai' : 'Lanjut';
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    positionTourUI(el);
  }

  if (step.page && step.page !== tourCurrentPage) {
    tourCurrentPage = step.page;
    activateNavButton(step.page);
    switchPage(step.page);
    // Give switchPage's .hidden-class toggling and any layout/transition
    // a moment to settle before measuring positions.
    setTimeout(proceed, 220);
  } else {
    proceed();
  }
}

function startTour() {
  tourIndex = 0;
  tourCurrentPage = null;
  document.getElementById('tour-overlay').classList.remove('hidden');
  renderTourStep();
}

function endTour() {
  document.getElementById('tour-overlay').classList.add('hidden');
  try { localStorage.setItem(TOUR_STORAGE_KEY, '1'); } catch (err) { /* private browsing etc — fine, tour just replays next time */ }
}

document.getElementById('tour-next-btn').addEventListener('click', () => { tourIndex++; renderTourStep(); });
document.getElementById('tour-prev-btn').addEventListener('click', () => { tourIndex--; renderTourStep(); });
document.getElementById('tour-skip-btn').addEventListener('click', endTour);
document.getElementById('tour-restart-btn').addEventListener('click', startTour);
document.getElementById('mobile-tour-btn').addEventListener('click', () => {
  mobileNavOverlay.classList.remove('show');
  startTour();
});
window.addEventListener('resize', () => {
  if (!document.getElementById('tour-overlay').classList.contains('hidden')) renderTourStep();
});

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activateNavButton(btn.dataset.nav);
    switchPage(NAV_TO_PAGE[btn.dataset.nav] || 'home');
  });
});

/* ── Mobile nav drawer (hamburger) ───────────────────────────── */
const mobileNavOverlay = document.getElementById('mobile-nav-overlay');
document.getElementById('hamburger-btn').addEventListener('click', () => {
  mobileNavOverlay.classList.add('show');
});
document.getElementById('mobile-nav-close').addEventListener('click', () => {
  mobileNavOverlay.classList.remove('show');
});
mobileNavOverlay.addEventListener('click', e => {
  if (e.target === mobileNavOverlay) mobileNavOverlay.classList.remove('show'); // tap backdrop to close
});
document.querySelectorAll('.mobile-nav-item').forEach(item => {
  item.addEventListener('click', () => {
    activateNavButton(item.dataset.nav);
    switchPage(NAV_TO_PAGE[item.dataset.nav] || 'home');
    mobileNavOverlay.classList.remove('show');
  });
});

/* ── Quest banner: auto-dismiss ────────────────────────────────
   Shows the banner, then fades it out ~1s later (a quick "here's your
   quest" flash rather than something that sits on the canvas). The
   timer id is tracked so calling this again (or hiding manually)
   cancels any fade still in flight instead of stacking timeouts. */
let questBannerTimer = null;
function hideQuestBanner() {
  clearTimeout(questBannerTimer);
  questBannerTimer = null;
  const banner = document.getElementById('quest-banner');
  banner.classList.remove('fade-out');
  banner.classList.add('hidden');
}
function showQuestBanner(text) {
  clearTimeout(questBannerTimer);
  const banner = document.getElementById('quest-banner');
  document.getElementById('quest-banner-text').textContent = text;
  banner.classList.remove('fade-out');
  banner.classList.remove('hidden');
  questBannerTimer = setTimeout(() => {
    banner.classList.add('fade-out');
    // Wait for the CSS fade (.35s) to finish before fully hiding it,
    // so it disappears smoothly instead of popping out instantly.
    questBannerTimer = setTimeout(hideQuestBanner, 350);
  }, 1000);
}

function newProject() {
  currentQuestId = null;
  currentQuestObj = null;
  currentAssignmentGoal = DEFAULT_ASSIGNMENT_GOAL;
  hideQuestBanner();
  updateQuestTabVisibility();
  currentProjectId = null; // next Save creates a NEW doc, doesn't overwrite another project
  programBlocks = seedBlocks([{ type: 'event_flag', params: {} }]);
  document.getElementById('prog-name').value = 'My Program';
  historyStack = [];
  redoStack = [];
  renderCanvas();
  renderProjectList(); // clear any "(sedang dibuka)" tag
  activateNavButton('code');
  switchPage('code');
  showToast('🆕 Proyek baru dimulai — Save akan menyimpannya sebagai proyek terpisah');
}

function startQuest(quest) {
  currentQuestId = quest.id;
  currentQuestObj = quest;
  currentAssignmentGoal = quest.goal;
  programBlocks = seedBlocks([{ type: 'event_flag', params: {} }]);
  document.getElementById('prog-name').value = `Quest: ${quest.title}`;
  historyStack = [];
  redoStack = [];
  renderCanvas();
  updateQuestTabVisibility();
  showQuestBanner(`${quest.icon} ${quest.title} — ${quest.desc}`);
  activateNavButton('code');
  switchPage('code');
}

/* ── Auth: login / signup form ────────────────────────────────
   Gate the whole app behind #auth-overlay until Firebase confirms
   a signed-in user. onAuthStateChanged also fires on page load
   using the cached session, so returning users skip the form
   entirely (and this works offline once they've logged in once). */
const authOverlay = document.getElementById('auth-overlay');
const authForm    = document.getElementById('auth-form');
const authEmail   = document.getElementById('auth-email');
const authPass    = document.getElementById('auth-password');
const authSubmit  = document.getElementById('auth-submit');
const authError   = document.getElementById('auth-error');
let authMode = 'login'; // 'login' | 'signup'

document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    authMode = tab.dataset.authtab;
    authSubmit.textContent = authMode === 'signup' ? 'Daftar' : 'Masuk';
    authError.textContent = '';
    authError.classList.remove('success');
    document.getElementById('invite-code-wrap').classList.toggle('hidden', authMode !== 'signup');
  });
});

const authIsTeacher  = document.getElementById('auth-is-teacher');
const authInviteCode = document.getElementById('auth-invite-code');
authIsTeacher.addEventListener('change', () => {
  authInviteCode.classList.toggle('hidden', !authIsTeacher.checked);
  if (!authIsTeacher.checked) authInviteCode.value = '';
});

/* Translate common Firebase Auth error codes into friendly Indonesian text */
function friendlyAuthError(err) {
  const map = {
    'auth/invalid-email':          'Format email tidak valid.',
    'auth/missing-password':       'Password wajib diisi.',
    'auth/weak-password':          'Password minimal 6 karakter.',
    'auth/email-already-in-use':   'Email ini sudah terdaftar. Coba menu Masuk.',
    'auth/invalid-credential':     'Email atau password salah.',
    'auth/wrong-password':         'Email atau password salah.',
    'auth/user-not-found':         'Akun belum terdaftar. Coba menu Daftar.',
    'auth/too-many-requests':      'Terlalu banyak percobaan. Coba lagi sebentar lagi.',
    'auth/network-request-failed': 'Tidak ada koneksi internet. Login pertama kali wajib online.',
  };
  return map[err.code] || `Terjadi kesalahan (${err.code || err.message}).`;
}

authForm.addEventListener('submit', async e => {
  e.preventDefault();
  authError.textContent = '';
  authError.classList.remove('success');
  authSubmit.disabled = true;
  authSubmit.textContent = authMode === 'signup' ? 'Mendaftarkan…' : 'Masuk…';

  try {
    if (authMode === 'signup') {
      await createUserWithEmailAndPassword(auth, authEmail.value.trim(), authPass.value);
      // Every new account needs an explicit role — 'siswa' by default, or
      // whatever the invite code grants. This MUST go through the backend
      // (Admin SDK) because custom claims can't be set from the client.
      const inviteCode = (authIsTeacher.checked ? authInviteCode.value.trim() : '') || null;
      try {
        const idToken = await auth.currentUser.getIdToken();
        const res = await fetch('/api/auth/register-with-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
          body: JSON.stringify({ invite_code: inviteCode }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.detail || 'Gagal memproses kode undangan');
        }
        // Custom claims only show up in the ID token after a forced refresh —
        // the token issued at signup was minted BEFORE the backend set the role.
        // IMPORTANT: onAuthStateChanged does NOT re-fire just because we forced
        // a token refresh (it only fires on actual sign-in/out), so the role
        // badge must be updated explicitly here, not left to that listener.
        await auth.currentUser.getIdToken(true);
        const freshClaims = await getIdTokenResult(auth.currentUser, true);
        currentUserRole = freshClaims.claims.role || 'siswa';
        updateRoleUI();
      } catch (roleErr) {
        // Account exists either way (Firebase Auth signup already succeeded)
        // — but WITHOUT this step, the student has no role claim and no
        // Firestore `users/{uid}` profile, so they silently vanish from
        // every admin/guru list even though they can still log in. That's
        // a real bug we hit: this used to only warn when an invite code
        // was involved, so a *plain student* signup failing here left no
        // trace for the user to notice. Always surface it now.
        authError.textContent = inviteCode
          ? `Akun dibuat, tapi: ${roleErr.message}. Hubungi admin untuk kode undangan yang valid.`
          : `Akun dibuat, tapi ada masalah menyiapkan profilnya (${roleErr.message}). Coba logout lalu login lagi — sistem akan otomatis mencoba memperbaikinya.`;
        console.warn('register-with-code failed:', roleErr.message);
      }
    } else {
      await signInWithEmailAndPassword(auth, authEmail.value.trim(), authPass.value);
    }
    authForm.reset();
    document.getElementById('invite-code-wrap').classList.add('hidden');
    authInviteCode.classList.add('hidden');
    // onAuthStateChanged handles hiding the overlay once this resolves.
  } catch (err) {
    authError.textContent = friendlyAuthError(err);
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = authMode === 'signup' ? 'Daftar' : 'Masuk';
  }
});

document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));
document.getElementById('mobile-logout-btn').addEventListener('click', () => {
  mobileNavOverlay.classList.remove('show');
  signOut(auth);
});
// Mobile floating Run: just forwards to the real button's own handler,
// so there's exactly one place that logic lives.
document.getElementById('mobile-run-btn').addEventListener('click', () => {
  document.getElementById('run-btn').click();
});

/* Show/hide password toggle */
const authTogglePw = document.getElementById('auth-toggle-pw');
authTogglePw.addEventListener('click', () => {
  const showing = authPass.type === 'text';
  authPass.type = showing ? 'password' : 'text';
  authTogglePw.innerHTML = showing
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-6.06M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a21.86 21.86 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  authTogglePw.setAttribute('aria-label', showing ? 'Tampilkan password' : 'Sembunyikan password');
  authTogglePw.title = showing ? 'Tampilkan password' : 'Sembunyikan password';
});

/* Forgot password — sends a Firebase reset-link email. Needs the email
   field filled in (password field is irrelevant here, deliberately not
   validated) and, like the very first login, needs to be online once. */
document.getElementById('auth-forgot-btn').addEventListener('click', async () => {
  const email = authEmail.value.trim();
  authError.classList.remove('success');
  if (!email) {
    authError.textContent = 'Isi email dulu, baru klik "Lupa password?".';
    authEmail.focus();
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    authError.classList.add('success');
    authError.textContent = `Link reset password sudah dikirim ke ${email}. Cek inbox/folder spam.`;
  } catch (err) {
    authError.classList.remove('success');
    // Firebase deliberately doesn't distinguish "no such user" here for
    // privacy reasons in newer SDK versions, but map it just in case.
    authError.textContent = friendlyAuthError(err);
  }
});

function updateRoleUI() {
  const badge = document.getElementById('role-badge');
  const roleLabels = { siswa: 'Siswa', guru: 'Guru', admin: 'Admin' };
  badge.textContent = roleLabels[currentUserRole] || 'Siswa';
  badge.className = `role-badge role-${currentUserRole}`;
  const mobileBadge = document.getElementById('mobile-role-badge');
  mobileBadge.textContent = badge.textContent;
  mobileBadge.className = badge.className;

  document.getElementById('dashboard-nav-btn').classList.toggle('hidden', currentUserRole === 'siswa');
  document.getElementById('mobile-dashboard-item').classList.toggle('hidden', currentUserRole === 'siswa');
  // Admin has no use for Home/Build/Code/Learn (those are for building a
  // robot project, which isn't an admin task) — no bottom nav at all for
  // them, just their one combined page.
  document.getElementById('bottombar').classList.toggle('hidden', currentUserRole === 'admin');
  document.getElementById('app').classList.toggle('no-bottombar', currentUserRole === 'admin');
  // IMPORTANT: the hamburger itself stays available even for admin — on
  // mobile it's now the ONLY way to reach Logout (the topbar's own
  // logout button is hidden at that width to save space, moved into the
  // drawer as #mobile-logout-btn instead).
}

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    authOverlay.classList.add('hidden');
    document.getElementById('user-email').textContent = user.email || 'Guest';
    document.getElementById('mobile-user-email').textContent = user.email || 'Guest';
    document.getElementById('home-user-name').textContent = (user.email || 'Siswa').split('@')[0];
    document.getElementById('app').classList.remove('hidden');

    // Role must be known BEFORE deciding where to land — an admin never
    // needs Home/Build/Code/Learn (those are for building a robot
    // project), so we route straight to their combined page instead of
    // flashing Home first and then redirecting.
    getIdTokenResult(user).then(res => {
      // Distinguish "genuinely never got a role claim" (undefined — the
      // register-with-code call during signup must have failed, e.g. a
      // network hiccup) from "explicitly assigned siswa". The former is
      // a broken account: no role claim AND no Firestore `users/{uid}`
      // profile, so it's invisible to every admin/guru list even though
      // login itself still works. Self-heal it here rather than leaving
      // the student silently stuck — this is exactly the bug that made
      // a signed-up account not show up in the admin user list.
      const claimWasNeverSet = res.claims.role === undefined;
      currentUserRole = res.claims.role || 'siswa';
      updateRoleUI();

      if (claimWasNeverSet) {
        console.warn('No role claim found for this account — self-healing via register-with-code.');
        user.getIdToken().then(idToken =>
          fetch('/api/auth/register-with-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({ invite_code: null }),
          })
        ).then(() => user.getIdToken(true))
         .then(() => showToast('✅ Profil akun sudah diperbaiki otomatis'))
         .catch(err => console.warn('Self-heal register-with-code failed:', err.message));
      }

      if (currentUserRole === 'admin') {
        activateNavButton('dashboard');
        switchPage('dashboard');
      } else {
        loadStudentHomeData();
        activateNavButton('home');
        switchPage('home');
        maybeStartFirstRunTour();
      }
    }).catch(err => {
      console.warn('Failed to read role claim:', err.message);
      // Role lookup failed — fall back to the normal student flow rather
      // than leaving the app stuck with nothing rendered.
      loadStudentHomeData();
      activateNavButton('home');
      switchPage('home');
      maybeStartFirstRunTour();
    });
  } else {
    authOverlay.classList.remove('hidden');
    document.getElementById('user-email').textContent = '—';
    document.getElementById('app').classList.add('hidden');
    currentUserRole = 'siswa';
  }
});

document.getElementById('new-project-btn').addEventListener('click', () => {
  if (confirm('Buat proyek baru? Ini akan disimpan sebagai proyek terpisah begitu kamu tekan Save, proyek-proyek lain tetap aman.')) {
    newProject();
  }
});

/* Get an Authorization header for backend calls, or null if signed out. */
async function getAuthHeader() {
  if (!currentUser) return null;
  const token = await currentUser.getIdToken();
  return { 'Authorization': `Bearer ${token}` };
}

/* ── Online / offline indicator ───────────────────────────────
   Firestore's own persistence keeps working regardless, this is
   just a visual cue so students know why AI Assess might fail.   */
const userBadge = document.getElementById('user-badge');
const mobileNavUser = document.querySelector('.mobile-nav-user');
function updateConnBadge() {
  const title = navigator.onLine
    ? 'Online — semua fitur aktif'
    : 'Offline — canvas & save tetap jalan, Penilaian AI butuh koneksi';
  userBadge.classList.toggle('online', navigator.onLine);
  userBadge.title = title;
  mobileNavUser.classList.toggle('online', navigator.onLine);
  mobileNavUser.title = title;
}
window.addEventListener('online',  updateConnBadge);
window.addEventListener('offline', updateConnBadge);
updateConnBadge();

/* ── BLE state ──────────────────────────────────────────────── */
let robot = null;
let bleConnected = false;

/* ── Block palette data ─────────────────────────────────────── */
const PALETTE_DATA = {
  motion: [
    { label: 'move forward at [50]% speed',  color: 'var(--cat-motion)',  type: 'move_forward',  params: {speed:50} },
    { label: 'move backward at [50]% speed', color: 'var(--cat-motion)',  type: 'move_backward', params: {speed:50} },
    { label: 'turn right for [90] degrees',  color: 'var(--cat-motion)',  type: 'turn_right',    params: {degrees:90} },
    { label: 'turn left for [90] degrees',   color: 'var(--cat-motion)',  type: 'turn_left',     params: {degrees:90} },
    { label: 'stop all',                     color: 'var(--cat-motion)',  type: 'stop',          params: {} },
    { label: 'buka gripper',                 color: 'var(--cat-motion)',  type: 'gripper_open',  params: {} },
    { label: 'tutup gripper',                color: 'var(--cat-motion)',  type: 'gripper_close', params: {} },
    { label: 'ikuti garis selama [3] detik',  color: 'var(--cat-motion)',  type: 'follow_line',   params: {seconds:3} },
  ],
  looks: [
    { label: 'set LED all to [green]',  color: 'var(--cat-looks)', type: 'set_led', params: {color:'green'} },
    { label: 'set LED all to [red]',    color: 'var(--cat-looks)', type: 'set_led', params: {color:'red'} },
    { label: 'set LED all to [blue]',   color: 'var(--cat-looks)', type: 'set_led', params: {color:'blue'} },
    { label: 'set LED all to [off]',    color: 'var(--cat-looks)', type: 'set_led', params: {color:'off'} },
  ],
  sound: [
    { label: 'play note [C4] for [500]ms', color: 'var(--cat-sound)', type: 'play_sound', params: {note:'C4',duration:500} },
    { label: 'play note [A4] for [500]ms', color: 'var(--cat-sound)', type: 'play_sound', params: {note:'A4',duration:500} },
  ],
  events: [
    { label: 'when green flag clicked', color: 'var(--cat-events)', type: 'event_flag', params: {} },
  ],
  control: [
    { label: 'repeat [4] times',    color: 'var(--cat-control)', type: 'repeat', params: {times:4} },
    { label: 'wait [1] seconds',    color: 'var(--cat-control)', type: 'wait',   params: {seconds:1} },
    { label: 'if distance < [20] cm', color: 'var(--cat-control)', type: 'if',      params: {threshold:20} },
    { label: 'if garis terdeteksi',   color: 'var(--cat-control)', type: 'if_line', params: {} },
    { label: 'else',                  color: '#c2410c',            type: 'else',   params: {} },
    { label: 'forever',               color: 'var(--cat-control)', type: 'forever',params: {} },
  ],
  sensors: [
    { label: 'read ultrasonic',     color: 'var(--cat-sensors)', type: 'sensor_ping',     params: {} },
    { label: 'baca sensor garis',   color: 'var(--cat-sensors)', type: 'sensor_line',     params: {} },
  ],
  operators: [
    { label: '[ ] + [ ]', color: 'var(--cat-operators)', type: 'op_add', params: {} },
    { label: '[ ] - [ ]', color: 'var(--cat-operators)', type: 'op_sub', params: {} },
    { label: '[ ] × [ ]', color: 'var(--cat-operators)', type: 'op_mul', params: {} },
    { label: '[ ] ÷ [ ]', color: 'var(--cat-operators)', type: 'op_div', params: {} },
    { label: '[ ] = [ ]', color: 'var(--cat-operators)', type: 'op_eq',  params: {} },
    { label: '[ ] ≠ [ ]', color: 'var(--cat-operators)', type: 'op_neq', params: {} },
    { label: '[ ] > [ ]', color: 'var(--cat-operators)', type: 'op_gt',  params: {} },
    { label: '[ ] < [ ]', color: 'var(--cat-operators)', type: 'op_lt',  params: {} },
    { label: '[ ] ≥ [ ]', color: 'var(--cat-operators)', type: 'op_gte', params: {} },
    { label: '[ ] ≤ [ ]', color: 'var(--cat-operators)', type: 'op_lte', params: {} },
    { label: '[ ] and [ ]', color: 'var(--cat-operators)', type: 'op_and', params: {} },
    { label: '[ ] or [ ]',  color: 'var(--cat-operators)', type: 'op_or',  params: {} },
    { label: 'not [ ]',     color: 'var(--cat-operators)', type: 'op_not', params: {} },
  ],
  variables: [
    { label: 'set [speed] to [50]', color: 'var(--cat-variables)', type: 'var_set', params: {name:'speed',value:50} },
    { label: 'change [speed] by 10',color: 'var(--cat-variables)', type: 'var_change', params: {name:'speed',delta:10} },
  ],
};

/* ── PALETTE_INDEX: flat lookup by block type → {label, color} ─
   Reused for rendering (shape/colour/label template) regardless
   of which palette category or preset the block came from.        */
const PALETTE_INDEX = {};
Object.values(PALETTE_DATA).forEach(list =>
  list.forEach(b => { if (!PALETTE_INDEX[b.type]) PALETTE_INDEX[b.type] = b; })
);

/* Visual "shape" per block type (hat / mid / end / c-block) */
const BLOCK_SHAPES = {
  event_flag: 'hat',
  stop:       'end',
  repeat:     'c',
  if:         'c',
  if_line:    'c',
  else:       'c',
  forever:    'c',
};
function shapeOf(type) { return BLOCK_SHAPES[type] || 'mid'; }

/* ── Live program state ───────────────────────────────────────
   This IS the program — the canvas is always rendered FROM this
   tree, and every user action (drag/drop, delete, edit) mutates
   it and re-renders. No more static demo markup.                 */
let idCounter = 0;
function genId() { return 'blk_' + (++idCounter) + '_' + Math.random().toString(36).slice(2, 7); }

function seedBlocks(list) {
  list.forEach(b => {
    b.id = b.id || genId();
    b.children = b.children || [];   // backend Block model expects children: list, always
    if (b.children.length) seedBlocks(b.children);
  });
  return list;
}

let programBlocks = seedBlocks([
  { type: 'event_flag',   params: {} },
  { type: 'move_forward', params: { speed: 50 } },
  { type: 'repeat',       params: { times: 4 }, children: seedBlocks([
    { type: 'turn_right',   params: { degrees: 90 } },
    { type: 'move_forward', params: { speed: 50 } },
    { type: 'wait',         params: { seconds: 1 } },
    { type: 'set_led',      params: { color: 'green' } },
  ])},
  { type: 'set_led', params: { color: 'red' } },
  { type: 'stop',    params: {} },
]);

/* ── Undo / redo history (structural edits only) ─────────────── */
let historyStack = [];
let redoStack    = [];

function cloneProgram(list = programBlocks) {
  return JSON.parse(JSON.stringify(list));
}
function pushHistory() {
  historyStack.push(cloneProgram());
  redoStack = [];
  if (historyStack.length > 50) historyStack.shift();
}

/* ── Flatten blocks for command compilation ─────────────────── */
function flattenBlocks(blocks) {
  const flat = [];
  for (const b of blocks) {
    flat.push(b);
    if (b.children?.length) flat.push(...flattenBlocks(b.children));
  }
  return flat;
}

/* ── Tree helpers (find / remove / self-drop guard) ──────────── */
function findBlockById(id, list) {
  for (const b of list) {
    if (b.id === id) return b;
    if (b.children?.length) {
      const found = findBlockById(id, b.children);
      if (found) return found;
    }
  }
  return null;
}
function removeBlockById(id, list) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list.splice(i, 1)[0];
    if (list[i].children?.length) {
      const removed = removeBlockById(id, list[i].children);
      if (removed) return removed;
    }
  }
  return null;
}
function collectDescendantArrays(block, acc = []) {
  if (block.children) {
    acc.push(block.children);
    block.children.forEach(c => collectDescendantArrays(c, acc));
  }
  return acc;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ── UI helpers ─────────────────────────────────────────────── */
function showToast(msg, duration = 2400) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

/* ── Palette rendering ──────────────────────────────────────── */
function renderPalette(cat) {
  const list  = document.getElementById('palette-list');
  const title = document.getElementById('palette-title');
  title.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
  list.innerHTML = '';
  (PALETTE_DATA[cat] || []).forEach(block => {
    const el = document.createElement('button');
    el.className = 'palette-block';
    el.style.background = block.color;
    el.draggable = !IS_TOUCH_DEVICE;
    el.innerHTML = `<div class="notch"></div>${block.label}`;
    el.dataset.blockType = block.type;
    el.dataset.blockParams = JSON.stringify(block.params);
    el.addEventListener('dragstart', () => {
      dragPayload = { source: 'palette', type: block.type, params: block.params };
    });
    attachTouchDrag(el, () => ({ source: 'palette', type: block.type, params: block.params }));
    list.appendChild(el);
  });
}
renderPalette('motion');

/* Build page's palette — NOT the same categories as Code (no Motion/
   Looks/Sound/Control/etc). Instead, one group per physical hardware
   module, each with just the block(s) needed to test that module.
   This is a testing ground for the sensors/actuators themselves, not
   a general-purpose program editor. */
const BUILD_MODULES = [
  { title: 'ULTRASONIK', info: 'ultrasonik', blocks: [
    { label: 'read ultrasonic', color: 'var(--cat-sensors)', type: 'sensor_ping', params: {} },
  ]},
  { title: 'GRIPPER / ARM', info: 'gripper', blocks: [
    { label: 'buka gripper',  color: 'var(--cat-motion)', type: 'gripper_open',  params: {} },
    { label: 'tutup gripper', color: 'var(--cat-motion)', type: 'gripper_close', params: {} },
  ]},
  { title: 'LED + BUZZER', info: 'led_buzzer', blocks: [
    { label: 'set LED all to [green]',      color: 'var(--cat-looks)', type: 'set_led',    params: { color: 'green' } },
    { label: 'play note [C4] for [500]ms',  color: 'var(--cat-sound)', type: 'play_sound', params: { note: 'C4', duration: 500 } },
  ]},
  { title: 'SENSOR GARIS', info: 'sensor_garis', blocks: [
    { label: 'baca sensor garis',            color: 'var(--cat-sensors)', type: 'sensor_line', params: {} },
    { label: 'ikuti garis selama [3] detik', color: 'var(--cat-motion)',  type: 'follow_line',  params: { seconds: 3 } },
  ]},
];

/* Learning-module content shown in the sensor info modal on the Build
   page. Diagrams are original illustrative SVGs (not vendor photos) —
   swap sensor_info-*.icon for a real product photo later if you have
   one (e.g. host it under Front/icons/sensors/ and use an <img> tag). */
const SENSOR_INFO = {
  ultrasonik: {
    title: 'Sensor Ultrasonik (HC-SR04)',
    icon: `<svg viewBox="0 0 240 140" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="40" width="200" height="70" rx="8" fill="#1a3a3f" stroke="#22d3ee" stroke-width="2"/>
      <circle cx="80" cy="75" r="26" fill="#0d2528" stroke="#22d3ee" stroke-width="2"/>
      <circle cx="80" cy="75" r="15" fill="#133034"/>
      <circle cx="160" cy="75" r="26" fill="#0d2528" stroke="#22d3ee" stroke-width="2"/>
      <circle cx="160" cy="75" r="15" fill="#133034"/>
      <rect x="95" y="112" width="50" height="14" rx="2" fill="#0d2528" stroke="#22d3ee" stroke-width="1.5"/>
      <text x="120" y="122" font-size="8" fill="#22d3ee" text-anchor="middle" font-family="monospace">VCC TRIG ECHO GND</text>
      <path d="M60 30 Q80 10 100 30" stroke="#22d3ee" stroke-width="2" fill="none" opacity=".5"/>
      <path d="M50 20 Q80 -8 110 20" stroke="#22d3ee" stroke-width="2" fill="none" opacity=".3"/>
    </svg>`,
    pins: [
      { name: 'VCC',  to: '5V (ESP32)',       note: 'Butuh 5V, bukan 3.3V — kalau papan cuma punya pin 3V3, pakai VIN/5V dari power modul.' },
      { name: 'TRIG', to: 'GPIO output (mis. D5)', note: 'Kirim pulsa HIGH 10µs untuk memicu pengiriman gelombang ultrasonik.' },
      { name: 'ECHO', to: 'GPIO input (mis. D18)', note: 'Sinyal ECHO balik di level 5V — sebaiknya pakai voltage divider (resistor) supaya aman untuk GPIO ESP32 yang 3.3V.' },
      { name: 'GND',  to: 'GND (common)',     note: 'Harus satu ground dengan ESP32.' },
    ],
    description: `
      <p>Sensor ultrasonik mengukur jarak dengan memancarkan gelombang suara ultrasonik lewat pemancar (kiri), lalu menghitung <strong>waktu tempuh</strong> sampai gelombang itu memantul balik dan ditangkap oleh penerima (kanan).</p>
      <p>Jarak dihitung dari rumus: <strong>jarak = (waktu × kecepatan suara) / 2</strong> — dibagi 2 karena waktunya menghitung perjalanan pergi-pulang.</p>
      <p><strong>Kegunaan di robot:</strong> deteksi halangan di depan robot (obstacle avoidance), berhenti otomatis sebelum menabrak, atau mengukur jarak ke suatu objek.</p>
    `,
    example: `
      <p>Blok <code>read ultrasonic</code> mengembalikan jarak dalam satuan <strong>cm</strong>.</p>
      <p>Contoh pola umum: baca sensor → kalau hasilnya kurang dari nilai tertentu (mis. 10 cm) → robot berhenti atau berbelok. Ini biasanya digabung dengan blok kondisi <code>IFLT</code> di tab Code.</p>
    `,
  },
  gripper: {
    title: 'Gripper / Lengan Robot (Servo)',
    icon: `<svg viewBox="0 0 240 140" xmlns="http://www.w3.org/2000/svg">
      <rect x="90" y="70" width="40" height="50" rx="4" fill="#1a2440" stroke="#3b8aff" stroke-width="2"/>
      <rect x="98" y="60" width="10" height="14" fill="#2a3a66"/>
      <path d="M108 60 L60 20" stroke="#3b8aff" stroke-width="8" stroke-linecap="round"/>
      <path d="M112 60 L160 20" stroke="#3b8aff" stroke-width="8" stroke-linecap="round"/>
      <circle cx="60" cy="20" r="6" fill="#0d1830"/>
      <circle cx="160" cy="20" r="6" fill="#0d1830"/>
      <text x="110" y="135" font-size="8" fill="#3b8aff" text-anchor="middle" font-family="monospace">VCC SIGNAL GND</text>
    </svg>`,
    pins: [
      { name: 'VCC (Merah)',   to: '5V — sebaiknya power terpisah', note: 'Servo menarik arus lumayan besar saat bergerak; kalau ambil langsung dari 5V ESP32, board bisa restart sendiri. Idealnya dari power supply/baterai eksternal (tetap satu GND).' },
      { name: 'SIGNAL (Kuning/Oranye)', to: 'GPIO PWM (mis. D13)', note: 'Menerima sinyal PWM yang menentukan sudut servo (biasanya pulsa 1–2ms tiap 20ms).' },
      { name: 'GND (Coklat/Hitam)', to: 'GND (common)', note: 'Wajib satu ground dengan ESP32, meskipun VCC dari sumber terpisah.' },
    ],
    description: `
      <p>Servo motor mengubah sinyal PWM (lebar pulsa) menjadi <strong>posisi sudut</strong> yang presisi (biasanya 0°–180°). Gripper memakai satu servo yang digerakkan ke dua posisi sudut: satu untuk "terbuka", satu untuk "tertutup".</p>
      <p><strong>Kegunaan di robot:</strong> mengambil, menjepit, atau memindahkan objek kecil — bagian penting dari tantangan "pick and place".</p>
    `,
    example: `
      <p>Blok <code>buka gripper</code> dan <code>tutup gripper</code> masing-masing mengirim posisi sudut yang sudah ditentukan di firmware (lihat <code>main.py</code> pada handler <code>gripper_open</code>/<code>gripper_close</code>).</p>
      <p>Pola umum: buka gripper → dekati objek pakai motor → tutup gripper → angkat/pindahkan.</p>
    `,
  },
  led_buzzer: {
    title: 'LED RGB & Buzzer',
    icon: `<svg viewBox="0 0 240 140" xmlns="http://www.w3.org/2000/svg">
      <circle cx="70" cy="65" r="30" fill="#2a1f40" stroke="#a78bfa" stroke-width="2"/>
      <circle cx="70" cy="65" r="14" fill="#a78bfa" opacity=".8"/>
      <rect x="58" y="98" width="24" height="10" fill="#3a2f55"/>
      <rect x="150" y="35" width="55" height="55" rx="27" fill="#3a1030" stroke="#ec4899" stroke-width="2"/>
      <circle cx="177" cy="62" r="16" fill="#1a0818"/>
      <text x="120" y="130" font-size="8" fill="#a78bfa" text-anchor="middle" font-family="monospace">LED: VCC DATA GND   BUZZER: + / GPIO</text>
    </svg>`,
    pins: [
      { name: 'LED · DATA', to: 'GPIO output (mis. D4)', note: 'Modul LED RGB (mis. WS2812/NeoPixel) menerima data warna secara digital lewat 1 pin, dikontrol beruntun untuk semua LED.' },
      { name: 'LED · VCC/GND', to: '5V & GND', note: 'Untuk strip LED yang lebih dari beberapa buah, sebaiknya pakai power terpisah.' },
      { name: 'Buzzer · Sinyal', to: 'GPIO PWM (mis. D25)', note: 'Buzzer pasif dibunyikan dengan mengirim gelombang PWM pada frekuensi tertentu (nada) selama durasi tertentu.' },
      { name: 'Buzzer · GND', to: 'GND (common)', note: '—' },
    ],
    description: `
      <p><strong>LED RGB</strong> bisa diatur warnanya (merah, hijau, biru, kombinasi) untuk memberi indikator visual status robot — misalnya hijau saat aman, merah saat mendeteksi halangan.</p>
      <p><strong>Buzzer</strong> menghasilkan bunyi dengan frekuensi tertentu; tiap "nada" (C4, D4, dst.) sebenarnya cuma frekuensi berbeda yang membuat speaker piezo bergetar pada kecepatan itu.</p>
      <p><strong>Kegunaan di robot:</strong> feedback yang bisa dilihat/didengar manusia — penting untuk debugging dan membuat robot "terasa hidup".</p>
    `,
    example: `
      <p>Blok <code>set LED all to [green]</code> mengubah warna semua LED sekaligus. Blok <code>play note [C4] for [500]ms</code> membunyikan nada C4 selama setengah detik.</p>
      <p>Contoh pola: robot mendeteksi objek → LED jadi merah + bunyi 2x pendek sebagai alarm.</p>
    `,
  },
  sensor_garis: {
    title: 'Sensor Garis (IR Line Sensor)',
    icon: `<svg viewBox="0 0 240 140" xmlns="http://www.w3.org/2000/svg">
      <rect x="30" y="50" width="180" height="40" rx="6" fill="#102a1f" stroke="#22d3ee" stroke-width="2"/>
      <circle cx="65" cy="70" r="8" fill="#0a1712"/><circle cx="65" cy="70" r="4" fill="#22d3ee"/>
      <circle cx="120" cy="70" r="8" fill="#0a1712"/><circle cx="120" cy="70" r="4" fill="#22d3ee"/>
      <circle cx="175" cy="70" r="8" fill="#0a1712"/><circle cx="175" cy="70" r="4" fill="#22d3ee"/>
      <rect x="0" y="118" width="240" height="10" fill="#1b1b1b"/>
      <rect x="105" y="118" width="18" height="10" fill="#e8e8e8"/>
      <text x="120" y="105" font-size="8" fill="#22d3ee" text-anchor="middle" font-family="monospace">VCC OUT1 OUT2 OUT3 GND</text>
    </svg>`,
    pins: [
      { name: 'VCC', to: '3.3V atau 5V', note: 'Cek datasheet modul — kebanyakan modul IR array mendukung keduanya.' },
      { name: 'OUT ×N', to: 'GPIO input (satu per sensor)', note: 'Biasanya berupa array 3–5 sensor inframerah; tiap sensor bernilai HIGH/LOW (atau analog) tergantung terang/gelapnya permukaan di bawahnya.' },
      { name: 'GND', to: 'GND (common)', note: '—' },
    ],
    description: `
      <p>Sensor garis memancarkan cahaya inframerah ke permukaan lalu mengukur seberapa banyak yang <strong>dipantulkan kembali</strong>. Permukaan terang (lantai putih) memantulkan lebih banyak cahaya dibanding permukaan gelap (garis hitam) — perbedaan ini yang dibaca sensor.</p>
      <p>Karena sensornya berupa array (baris beberapa titik), robot bisa tahu apakah garis ada di tengah, geser ke kiri, atau ke kanan dari posisinya sekarang.</p>
      <p><strong>Kegunaan di robot:</strong> line-following — robot mengikuti jalur garis di lantai secara otomatis, dasar untuk banyak kompetisi robotika.</p>
    `,
    example: `
      <p>Blok <code>baca sensor garis</code> mengembalikan posisi garis relatif ke robot. Blok <code>ikuti garis selama [3] detik</code> menjalankan logika following otomatis selama durasi yang ditentukan.</p>
      <p>Robot akan otomatis berhenti/menyesuaikan arah kalau kehilangan garis (lihat pengaman di <code>main.py</code>).</p>
    `,
  },
};

function renderBuildPalette() {
  const list = document.getElementById('build-palette-list');
  list.innerHTML = '';

  // Scroll direction (vertical in portrait, horizontal in landscape) is
  // already controlled by the CSS overflow-x/overflow-y rules per
  // breakpoint — no need to hardcode a pan direction here. The previous
  // `touchAction = 'pan-x'` was written for the landscape row layout but
  // applied unconditionally, which silently blocked vertical scrolling
  // in portrait (this list's default stacked layout).
  list.style.webkitOverflowScrolling = 'touch';

  // Track touch start to distinguish tap vs swipe
  let touchStartX = 0;
  let touchStartY = 0;
  list.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  BUILD_MODULES.forEach(mod => {
    const header = document.createElement('div');
    header.className = 'palette-header build-palette-header';
    header.style.marginTop = '14px';
    header.innerHTML = `<span>${mod.title}</span>` + (mod.info ? `<span class="info-dot">i</span>` : '');
    if (mod.info) {
      header.title = 'Klik untuk lihat penjelasan lengkap sensor ini';
      header.addEventListener('click', () => showSensorDetail(mod.info));
    }
    list.appendChild(header);

    mod.blocks.forEach(block => {
      const el = document.createElement('button');
      el.className = 'palette-block';
      el.style.background = block.color;
      el.style.touchAction = 'manipulation';
      el.innerHTML = `<div class="notch"></div>${block.label}`;
      if (mod.info) {
        // Distinguish tap vs swipe — only trigger on tap
        el.addEventListener('touchend', e => {
          const dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
          const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
          if (dx < 10 && dy < 10) showSensorDetail(mod.info);
        });
        el.addEventListener('click', () => showSensorDetail(mod.info));
      }
      list.appendChild(el);
    });
  });
}

/* ── Sensor detail panel (Learn page) ────────────────────────── */
let sensorInfoActiveTab = 'foto';
let sensorInfoCurrentKey = null;

/* Named handler for the Foto tab's <img onerror>. Kept as a real function
   (not an inline string) because SENSOR_INFO[key].icon is raw SVG markup
   full of double quotes, which would break out of an onerror="..." HTML
   attribute if embedded directly there. */
function handleSensorPhotoError(imgEl) {
  const key = imgEl.dataset.sensorKey;
  const wrap = imgEl.closest('#sensor-photo-wrap');
  if (wrap && SENSOR_INFO[key]) wrap.innerHTML = SENSOR_INFO[key].icon;
}

function renderSensorInfoBody() {
  const data = SENSOR_INFO[sensorInfoCurrentKey];
  if (!data) return;
  const body = document.getElementById('sensor-detail-body');

  if (sensorInfoActiveTab === 'foto') {
    // Real product photo if you've placed one at Front/icons/sensors/<key>.jpg —
    // falls back to the illustrative SVG automatically if the file doesn't
    // exist yet. Uses a named handler (not an inline string) because the
    // SVG markup itself contains double quotes that would otherwise break
    // out of the onerror="..." attribute.
    body.innerHTML = `
      <div class="sensor-diagram-wrap" id="sensor-photo-wrap">
        <img src="/icons/sensors/${sensorInfoCurrentKey}.jpg" alt="${data.title}"
             data-sensor-key="${sensorInfoCurrentKey}"
             style="max-width:100%;max-height:220px;border-radius:10px;object-fit:contain;"
             onerror="handleSensorPhotoError(this)" />
      </div>
      <p style="text-align:center;font-style:italic;">Foto modul — kalau belum ada, tampil diagram ilustrasi sebagai gantinya.</p>`;
  } else if (sensorInfoActiveTab === 'pin') {
    const rows = data.pins.map(p => `
      <tr>
        <td class="pin-name">${p.name}</td>
        <td>${p.to}</td>
        <td>${p.note}</td>
      </tr>`).join('');
    body.innerHTML = `
      <table class="pin-table">
        <thead><tr><th>Pin</th><th>Sambung ke</th><th>Catatan</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } else if (sensorInfoActiveTab === 'deskripsi') {
    body.innerHTML = data.description;
  } else if (sensorInfoActiveTab === 'contoh') {
    body.innerHTML = `<div class="sensor-example-block">${data.example}</div>`;
  }
}

function showSensorDetail(key) {
  sensorInfoCurrentKey = key;
  sensorInfoActiveTab = 'foto';
  document.getElementById('sensor-detail-title').textContent = SENSOR_INFO[key].title;
  document.querySelectorAll('#sensor-detail-tabs .sensor-info-tab')
    .forEach(t => t.classList.toggle('active', t.dataset.tab === 'foto'));
  renderSensorInfoBody();
  document.getElementById('sensor-detail-empty').classList.add('hidden');
  document.getElementById('sensor-detail-panel').classList.remove('hidden');
}

document.querySelectorAll('#sensor-detail-tabs .sensor-info-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    sensorInfoActiveTab = tab.dataset.tab;
    document.querySelectorAll('#sensor-detail-tabs .sensor-info-tab').forEach(t => t.classList.toggle('active', t === tab));
    renderSensorInfoBody();
  });
});

/* ═══════════════════════════════════════════════════════════
   CANVAS RENDERING — builds the DOM from `programBlocks` and
   wires up real drag/drop, editing, and deletion.
═══════════════════════════════════════════════════════════ */

/* Turn a palette label template like 'move forward at [50]% speed'
   into HTML with editable value spans bound to `block.params`,
   using bracket order → Object.keys(params) order.               */
function renderLabel(template, params) {
  const paramKeys = Object.keys(params || {});
  let i = 0;
  return template.replace(/\[([^\]]*)\]/g, (m, inner) => {
    const key = paramKeys[i] !== undefined ? paramKeys[i] : null;
    const val = key ? params[key] : inner;
    i++;
    return `<span class="block-val block-val-round" contenteditable="true" ` +
           `data-param-key="${key || ''}" spellcheck="false">${escapeHtml(val)}</span>`;
  });
}

/* Swap the generic editable span for a proper <select> on a couple
   of blocks where free-text editing would be error-prone.         */
function upgradeSpecialInputs(main, block) {
  const makeSelect = (key, options) => {
    const span = main.querySelector(`.block-val[data-param-key="${key}"]`);
    if (!span) return;
    const select = document.createElement('select');
    select.className = 'block-val-select';
    options.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (String(block.params[key]) === opt) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('mousedown', e => e.stopPropagation());
    select.addEventListener('click', e => e.stopPropagation());
    select.addEventListener('change', () => { block.params[key] = select.value; });
    span.replaceWith(select);
  };

  if (block.type === 'set_led') {
    makeSelect('color', ['red', 'green', 'blue', 'yellow', 'white', 'off']);
  } else if (block.type === 'play_sound') {
    makeSelect('note', ['C4','D4','E4','F4','G4','A4','B4','C5','D5','E5']);
  }
}

/* Bind live editing on remaining contenteditable value spans.
   Also temporarily disables the parent's draggable flag while
   editing, so text selection doesn't fight with drag-and-drop.    */
function attachValueEditors(main, block) {
  main.querySelectorAll('.block-val[contenteditable="true"]').forEach(span => {
    span.addEventListener('mousedown', () => { main.draggable = false; });
    span.addEventListener('click', e => e.stopPropagation());
    span.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
    });
    span.addEventListener('blur', () => {
      main.draggable = !IS_TOUCH_DEVICE;
      const key = span.dataset.paramKey;
      if (!key) return;
      const raw = span.textContent.trim();
      const asNum = parseFloat(raw);
      block.params[key] = (raw !== '' && !isNaN(asNum) && String(asNum) === raw) ? asNum : raw;
    });
  });
}

/* Where in a drop container (by Y position) should the dragged
   block land? Only looks at direct .block-slot children, so
   nested c-block bodies don't interfere with their parent list.   */
function getInsertIndex(containerEl, clientY) {
  const items = Array.from(containerEl.querySelectorAll(':scope > .block-slot'));
  for (let i = 0; i < items.length; i++) {
    const rect = items[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return items.length;
}

/* One in-flight drag's payload, set on dragstart, read on drop.
   Using a JS variable (not dataTransfer) keeps full block objects
   intact without needing to (de)serialize them through the DOM.   */
let dragPayload = null;

/* Every .dnd-container's (getArray, ctx) pair, so the actual insert/move
   logic (performContainerDrop below) can be shared between the mouse
   `drop` event AND the touch-drag system (see attachTouchDrag) instead
   of being duplicated — a container is dropped into the same way no
   matter which input method triggered it. */
const containerDndMap = new WeakMap();

/* The actual "what happens when payload X is dropped into container Y at
   this Y-position" logic — used by both the native mouse `drop` handler
   and the touch-drag touchend handler below. Previously this lived
   inline inside the `drop` listener only, which meant touch dragging
   (added later) would have needed to duplicate it and could drift out
   of sync with any future change to this logic. */
function performContainerDrop(containerEl, payload, clientY) {
  const entry = containerDndMap.get(containerEl);
  if (!entry || !payload) return;
  const { getArray, ctx } = entry;
  const arrayRef = getArray();
  const insertIdx = getInsertIndex(containerEl, clientY);

  if (payload.source === 'palette') {
    ctx.pushHistory();
    const newBlock = {
      id: genId(),
      type: payload.type,
      params: JSON.parse(JSON.stringify(payload.params || {})),
      children: shapeOf(payload.type) === 'c' ? [] : [],
    };
    arrayRef.splice(insertIdx, 0, newBlock);
    showToast(`Added: ${payload.type.replace(/_/g, ' ')}`);

  } else if (payload.source === 'canvas') {
    const draggedBlock = findBlockById(payload.id, ctx.getRoot());
    if (!draggedBlock) return;
    // Guard: never drop a block inside its own subtree
    if (collectDescendantArrays(draggedBlock).includes(arrayRef)) {
      ctx.render();
      return;
    }
    ctx.pushHistory();
    const removed = removeBlockById(payload.id, ctx.getRoot());
    if (removed) arrayRef.splice(insertIdx, 0, removed);
  }

  ctx.render();
}

function attachContainerDnD(containerEl, getArray, ctx) {
  containerEl.classList.add('dnd-container');
  containerDndMap.set(containerEl, { getArray, ctx });
  containerEl.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    containerEl.classList.add('drop-active');
  });
  containerEl.addEventListener('dragleave', e => {
    if (e.target === containerEl) containerEl.classList.remove('drop-active');
  });
  containerEl.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    containerEl.classList.remove('drop-active');
    if (!dragPayload) return;
    performContainerDrop(containerEl, dragPayload, e.clientY);
    dragPayload = null;
  });
}

/* ── Touch-based drag & drop ─────────────────────────────────────
   Native HTML5 draggable/dragstart/dragover/drop (used everywhere
   above) simply never fires from touch gestures on Android Chrome or
   iOS Safari — there's no CSS fix for that, it needs its own
   touch-event-driven implementation. This runs ALONGSIDE the existing
   mouse-based handlers above (untouched) and only ever engages for
   actual touch pointers, so desktop drag-and-drop keeps working
   exactly as it did before.

   Drag is gated behind a LONG-PRESS timer (not touch-action:none on
   the blocks) — the first version claimed every touch on a block
   immediately, which meant a normal swipe-to-scroll gesture starting
   on a block (which is most of the palette/canvas surface — blocks
   are packed edge to edge) got hijacked into a drag instead, making
   the whole page nearly impossible to scroll on touch. This mirrors
   how Scratch/Blockly handle it on mobile: a quick swipe scrolls like
   normal (we never call preventDefault unless the long-press fires),
   and only a ~300ms held touch picks the block up.                  */
let touchDrag = null; // { getPayload, payload, sourceEl, startX/Y, lastX/Y, dragging, ghostEl, lastContainer, timer, cancelled }

const DND_INTERACTIVE_SELECTOR = '.block-val, .block-val-select, .block-del-btn, select';
const TOUCH_DRAG_LONG_PRESS_MS = 300;   // hold this long, roughly still, to pick up a block
const TOUCH_DRAG_MOVE_CANCEL_PX = 10;   // moving more than this before the timer fires = scrolling, not dragging

/* A floating visual copy of the block being dragged, so the finger has
   something to visibly carry around (native drag image doesn't exist
   for touch). Positioned with the finger roughly centered above it so
   the block itself isn't hidden under the fingertip. */
function makeDragGhost(sourceEl, clientX, clientY) {
  const ghost = sourceEl.cloneNode(true);
  ghost.classList.add('touch-drag-ghost');
  ghost.style.position = 'fixed';
  ghost.style.top = '0';
  ghost.style.left = '0';
  ghost.style.margin = '0';
  ghost.style.width = sourceEl.getBoundingClientRect().width + 'px';
  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '999';
  ghost.style.opacity = '0.85';
  document.body.appendChild(ghost);
  positionDragGhost(ghost, clientX, clientY);
  return ghost;
}
function positionDragGhost(ghost, clientX, clientY) {
  const w = ghost.getBoundingClientRect().width;
  ghost.style.transform = `translate(${clientX - w / 2}px, ${clientY - 18}px)`;
}

/* Finds the .dnd-container under the finger, ignoring the ghost itself
   (which would otherwise always be "under" the touch point since it's
   what's being dragged). */
function findDropContainerAt(clientX, clientY, ghost) {
  if (ghost) ghost.style.display = 'none';
  const el = document.elementFromPoint(clientX, clientY);
  if (ghost) ghost.style.display = '';
  return el ? el.closest('.dnd-container') : null;
}

/* Wires up touch-based dragging for one draggable element (a palette
   block or a canvas block's main row). `getPayload()` is called lazily
   — only once an actual drag is confirmed — and must return the same
   shape as the mouse dragstart payloads above ({source:'palette',...}
   or {source:'canvas', id}). */
function attachTouchDrag(el, getPayload) {
  el.addEventListener('touchstart', e => {
    if (e.target.closest(DND_INTERACTIVE_SELECTOR)) return; // let tap-to-edit/delete/select work normally
    const t = e.touches[0];
    const state = {
      getPayload, payload: null,
      sourceEl: el,
      startX: t.clientX, startY: t.clientY,
      lastX: t.clientX, lastY: t.clientY,
      ghostEl: null, dragging: false, lastContainer: null,
      cancelled: false, timer: null,
    };
    // Only actually picks the block up once this fires — a plain swipe
    // that moves past the deadzone before then cancels it (see touchmove)
    // and is left alone to scroll normally.
    state.timer = setTimeout(() => {
      if (state.cancelled || touchDrag !== state) return;
      state.dragging = true;
      state.payload = state.getPayload();
      state.ghostEl = makeDragGhost(el, state.lastX, state.lastY);
      el.style.opacity = '0.3';
    }, TOUCH_DRAG_LONG_PRESS_MS);
    touchDrag = state;
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!touchDrag || touchDrag.sourceEl !== el) return;
    const t = e.touches[0];
    touchDrag.lastX = t.clientX;
    touchDrag.lastY = t.clientY;

    if (!touchDrag.dragging) {
      const dx = Math.abs(t.clientX - touchDrag.startX);
      const dy = Math.abs(t.clientY - touchDrag.startY);
      if (dx > TOUCH_DRAG_MOVE_CANCEL_PX || dy > TOUCH_DRAG_MOVE_CANCEL_PX) {
        // Moved too far before the long-press fired — this is a scroll,
        // not a drag. Bail out without ever calling preventDefault, so
        // the browser's native scroll handles the rest of this touch.
        clearTimeout(touchDrag.timer);
        touchDrag.cancelled = true;
        touchDrag = null;
      }
      return;
    }

    // Long-press confirmed — this gesture is ours now.
    e.preventDefault();
    positionDragGhost(touchDrag.ghostEl, t.clientX, t.clientY);

    const container = findDropContainerAt(t.clientX, t.clientY, touchDrag.ghostEl);
    if (touchDrag.lastContainer && touchDrag.lastContainer !== container) {
      touchDrag.lastContainer.classList.remove('drop-active');
    }
    if (container) container.classList.add('drop-active');
    touchDrag.lastContainer = container;
  }, { passive: false });

  function endTouchDrag() {
    if (!touchDrag || touchDrag.sourceEl !== el) return;
    clearTimeout(touchDrag.timer);
    const { dragging, lastContainer, payload, lastY, ghostEl } = touchDrag;
    el.style.opacity = '';
    if (ghostEl) ghostEl.remove();
    if (lastContainer) lastContainer.classList.remove('drop-active');
    if (dragging && lastContainer && payload) {
      performContainerDrop(lastContainer, payload, lastY);
    }
    touchDrag = null;
  }
  el.addEventListener('touchend', endTouchDrag);
  el.addEventListener('touchcancel', endTouchDrag);
}

/* Render one block (+ nested body/close bracket if it's a c-block)
   as a `.block-slot` wrapper, and recurse into its children.      */
function renderBlock(block, ctx) {
  const slot = document.createElement('div');
  slot.className = 'block-slot';
  slot.dataset.id = block.id;

  const def   = PALETTE_INDEX[block.type] || { label: block.type, color: 'var(--cat-myblocks)' };
  const shape = shapeOf(block.type);

  const main = document.createElement('div');
  main.draggable = !IS_TOUCH_DEVICE;
  main.className = 'program-block ' + (
    shape === 'hat' ? 'block-hat' :
    shape === 'end' ? 'block-end' :
    shape === 'c'   ? 'block-mid block-c-open' : 'block-mid'
  );
  main.style.background = def.color;
  main.innerHTML = renderLabel(def.label, block.params);

  upgradeSpecialInputs(main, block);
  attachValueEditors(main, block);

  const delBtn = document.createElement('button');
  delBtn.className = 'block-del-btn';
  delBtn.title = 'Delete block';
  delBtn.textContent = '✕';
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    ctx.pushHistory();
    removeBlockById(block.id, ctx.getRoot());
    ctx.render();
    showToast('Block deleted');
  });
  main.appendChild(delBtn);

  main.addEventListener('dragstart', e => {
    dragPayload = { source: 'canvas', id: block.id };
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => slot.classList.add('dragging'), 0);
  });
  main.addEventListener('dragend', () => slot.classList.remove('dragging'));
  attachTouchDrag(main, () => ({ source: 'canvas', id: block.id }));

  slot.appendChild(main);

  if (shape === 'c') {
    const body = document.createElement('div');
    body.className = 'block-c-body';
    body.style.borderColor = def.color;
    if (!block.children) block.children = [];
    renderBlockList(block.children, body, ctx);
    attachContainerDnD(body, () => block.children, ctx);
    slot.appendChild(body);

    const close = document.createElement('div');
    close.className = 'program-block block-end block-c-close';
    close.style.background = def.color;
    close.style.height = '16px';
    close.style.padding = '0';
    slot.appendChild(close);
  }

  return slot;
}

function renderBlockList(blocks, containerEl, ctx) {
  containerEl.innerHTML = '';
  if (!blocks.length) {
    const hint = document.createElement('div');
    hint.className = 'canvas-empty-hint';
    hint.textContent = 'Drag blocks here…';
    containerEl.appendChild(hint);
  }
  blocks.forEach(b => containerEl.appendChild(renderBlock(b, ctx)));
}

/* ── Canvas "contexts" — each independent canvas (Code's full project
   vs Build's sensor scratchpad) bundles its own root-tree getter,
   render function, and history behavior. This is threaded through
   renderBlock/renderBlockList/attachContainerDnD so a drop, delete,
   or reorder ALWAYS affects the canvas it actually happened in —
   not a hardcoded one. (This fixes a real bug: earlier, every drop
   anywhere called the Code-specific renderCanvas()/programBlocks
   regardless of which canvas triggered it.)                        */
const codeCtx = {
  getRoot:     () => programBlocks,
  render:      () => renderCanvas(),
  pushHistory: () => pushHistory(),
};

/* Full re-render of the canvas from `programBlocks`, plus any
   dependent UI (step counter). Call this after ANY state change.
   Note: the root container's own drag/drop listeners are attached
   ONCE (see setupRootDnD below) — NOT here — because #block-container
   is a persistent DOM node across renders. Re-attaching listeners
   on every render would stack duplicates that fire on stale
   `programBlocks` references (e.g. after trash/undo/redo replace
   the array), silently breaking drops. Nested c-block bodies are
   fresh DOM every render, so those still attach per-render.        */
function renderCanvas() {
  const root = document.getElementById('block-container');
  renderBlockList(programBlocks, root, codeCtx);
  updateStepCounter();
}

function setupRootDnD() {
  const root = document.getElementById('block-container');
  attachContainerDnD(root, () => programBlocks, codeCtx);
}

setupRootDnD();
renderCanvas();

function updateStepCounter() {
  const total = flattenBlocks(programBlocks).filter(b => b.type !== 'event_flag').length;
  const counterEl = document.getElementById('step-counter');
  if (counterEl) counterEl.textContent = `${total} block${total === 1 ? '' : 's'}`;
}

/* ── Category sidebar ───────────────────────────────────────── */
document.querySelectorAll('.cat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderPalette(btn.dataset.cat);
  });
});

/* ── Module buttons ─────────────────────────────────────────── */
document.querySelectorAll('.module-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.module-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    showToast(`Module: ${btn.dataset.mod}`);
  });
});

/* ── 3D Model Viewer (Three.js) ───────────────────────────────
   Renders the real robot design inside the existing "Robot" panel,
   in place of the cartoon SVG twin: Final_1.iam (Inventor) -> exported
   Final_1.obj -> decimated 651k -> 90k triangles -> converted to
   models/robot.glb (~1.8MB). Three.js loads async right after page
   load so it never blocks the initial render. */
let robot3dReady = false;
let robot3dCamera, robot3dControls;
let robot3dAutoRotate = true;

async function initRobot3DViewer() {
  if (robot3dReady) return;
  robot3dReady = true; // guard against double-init

  const loadingEl = document.getElementById('robot3d-loading');
  const errorEl = document.getElementById('robot3d-error');
  const canvas = document.getElementById('robot3d-canvas');
  const viewer = document.getElementById('robot3d-viewer');

  try {
    const [THREE, { OrbitControls }, { GLTFLoader }] = await Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
      import('three/addons/loaders/GLTFLoader.js'),
    ]);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, viewer.clientWidth / viewer.clientHeight, 0.1, 5000);
    robot3dCamera = camera;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(viewer.clientWidth, viewer.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-4, 2, -3);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = robot3dAutoRotate;
    controls.autoRotateSpeed = 2.2;
    controls.minDistance = 0.5;
    controls.maxDistance = 20;
    robot3dControls = controls;

    new GLTFLoader().load(
      './models/robot.glb',
      (gltf) => {
        const model = gltf.scene;

        // The source mesh was exported from CAD (Inventor -> OBJ) and
        // then decimated, which leaves some panels/frame parts with
        // inconsistent face winding — from certain angles their
        // backfaces get culled and they look "missing"/see-through.
        // Rendering both sides fixes that without needing to re-export.
        model.traverse((child) => {
          if (child.isMesh && child.material) {
            child.material.side = THREE.DoubleSide;
          }
        });

        // Auto-center + auto-scale so the model always fills the view
        // nicely regardless of the units/origin it was exported with.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = 2.2 / maxDim;
        model.scale.setScalar(scale);
        model.position.sub(center.multiplyScalar(scale));

        scene.add(model);
        resetRobot3DView();
        loadingEl.classList.add('hidden');
      },
      undefined,
      (err) => {
        console.error('Failed to load robot.glb', err);
        loadingEl.classList.add('hidden');
        errorEl.classList.remove('hidden');
        document.getElementById('robot3d-error-detail').textContent =
          'Pastikan file models/robot.glb ada di folder Front/.';
      }
    );

    function resize() {
      if (!viewer.clientWidth || !viewer.clientHeight) return;
      camera.aspect = viewer.clientWidth / viewer.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(viewer.clientWidth, viewer.clientHeight);
    }
    new ResizeObserver(resize).observe(viewer);

    (function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    })();

    document.getElementById('r3d-reset-btn').addEventListener('click', resetRobot3DView);
    document.getElementById('r3d-rotate-btn').addEventListener('click', (e) => {
      robot3dAutoRotate = !robot3dAutoRotate;
      controls.autoRotate = robot3dAutoRotate;
      e.currentTarget.classList.toggle('active', robot3dAutoRotate);
    });
    document.getElementById('r3d-fullscreen-btn').addEventListener('click', () => {
      if (!document.fullscreenElement) viewer.requestFullscreen?.();
      else document.exitFullscreen?.();
    });
  } catch (err) {
    console.error('3D viewer init failed', err);
    loadingEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
    document.getElementById('robot3d-error-detail').textContent = err?.message || 'Gagal memuat Three.js.';
  }
}

function resetRobot3DView() {
  if (!robot3dCamera || !robot3dControls) return;
  robot3dCamera.position.set(2.4, 1.8, 2.4);
  robot3dControls.target.set(0, 0, 0);
  robot3dControls.update();
}

// The Robot panel (with the 3D viewer) is visible by default on page
// load, so initialize it right away rather than waiting for a tab click.
initRobot3DViewer();

/* ── Panel tabs ─────────────────────────────────────────────── */
document.querySelectorAll('.panel-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('robot-preview').classList.toggle('hidden', tab.dataset.tab !== 'robot');
    document.getElementById('quest-info-panel').classList.toggle('hidden', tab.dataset.tab !== 'stage');
    document.getElementById('sensor-monitor-panel').classList.toggle('hidden', tab.dataset.tab !== 'sensor');
  });
});

/* ── Sensor monitor ("Sensor" tab) ────────────────────────────
   Auto-appears when Run is pressed on a program that contains a
   sensor block, and only ever plots REAL data — DIST:/LINE: messages
   coming back from the connected robot as each PING/LINE token in the
   compiled command actually executes on the ESP32 (see main.py). If
   nothing's connected there's simply nothing to plot; no fake/demo
   data is ever shown, so what a student sees here is always trustworthy
   for debugging real hardware. */
const SM_DIST_MAX_POINTS = 40;
const SM_LINE_MAX_SEGS   = 30;
const SM_DIST_NEAR_CM    = 20;   // matches the dashed threshold line
const SM_DIST_GRAPH_CAP  = 100;  // cm mapped to the top of the graph
let smDistHistory = [];

function smUpdateConnStatus() {
  const pill = document.getElementById('sm-conn-status');
  const text = document.getElementById('sm-conn-text');
  pill.classList.toggle('online', bleConnected);
  text.textContent = bleConnected ? 'Terhubung — menerima data' : 'Belum terhubung ke robot';
}

function smResetAndShowFor(hasUltrasonic, hasLine) {
  smDistHistory = [];
  document.getElementById('sm-dist-value').textContent = '--';
  document.getElementById('sm-dist-line').setAttribute('points', '');
  document.querySelectorAll('.sm-line-dot').forEach(d => d.classList.remove('on'));
  document.getElementById('sm-line-strip').innerHTML = '';
  document.getElementById('sm-ultrasonic-section').classList.toggle('hidden', !hasUltrasonic);
  document.getElementById('sm-line-section').classList.toggle('hidden', !hasLine);
  document.getElementById('sm-empty').classList.remove('hidden');
  smUpdateConnStatus();
}

function smPushDist(cm) {
  document.getElementById('sm-empty').classList.add('hidden');
  document.getElementById('sm-dist-value').textContent = cm;
  smDistHistory.push(cm);
  if (smDistHistory.length > SM_DIST_MAX_POINTS) smDistHistory.shift();

  const w = 280, h = 90;
  const step = w / Math.max(1, SM_DIST_MAX_POINTS - 1);
  const startX = w - (smDistHistory.length - 1) * step;
  const points = smDistHistory.map((v, i) => {
    const x = startX + i * step;
    const y = h - Math.min(v, SM_DIST_GRAPH_CAP) / SM_DIST_GRAPH_CAP * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const line = document.getElementById('sm-dist-line');
  line.setAttribute('points', points);
  line.style.stroke = cm < SM_DIST_NEAR_CM ? 'var(--accent-red)' : 'var(--cat-sensors)';
}

function smPushLine(left, right) {
  document.getElementById('sm-empty').classList.add('hidden');
  document.getElementById('sm-line-left').classList.toggle('on', left);
  document.getElementById('sm-line-right').classList.toggle('on', right);

  const strip = document.getElementById('sm-line-strip');
  const seg = document.createElement('div');
  seg.className = 'sm-line-seg' + (left || right ? ' on' : '');
  seg.title = `Kiri: ${left ? 'ON' : 'off'} · Kanan: ${right ? 'ON' : 'off'}`;
  strip.appendChild(seg);
  while (strip.children.length > SM_LINE_MAX_SEGS) strip.removeChild(strip.firstChild);
}

function smCheckProgramAndMaybeShow() {
  const types = new Set(flattenBlocks(programBlocks).map(b => b.type));
  const hasUltrasonic = types.has('sensor_ping');
  const hasLine = types.has('sensor_line');
  const sensorTab = document.getElementById('sensor-tab-btn');

  if (hasUltrasonic || hasLine) {
    sensorTab.classList.remove('tab-hidden');
    smResetAndShowFor(hasUltrasonic, hasLine);
    sensorTab.click();
  } else {
    sensorTab.classList.add('tab-hidden');
    if (sensorTab.classList.contains('active')) {
      document.querySelector('.panel-tab[data-tab="robot"]').click();
    }
  }
}

/* ── Speed slider ───────────────────────────────────────────── */
const speedSlider = document.getElementById('speed-slider');
const speedVal    = document.getElementById('speed-val');
speedSlider.addEventListener('input', () => {
  const v = speedSlider.value;
  speedVal.textContent = `${v}%`;
  speedSlider.style.background =
    `linear-gradient(to right, var(--accent-orange) ${v}%, var(--border-md) ${v}%)`;
});

/* ── Canvas tools ───────────────────────────────────────────── */
let scale = 1;
const blockContainer = document.getElementById('block-container');

document.getElementById('zoom-in-btn').addEventListener('click', () => {
  scale = Math.min(scale + 0.1, 2);
  blockContainer.style.transform = `scale(${scale.toFixed(2)})`;
  blockContainer.style.transformOrigin = 'top left';
});
document.getElementById('zoom-out-btn').addEventListener('click', () => {
  scale = Math.max(scale - 0.1, 0.4);
  blockContainer.style.transform = `scale(${scale.toFixed(2)})`;
  blockContainer.style.transformOrigin = 'top left';
});
document.getElementById('undo-btn').addEventListener('click', () => {
  if (!historyStack.length) { showToast('Nothing to undo'); return; }
  redoStack.push(cloneProgram());
  programBlocks = historyStack.pop();
  renderCanvas();
  showToast('Undo');
});
document.getElementById('redo-btn').addEventListener('click', () => {
  if (!redoStack.length) { showToast('Nothing to redo'); return; }
  historyStack.push(cloneProgram());
  programBlocks = redoStack.pop();
  renderCanvas();
  showToast('Redo');
});
document.getElementById('trash-btn').addEventListener('click', () => {
  if (!programBlocks.length) { showToast('Canvas already empty'); return; }
  pushHistory();
  programBlocks = [];
  renderCanvas();
  showToast('Canvas cleared');
});

/* ── AI Panel ───────────────────────────────────────────────── */
const aiPanel = document.getElementById('ai-panel');
const aiPanelBackdrop = document.getElementById('ai-panel-backdrop');
document.getElementById('ai-toggle-btn').addEventListener('click', () => {
  aiPanel.classList.toggle('open');
  aiPanelBackdrop.classList.toggle('open', aiPanel.classList.contains('open'));
});
// Mobile floating AI toggle: forwards to the real button's own handler,
// same pattern as #mobile-run-btn — one place the open/close logic lives.
document.getElementById('mobile-ai-btn').addEventListener('click', () => {
  document.getElementById('ai-toggle-btn').click();
});
aiPanelBackdrop.addEventListener('click', () => {
  aiPanel.classList.remove('open');
  aiPanelBackdrop.classList.remove('open');
});
document.getElementById('ai-close-btn').addEventListener('click', () => {
  aiPanel.classList.remove('open');
  aiPanelBackdrop.classList.remove('open');
});

/* AI assess button */
document.getElementById('assess-btn').addEventListener('click', async () => {
  if (!currentUser) { showToast('Silakan masuk terlebih dahulu.'); return; }
  if (!navigator.onLine) { showToast('Penilaian AI butuh koneksi internet.'); return; }

  const spinner = document.getElementById('assess-spinner');
  const label   = document.getElementById('assess-label');
  spinner.style.display = 'block';
  label.textContent = 'Menilai…';

  try {
    const authHeader = await getAuthHeader();
    const res = await fetch('/api/assess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({
        project_id:      currentQuestId ? `${currentUser.uid}_quest_${currentQuestId}` : currentUser.uid,
        student_id:      currentUser.uid,
        assignment_goal: currentAssignmentGoal,
        blocks:          programBlocks,
        execution_log:   [],
      }),
    });

    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();

    // Update score ring
    const pct = data.score / 100;
    const circumference = 2 * Math.PI * 26;
    const dashoffset    = circumference * (1 - pct);
    const ring = document.getElementById('score-ring');
    ring.setAttribute('stroke-dashoffset', dashoffset.toFixed(1));
    ring.setAttribute('stroke', data.score >= 75 ? '#22c55e' : data.score >= 50 ? '#f59e0b' : '#ef4444');
    document.getElementById('score-ring-text').textContent = data.score;
    document.getElementById('ai-score').textContent = data.score;
    document.getElementById('ai-grade').textContent  = `Nilai: ${data.grade}`;

    // Health — backend keys stay stable English snake_case (API contract),
    // translated here purely for display.
    const HEALTH_LABEL_ID = {
      motion_blocks_present:  'Ada blok gerakan',
      loop_structure_used:    'Struktur loop digunakan',
      led_control_present:    'Ada kontrol LED',
      event_trigger_set:      'Ada event trigger',
      sensor_usage_detected:  'Penggunaan sensor terdeteksi',
    };
    // Not every quest needs every sensor/actuator — e.g. a Gripper quest
    // never touches the LED, so flagging "Ada kontrol LED" as failed
    // there is just noise, not useful feedback. `relevantChecks` on the
    // quest (see QUEST_TRACKS) scopes the checklist down to what that
    // quest actually asked for. Freeform "My Project" mode and any
    // teacher-made custom quest (no relevantChecks defined) still show
    // all 5, same as before.
    const healthEntries = Object.entries(data.robot_health).filter(
      ([k]) => !currentQuestObj?.relevantChecks || currentQuestObj.relevantChecks.includes(k)
    );
    const hl = document.getElementById('health-list');
    const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/></svg>';
    const X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>';
    hl.innerHTML = healthEntries.map(([k, v]) =>
      `<div class="health-item"><span class="health-icon ${v ? 'ok' : 'fail'}">${v ? CHECK_SVG : X_SVG}</span> ${HEALTH_LABEL_ID[k] || k.replace(/_/g,' ')}</div>`
    ).join('');

    // Critique
    document.getElementById('ai-critique').textContent = data.critique;

    // Suggestions
    const sl = document.getElementById('suggestion-list');
    sl.innerHTML = data.suggestions.map((s, i) =>
      `<div class="suggestion-item"><span class="sugg-num">${i + 1}</span>${s}</div>`
    ).join('');

    if (currentQuestId) {
      await saveQuestProgress(currentQuestId, data.score);
      showToast(data.score >= QUEST_PASS_SCORE
        ? `🎉 Quest selesai! Skor: ${data.score}`
        : `Penilaian selesai — Skor: ${data.score} (butuh ${QUEST_PASS_SCORE}+ untuk lulus quest, coba lagi!)`);
    } else {
      showToast(`Penilaian selesai — Skor: ${data.score}`);
    }
  } catch(err) {
    showToast(`Gagal menilai: ${err.message}`);
  } finally {
    spinner.style.display = 'none';
    label.textContent = '✦ Nilai Ulang dengan AI';
  }
});

/* ── Bluetooth ──────────────────────────────────────────────── */
const bleBtn   = document.getElementById('ble-btn');
const bleLabel = document.getElementById('ble-label');

async function connectBLE() {
  if (bleConnected) {
    await robot?.disconnect();
    return;
  }

  if (!navigator.bluetooth) {
    showToast('Web Bluetooth not supported. Use Chrome/Edge desktop.');
    return;
  }

  try {
    robot = new RoboBLE();

    robot.addEventListener('connected', e => {
      bleConnected = true;
      bleBtn.classList.add('connected');
      bleLabel.textContent = `Connected to ${e.detail}`;
      showToast(`🔗 Connected to ${e.detail}`);
      smUpdateConnStatus();
    });

    robot.addEventListener('disconnected', () => {
      bleConnected = false;
      bleBtn.classList.remove('connected');
      bleLabel.textContent = 'Scan & Connect Robot';
      showToast('Disconnected from robot');
      smUpdateConnStatus();
    });

    robot.onData(raw => {
      console.log('[Robot]', raw);
      if (raw.startsWith('DIST:')) {
        const cm = parseFloat(raw.slice(5));
        if (!isNaN(cm)) smPushDist(cm);
      } else if (raw.startsWith('LINE:')) {
        const [left, right] = raw.slice(5).split(',').map(v => v.trim() === '1');
        smPushLine(left, right);
      }
    });

    await robot.connect();
  } catch(err) {
    showToast(`BLE error: ${err.message}`);
  }
}

bleBtn.addEventListener('click', connectBLE);

/* ── Run button ─────────────────────────────────────────────── */
document.getElementById('run-btn').addEventListener('click', async () => {
  // 1. Save via Firestore SDK directly — works offline (queued locally,
  //    synced automatically once online), unlike the old fetch() to
  //    the FastAPI backend which failed outright with no connection.
  //    Skipped while working on a Quest: quests share the same "blank
  //    canvas" pattern and must NOT overwrite the student's main saved
  //    project (which lives at the same Firestore doc either way).
  if (!currentQuestId) {
    await saveProjectToFirestore();
  }

  // 1b. Show/hide the Sensor tab based on whether this program actually
  //     reads a sensor — no point showing an empty graph for a program
  //     that's just motors + LEDs.
  smCheckProgramAndMaybeShow();

  // 2. Send to robot
  if (bleConnected && robot) {
    // Pass the TREE directly — compileBlocks() already walks `children`
    // itself. Flattening first (like the old code did) would make it see
    // every nested block twice: once correctly inside its parent's
    // repeat/if, and once more as a stray top-level command.
    const topLevel = programBlocks.filter(b => b.type !== 'event_flag');
    const { commandStr, unsupported, foreverCapped } = RoboBLE.compileBlocks(topLevel);

    if (unsupported.length) {
      showToast(`⚠️ ${unsupported.length} tipe block belum didukung robot, dilewati: ${unsupported.join(', ')}`);
    }
    if (foreverCapped) {
      showToast('⚠️ Blok "forever" dibatasi 10x putaran (robot tidak bisa dihentikan di tengah program)');
    }

    showToast('▶ Sending program to robot…');
    try {
      await robot.sendCommand(commandStr);
      showToast('✅ Program sent successfully!');
    } catch(err) {
      showToast(`Send error: ${err.message}`);
    }
  } else {
    showToast('▶ Running in simulation mode (no robot connected)');
    // Simulate robot face animation
    let hue = 120;
    const eyes = document.querySelectorAll('#eye-l, #eye-r');
    const interval = setInterval(() => {
      hue = (hue + 30) % 360;
      eyes.forEach(e => e.setAttribute('fill', `hsl(${hue},80%,55%)`));
    }, 400);
    setTimeout(() => {
      clearInterval(interval);
      eyes.forEach(e => e.setAttribute('fill', '#3b8aff'));
    }, 3000);
  }
});

/* ── Keyboard shortcuts ─────────────────────────────────────── */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    document.getElementById('run-btn').click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    showToast('Undo');
  }
});