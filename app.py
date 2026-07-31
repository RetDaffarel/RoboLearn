"""
RoboLearn Backend — app.py
FastAPI + Firebase Admin SDK + OpenAI/Gemini AI Assessment

Dependencies:
    pip install fastapi uvicorn firebase-admin openai google-genai python-dotenv

Run:
    uvicorn app:app --reload --port 8000

Environment variables (.env):
    FIREBASE_CRED_PATH=./serviceAccountKey.json
    OPENAI_API_KEY=sk-...         # use this OR GEMINI_API_KEY
    GEMINI_API_KEY=AIza...        # Google Gemini alternative
    AI_PROVIDER=openai            # "openai" | "gemini"
    SECRET_KEY=your-jwt-secret    # for validating Firebase tokens
"""

import os
import json
import logging
import secrets
from datetime import datetime
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import firebase_admin
from firebase_admin import credentials, firestore, auth

load_dotenv()

# ─────────────────────────────────────────────────────────────
# Firebase initialisation
#
# Local dev: reads the serviceAccountKey.json file at FIREBASE_CRED_PATH.
# Vercel (or any host with an ephemeral/read-only filesystem): set the
# FIREBASE_CREDENTIALS_B64 environment variable instead — base64-encode
# the whole serviceAccountKey.json content and paste it as one env var
# in the Vercel dashboard. Never commit the raw JSON file.
#
#   macOS/Linux:  base64 -i serviceAccountKey.json | pbcopy
#   Windows:      certutil -encode serviceAccountKey.json tmp.b64
# ─────────────────────────────────────────────────────────────
import base64

FIREBASE_CREDENTIALS_B64 = os.getenv("FIREBASE_CREDENTIALS_B64")
FIREBASE_CRED_PATH = os.getenv("FIREBASE_CRED_PATH", "./serviceAccountKey.json")

if not firebase_admin._apps:
    if FIREBASE_CREDENTIALS_B64:
        cred_dict = json.loads(base64.b64decode(FIREBASE_CREDENTIALS_B64))
        cred = credentials.Certificate(cred_dict)
    else:
        cred = credentials.Certificate(FIREBASE_CRED_PATH)
    firebase_admin.initialize_app(cred)

db = firestore.client()

# ─────────────────────────────────────────────────────────────
# AI provider setup (OpenAI or Gemini)
# ─────────────────────────────────────────────────────────────
AI_PROVIDER = os.getenv("AI_PROVIDER", "openai").lower()

if AI_PROVIDER == "openai":
    from openai import AsyncOpenAI
    openai_client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
elif AI_PROVIDER == "gemini":
    from google import genai
    from google.genai import types as genai_types
    gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")

# ─────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────
app = FastAPI(title="RoboLearn API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("robolearn")

# ─────────────────────────────────────────────────────────────
# Serve the frontend from THIS SAME server/port, so `fetch('/api/...')`
# in index.html always hits this backend — no separate dev server, no
# CORS juggling, no "Unexpected token '<'" from accidentally fetching
# a 404 HTML page off a different origin.
#
# Run with:  uvicorn app:app --reload   (or  python app.py)
# Then open: http://localhost:8000/
# ─────────────────────────────────────────────────────────────
from fastapi.responses import FileResponse

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Front")


@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


@app.get("/bluetooth.js")
async def serve_bluetooth_js():
    return FileResponse(
        os.path.join(FRONTEND_DIR, "bluetooth.js"),
        media_type="application/javascript",
    )


# ─────────────────────────────────────────────────────────────
# PWA / TWA (Trusted Web Activity) support files
# ─────────────────────────────────────────────────────────────
@app.get("/manifest.json")
async def serve_manifest():
    return FileResponse(
        os.path.join(FRONTEND_DIR, "manifest.json"),
        media_type="application/manifest+json",
    )


from fastapi.staticfiles import StaticFiles

app.mount(
    "/icons",
    StaticFiles(directory=os.path.join(FRONTEND_DIR, "icons")),
    name="icons",
)
app.mount(
    "/models",
    StaticFiles(directory=os.path.join(FRONTEND_DIR, "models")),
    name="models",
)

@app.get("/.well-known/assetlinks.json")
async def serve_asset_links():
    """
    Required for TWA — proves this domain is controlled by the same
    developer who signed the APK, so Chrome hides the browser UI
    (address bar) and shows the app in true fullscreen "standalone" mode.

    IMPORTANT: replace the placeholder sha256_cert_fingerprints value
    below with your REAL APK signing certificate fingerprint. Bubblewrap
    prints this for you after `bubblewrap build` — see the accompanying
    Bubblewrap guide, step "Get your SHA-256 fingerprint".
    """
    return FileResponse(
        os.path.join(FRONTEND_DIR, "assetlinks.json"),
        media_type="application/json",
    )


# ─────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────
class Block(BaseModel):
    id: str
    type: str
    params: dict[str, Any] = {}
    children: list["Block"] = []


class AssessRequest(BaseModel):
    project_id: str
    student_id: str
    assignment_goal: str          # e.g. "Make the robot dance in a square"
    blocks: list[Block]           # full block tree from the editor
    execution_log: list[str] = [] # optional runtime log from the robot


class GenerateHintRequest(BaseModel):
    title: str
    subtitle: str = ""
    desc: str
    goal: str          # the "Instruksi untuk Penilaian AI" text — NOT shown to students directly


class GenerateHintResponse(BaseModel):
    hint: str


class SaveProjectRequest(BaseModel):
    project_id: str
    student_id: str
    project_name: str
    blocks: list[Block]


class AssessResponse(BaseModel):
    score: int                  # 0 – 100
    grade: str                  # A / B / C / D / F
    critique: str
    suggestions: list[str]
    robot_health: dict[str, bool]
    assessed_at: str


class ProjectSavedResponse(BaseModel):
    success: bool
    project_id: str
    saved_at: str


class RegisterRoleRequest(BaseModel):
    invite_code: str | None = None   # omit/empty -> defaults to 'siswa'


class RoleResponse(BaseModel):
    uid: str
    role: str


class CreateInviteRequest(BaseModel):
    role: str = "guru"               # only 'guru' or 'admin' allowed — see endpoint
    note: str | None = None          # optional label, e.g. "Batch guru SMPN 5"


class InviteCodeResponse(BaseModel):
    code: str
    role: str
    created_by: str
    created_at: str


class StudentSummary(BaseModel):
    uid: str
    email: str
    quest_progress: dict[str, Any] = {}


class UserSummary(BaseModel):
    uid: str
    email: str
    role: str
    updated_at: str | None = None


class SetRoleRequest(BaseModel):
    uid: str
    role: str


# ─────────────────────────────────────────────────────────────
# Auth helper — validate Firebase ID token
# ─────────────────────────────────────────────────────────────
async def get_current_user(authorization: str = Header(default=None)) -> dict:
    """
    Pass the Firebase client-side ID token as:
        Authorization: Bearer <idToken>
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    id_token = authorization.split(" ", 1)[1]
    try:
        decoded = auth.verify_id_token(id_token)
        return decoded
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Token verification failed: {exc}")


VALID_ROLES = {"siswa", "guru", "admin"}


def get_role(user: dict) -> str:
    """Role lives in the Firebase custom claim (signed into the ID token,
    NOT a Firestore field) — so it can't be spoofed or self-escalated by
    editing a document from the client SDK. Defaults to 'siswa' for any
    account that hasn't been assigned a role yet (e.g. right after signup,
    before /api/auth/register-with-code has run)."""
    role = user.get("role", "siswa")
    return role if role in VALID_ROLES else "siswa"


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if get_role(user) != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return user


async def require_teacher_or_admin(user: dict = Depends(get_current_user)) -> dict:
    if get_role(user) not in ("guru", "admin"):
        raise HTTPException(status_code=403, detail="Guru or Admin role required")
    return user


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────
def blocks_to_pseudocode(blocks: list[Block], indent: int = 0) -> str:
    """Recursively convert block tree → human-readable pseudocode for the LLM."""
    lines = []
    prefix = "  " * indent
    for block in blocks:
        params_str = ", ".join(f"{k}={v}" for k, v in block.params.items())
        lines.append(f"{prefix}{block.type}({params_str})")
        if block.children:
            lines.extend(blocks_to_pseudocode(block.children, indent + 1).split("\n"))
    return "\n".join(lines)


def score_to_grade(score: int) -> str:
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 60:
        return "D"
    return "F"


def mock_robot_health(blocks: list[Block]) -> dict[str, bool]:
    """
    Derive a simple health checklist from the block list.
    In production, replace with real telemetry from Firebase Realtime DB / MQTT.
    """
    types = {b.type for b in blocks}
    return {
        # "gripper_open"/"gripper_close" are motion just as much as
        # "move_forward"/"turn_right" — a gripper-only quest was always
        # failing this check even with a perfect submission until this.
        "motion_blocks_present": any(
            "move" in t.lower() or "turn" in t.lower() or "gripper" in t.lower() for t in types
        ),
        "loop_structure_used":   any("repeat" in t.lower() or "loop" in t.lower() for t in types),
        "led_control_present":   any("led" in t.lower() for t in types),
        "event_trigger_set":     any("flag" in t.lower() or "event" in t.lower() for t in types),
        # "follow_line" reads the IR line sensors internally even though
        # its block type name doesn't say "sensor" — same bug as above,
        # was always failing every Line Follower quest.
        "sensor_usage_detected": any(
            "sensor" in t.lower() or "ultrasonic" in t.lower() or "follow_line" in t.lower() for t in types
        ),
    }


# ─────────────────────────────────────────────────────────────
# AI Assessment
# ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """
You are an expert robotics education assessor for K-12 students in Indonesia.
You receive pseudocode generated from a visual block-programming editor (similar to Scratch)
that controls a physical ESP32-based robot.

Evaluate the program strictly against the stated assignment goal.
Return ONLY valid JSON with exactly these keys (no markdown, no commentary):
{
  "score": <integer 0-100>,
  "critique": "<2-4 sentence holistic evaluation, written in Bahasa Indonesia>",
  "suggestions": ["<actionable tip 1, in Bahasa Indonesia>", "<actionable tip 2, in Bahasa Indonesia>", "<actionable tip 3, in Bahasa Indonesia>"]
}

IMPORTANT: "critique" and every string inside "suggestions" MUST be written
entirely in Bahasa Indonesia (natural, student-friendly Indonesian — not a
literal/robotic translation), regardless of what language the assignment
goal below is written in. Only the JSON keys themselves stay in English,
exactly as shown above.

Scoring rubric:
  - Logical correctness  (40 pts): Does the program actually achieve the stated goal?
  - Efficiency           (30 pts): Are loops used where repetition exists? Minimal redundancy?
  - Completeness         (20 pts): Are all required behaviours covered (motion, LEDs, timing)?
  - Code style           (10 pts): Good structure, event triggers, no dangling blocks?
""".strip()


HINT_SYSTEM_PROMPT = """
You are a friendly robotics teaching assistant for K-12 students in Indonesia
who use a block-based visual programming editor (similar to Scratch) to
control a physical ESP32-based robot.

You will be given a quest's title, description, and the internal grading
instruction that a separate AI assessor uses to score the student's finished
program. That grading instruction is written for an AI, not for a student —
it can be dry, technical, or reveal exactly how scoring works.

Your job is to turn that into a short, encouraging HINT for the student that:
  - Points them toward which blocks/behaviour to use, without simply repeating
    the grading instruction word-for-word or sounding like a checklist for a machine.
  - Does NOT hand them a step-by-step full solution or exact block sequence —
    nudge, don't solve.
  - Is written entirely in natural, student-friendly Bahasa Indonesia.
  - Is short: 1-3 sentences, plain language, no jargon a middle-schooler wouldn't know.

Return ONLY valid JSON with exactly this key (no markdown, no commentary):
{"hint": "<the hint, in Bahasa Indonesia>"}
""".strip()


async def call_openai_hint(title: str, subtitle: str, desc: str, goal: str) -> str:
    user_msg = (
        f"Quest title: {title}\n"
        f"Subtitle: {subtitle or '(none)'}\n"
        f"Description shown to students: {desc}\n"
        f"Internal AI grading instruction: {goal}"
    )
    response = await openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": HINT_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.5,
        response_format={"type": "json_object"},
    )
    result = json.loads(response.choices[0].message.content)
    return result.get("hint", "").strip()


async def call_gemini_hint(title: str, subtitle: str, desc: str, goal: str) -> str:
    prompt = (
        f"{HINT_SYSTEM_PROMPT}\n\n"
        f"Quest title: {title}\n"
        f"Subtitle: {subtitle or '(none)'}\n"
        f"Description shown to students: {desc}\n"
        f"Internal AI grading instruction: {goal}"
    )
    response = await gemini_client.aio.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            temperature=0.5,
            response_mime_type="application/json",
        ),
    )
    raw = response.text.strip().removeprefix("```json").removesuffix("```").strip()
    result = json.loads(raw)
    return result.get("hint", "").strip()


async def call_openai(pseudocode: str, goal: str, log: list[str]) -> dict:
    log_section = f"\nExecution log:\n{chr(10).join(log)}" if log else ""
    user_msg = (
        f"Assignment goal: {goal}\n\n"
        f"Student's block program (pseudocode):\n{pseudocode}"
        f"{log_section}"
    )
    response = await openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": user_msg},
        ],
        temperature=0.3,
        response_format={"type": "json_object"},
    )
    return json.loads(response.choices[0].message.content)


async def call_gemini(pseudocode: str, goal: str, log: list[str]) -> dict:
    log_section = f"\nExecution log:\n{chr(10).join(log)}" if log else ""
    prompt = (
        f"{SYSTEM_PROMPT}\n\n"
        f"Assignment goal: {goal}\n\n"
        f"Student's block program (pseudocode):\n{pseudocode}"
        f"{log_section}"
    )
    response = await gemini_client.aio.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            temperature=0.3,
            response_mime_type="application/json",
        ),
    )
    raw = response.text.strip().removeprefix("```json").removesuffix("```").strip()
    return json.loads(raw)


# ─────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "provider": AI_PROVIDER}


@app.post("/api/assess", response_model=AssessResponse)
async def assess(
    body: AssessRequest,
    user: dict = Depends(get_current_user),
):
    """
    POST /api/assess
    Accepts a block program, calls the LLM, writes the result to Firestore,
    and returns a structured assessment.
    """
    pseudocode = blocks_to_pseudocode(body.blocks)
    logger.info("Assessing project %s for student %s", body.project_id, body.student_id)

    # ── Call the AI ──
    try:
        if AI_PROVIDER == "openai":
            ai_result = await call_openai(pseudocode, body.assignment_goal, body.execution_log)
        else:
            ai_result = await call_gemini(pseudocode, body.assignment_goal, body.execution_log)
    except Exception as exc:
        logger.exception("AI call failed")
        raise HTTPException(status_code=502, detail=f"AI provider error: {exc}")

    score       = max(0, min(100, int(ai_result.get("score", 0))))
    critique    = ai_result.get("critique", "")
    suggestions = ai_result.get("suggestions", [])[:5]
    grade       = score_to_grade(score)
    health_map  = mock_robot_health(body.blocks)
    assessed_at = datetime.utcnow().isoformat() + "Z"

    # ── Persist to Firestore ──
    assessment_doc = {
        "project_id":       body.project_id,
        "student_id":       body.student_id,
        "assignment_goal":  body.assignment_goal,
        "pseudocode":       pseudocode,
        "score":            score,
        "grade":            grade,
        "critique":         critique,
        "suggestions":      suggestions,
        "robot_health":     health_map,
        "assessed_at":      assessed_at,
    }
    db.collection("assessments").document(
        f"{body.project_id}_{body.student_id}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
    ).set(assessment_doc)

    return AssessResponse(
        score=score,
        grade=grade,
        critique=critique,
        suggestions=suggestions,
        robot_health=health_map,
        assessed_at=assessed_at,
    )


@app.post("/api/generate-hint", response_model=GenerateHintResponse)
async def generate_hint(
    body: GenerateHintRequest,
    user: dict = Depends(require_teacher_or_admin),
):
    """
    POST /api/generate-hint
    Guru-only. Takes the quest's title/desc + the internal AI grading
    instruction (`goal`) and asks the LLM to rewrite it as a short,
    student-facing hint — so students never see the raw grading prompt
    verbatim in the quest's hint box.
    """
    try:
        if AI_PROVIDER == "openai":
            hint = await call_openai_hint(body.title, body.subtitle, body.desc, body.goal)
        else:
            hint = await call_gemini_hint(body.title, body.subtitle, body.desc, body.goal)
    except Exception as exc:
        logger.exception("Hint generation failed")
        raise HTTPException(status_code=502, detail=f"AI provider error: {exc}")

    if not hint:
        raise HTTPException(status_code=502, detail="AI returned an empty hint")

    return GenerateHintResponse(hint=hint)


@app.post("/api/projects/save", response_model=ProjectSavedResponse)
async def save_project(
    body: SaveProjectRequest,
    user: dict = Depends(get_current_user),
):
    """
    POST /api/projects/save
    Serialises the full block tree to Firestore under projects/{projectId}.
    Called when the student clicks Save or Run.
    """
    saved_at = datetime.utcnow().isoformat() + "Z"
    doc_data = {
        "project_name": body.project_name,
        "student_id":   body.student_id,
        "blocks":       [b.model_dump() for b in body.blocks],
        "saved_at":     saved_at,
    }
    db.collection("projects").document(body.project_id).set(doc_data, merge=True)
    logger.info("Saved project %s", body.project_id)

    return ProjectSavedResponse(success=True, project_id=body.project_id, saved_at=saved_at)


@app.get("/api/projects/{project_id}")
async def get_project(
    project_id: str,
    user: dict = Depends(get_current_user),
):
    """GET /api/projects/{projectId}  — load a saved program."""
    doc = db.collection("projects").document(project_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Project not found")
    return doc.to_dict()


@app.get("/api/students/{student_id}/assessments")
async def get_student_assessments(
    student_id: str,
    user: dict = Depends(get_current_user),
):
    """GET history of assessments for a student (for the AI dashboard).
    A student can only see their OWN history; only guru/admin can look
    up someone else's — this used to be open to any authenticated user,
    which let any student snoop on any other student's assessment data."""
    if user["uid"] != student_id and get_role(user) not in ("guru", "admin"):
        raise HTTPException(status_code=403, detail="Not allowed to view this student's data")
    try:
        docs = (
            db.collection("assessments")
            .where("student_id", "==", student_id)
            .order_by("assessed_at", direction=firestore.Query.DESCENDING)
            .limit(20)
            .stream()
        )
        return [d.to_dict() for d in docs]
    except Exception as exc:
        # A .where() + .order_by() on different fields needs a Firestore
        # composite index. If it's missing, Firestore raises
        # FailedPrecondition with a console URL to create it in one click —
        # that URL only shows up here, in the server log, never in the
        # HTTP response, so this is the place to look after seeing this
        # error surface in the UI.
        logger.exception(
            "Failed to load assessments for student %s — if this is "
            "FailedPrecondition, check the log line above for a Firestore "
            "console link to create the missing composite index.",
            student_id,
        )
        raise HTTPException(
            status_code=500,
            detail="Gagal memuat riwayat penilaian. Coba lagi beberapa saat lagi.",
        )


# ─────────────────────────────────────────────────────────────
# Roles — Custom Claims (signed into the Firebase ID token, not a
# Firestore field). Only this backend, holding the service-account
# key, can set them. A student can never self-promote by editing a
# document, because there IS no document that grants access — the
# claim only exists inside a token the client can't forge.
# ─────────────────────────────────────────────────────────────
@app.post("/api/auth/register-with-code", response_model=RoleResponse)
async def register_with_code(
    body: RegisterRoleRequest,
    user: dict = Depends(get_current_user),
):
    """
    Called once, right after a NEW Firebase Auth account is created
    (signup), before the account has any role claim yet. Every account
    ends up with an explicit role — 'siswa' by default, or whatever an
    unused invite code grants (currently only 'guru').
    """
    uid = user["uid"]
    email = user.get("email", "")
    role = "siswa"

    if body.invite_code:
        code_ref = db.collection("invite_codes").document(body.invite_code.strip().upper())
        code_doc = code_ref.get()
        if not code_doc.exists:
            raise HTTPException(status_code=400, detail="Kode undangan tidak ditemukan")
        code_data = code_doc.to_dict()
        if not code_data.get("active", False) or code_data.get("used_by"):
            raise HTTPException(status_code=400, detail="Kode undangan sudah dipakai atau tidak aktif")

        role = code_data.get("role", "guru")
        code_ref.update({
            "active":  False,
            "used_by": uid,
            "used_at": datetime.utcnow().isoformat() + "Z",
        })
        logger.info("Invite code %s redeemed by %s -> role=%s", body.invite_code, uid, role)

    auth.set_custom_user_claims(uid, {"role": role})

    # Mirror role+profile into Firestore too — NOT authoritative for
    # access control (the custom claim is), but lets an admin/teacher
    # dashboard query/list users later, which custom claims alone can't do.
    db.collection("users").document(uid).set({
        "uid":        uid,
        "email":      email,
        "role":       role,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }, merge=True)

    return RoleResponse(uid=uid, role=role)


@app.post("/api/auth/create-invite-code", response_model=InviteCodeResponse)
async def create_invite_code(
    body: CreateInviteRequest,
    user: dict = Depends(require_admin),
):
    """Admin-only. Generates a single-use invite code for a 'guru' (or
    'admin') account. The code itself grants nothing on its own — it's
    just a Firestore lookup key; the ACTUAL role only ever gets applied
    via register_with_code() above, through the Admin SDK."""
    if body.role not in ("guru", "admin"):
        raise HTTPException(status_code=400, detail="Kode undangan hanya untuk role 'guru' atau 'admin'")

    code = secrets.token_hex(4).upper()  # e.g. "A1B2C3D4" — short enough to type/share
    created_at = datetime.utcnow().isoformat() + "Z"
    db.collection("invite_codes").document(code).set({
        "code":       code,
        "role":       body.role,
        "note":       body.note,
        "created_by": user["uid"],
        "created_at": created_at,
        "active":     True,
        "used_by":    None,
        "used_at":    None,
    })
    logger.info("Invite code %s created by admin %s for role=%s", code, user["uid"], body.role)

    return InviteCodeResponse(code=code, role=body.role, created_by=user["uid"], created_at=created_at)


@app.get("/api/auth/invite-codes")
async def list_invite_codes(user: dict = Depends(require_admin)):
    """Admin-only. Lists all invite codes (used and unused) for management."""
    docs = db.collection("invite_codes").order_by(
        "created_at", direction=firestore.Query.DESCENDING
    ).limit(100).stream()
    return [d.to_dict() for d in docs]


@app.delete("/api/auth/invite-codes/{code}")
async def delete_invite_code(code: str, user: dict = Depends(require_admin)):
    """Admin-only. Deletes an invite code — whether it was ever used or
    not. Deleting a USED code does NOT revoke the role it already
    granted (that would need a separate set-role call); it only stops
    the code itself from showing up / being reusable."""
    code_ref = db.collection("invite_codes").document(code.strip().upper())
    if not code_ref.get().exists:
        raise HTTPException(status_code=404, detail="Kode tidak ditemukan")
    code_ref.delete()
    logger.info("Admin %s deleted invite code %s", user["uid"], code)
    return {"success": True, "code": code}


# ─────────────────────────────────────────────────────────────
# Guru dashboard
# ─────────────────────────────────────────────────────────────
@app.get("/api/students", response_model=list[StudentSummary])
async def list_students(user: dict = Depends(require_teacher_or_admin)):
    """
    Guru/Admin-only. All students + their quest progress, for the
    teacher dashboard's student list. Assessment history is fetched
    separately per-student via /api/students/{id}/assessments (already
    existed) when a teacher drills into one student.

    NOTE: this returns EVERY student in the system — there's no
    class/section concept yet, so any guru currently sees all of them.
    """
    students_docs = db.collection("users").where("role", "==", "siswa").stream()
    result = []
    for s in students_docs:
        data = s.to_dict()
        uid = data.get("uid", s.id)
        progress_docs = db.collection("quest_progress").where("student_id", "==", uid).stream()
        progress = {}
        for p in progress_docs:
            p_data = p.to_dict()
            quest_id = p_data.get("quest_id")
            if quest_id:
                progress[quest_id] = p_data
        result.append(StudentSummary(uid=uid, email=data.get("email", ""), quest_progress=progress))
    return result


# ─────────────────────────────────────────────────────────────
# Admin dashboard
# ─────────────────────────────────────────────────────────────
@app.get("/api/admin/users", response_model=list[UserSummary])
async def list_all_users(user: dict = Depends(require_admin)):
    """Admin-only. Every user in the system + their current role."""
    docs = db.collection("users").stream()
    return [
        UserSummary(
            uid=(d.to_dict().get("uid", d.id)),
            email=d.to_dict().get("email", ""),
            role=d.to_dict().get("role", "siswa"),
            updated_at=d.to_dict().get("updated_at"),
        )
        for d in docs
    ]


@app.post("/api/admin/set-role", response_model=RoleResponse)
async def set_role(
    body: SetRoleRequest,
    user: dict = Depends(require_admin),
):
    """
    Admin-only. Directly promote/demote a user's role — no invite code
    needed here since the caller is already a verified admin. Same
    Custom Claims mechanism as register_with_code().
    """
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Role harus salah satu dari: {', '.join(VALID_ROLES)}")
    if body.uid == user["uid"] and body.role != "admin":
        raise HTTPException(status_code=400, detail="Tidak bisa menurunkan role akunmu sendiri")

    auth.set_custom_user_claims(body.uid, {"role": body.role})
    db.collection("users").document(body.uid).set({
        "role":       body.role,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }, merge=True)
    logger.info("Admin %s set role of %s to %s", user["uid"], body.uid, body.role)

    return RoleResponse(uid=body.uid, role=body.role)


# ─────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)