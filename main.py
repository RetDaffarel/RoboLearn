# RoboLearn — main.py
# MicroPython BLE UART Server for ESP32
#
# Upload via Thonny: Tools → Upload current script as main.py
#
# Hardware pin map (adjust to your wiring):
#   Left  motor PWM  : GPIO 14 (speed)
#   Left  motor DIR  : GPIO 12 (direction)
#   Right motor PWM  : GPIO 27 (speed)
#   Right motor DIR  : GPIO 26 (direction)
#   NeoPixel LED     : GPIO 5
#   Buzzer (passive) : GPIO 18
#   Ultrasonic TRIG  : GPIO 22
#   Ultrasonic ECHO  : GPIO 23
#   Gripper servo    : GPIO 13 (SG90, standard 50Hz hobby servo signal)
#   Line sensor LEFT : GPIO 34 (digital IR reflectance, input-only ADC pin)
#   Line sensor RIGHT: GPIO 35 (digital IR reflectance, input-only ADC pin)
#
# Command token format (semicolon-delimited):
#   FWD:<speed%>   — move forward  (0-100)
#   BWD:<speed%>   — move backward (0-100)
#   TRR:<deg>      — turn right N degrees (approx)
#   TRL:<deg>      — turn left  N degrees (approx)
#   STP            — stop all motors
#   LED:<color>    — set NeoPixel colour (RED/GRN/BLU/YLW/WHT/OFF)
#   DLY:<ms>       — wait milliseconds
#   SND:<note>:<ms>— play tone (note e.g. C4, A4) for duration ms
#   PING           — respond with sensor distance
#   SRV:<0-180>    — move the gripper servo to this angle. Blocking for
#                    ~400ms so the servo physically finishes moving before
#                    the next token runs — a real SG90 isn't instant like
#                    an LED, it needs travel time.
#   LINE           — respond with current line sensor state, e.g. "LINE:1,0"
#                    (left=1/on-line, right=0/off-line)
#   FOL:<ms>       — follow-the-line closed loop for <ms> milliseconds:
#                    reads both IR sensors every ~30ms and steers by
#                    slowing the inner wheel. Blocking (see IFLT/IFEND
#                    note below for why nothing here is truly async) but
#                    bounded by <ms>, so — unlike `forever` — this one
#                    has a real, honest stopping point.
#   IFLT:<cm>      — read ultrasonic distance now; if it is NOT < <cm>
#                    (or the sensor timed out), skip every token up to
#                    the next ELSE at this level (running that branch
#                    instead) or, if there's no ELSE, up to and including
#                    the matching IFEND. Supports nesting.
#   IFLINE         — read both line sensors now; true if EITHER is
#                    currently on the line. Same skip/ELSE/IFEND
#                    behaviour as IFLT, just a different condition.
#   ELSE           — flips which branch of the innermost open IFLT/IFLINE
#                    is currently running. Optional — an IFLT/IFLINE with
#                    no ELSE before its IFEND behaves exactly as before
#                    (old command strings with no ELSE still work as-is).
#   IFEND          — marks the end of an IFLT/IFLINE (+ optional ELSE)
#                    block. No-op on its own.
#
# NOTE on IFLT/IFLINE/ELSE/IFEND: this is a synchronous, single-threaded
# interpreter — the whole command string is one blocking pass with no way
# for the browser to intervene mid-run. That's fine for a conditional (a
# sensor read is a few ms), but it's why there's no true "forever" token: an
# unbounded loop in here would hang BLE processing with no way to stop it. The
# editor's `forever` block is unrolled into a capped repeat client-side
# instead — see Front/bluetooth.js.

import bluetooth
import struct
import time
import machine
from machine import Pin, PWM, time_pulse_us

# ── Optional: NeoPixel ───────────────────────────────────────────────────────
try:
    import neopixel
    NUM_LEDS = 4
    np = neopixel.NeoPixel(Pin(5), NUM_LEDS)
    HAS_NEOPIXEL = True
except ImportError:
    HAS_NEOPIXEL = False

# ── BLE UUIDs (Nordic UART Service) ─────────────────────────────────────────
_NUS_UUID  = bluetooth.UUID('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')
_RX_UUID   = bluetooth.UUID('6E400002-B5A3-F393-E0A9-E50E24DCCA9E')  # Browser → ESP32
_TX_UUID   = bluetooth.UUID('6E400003-B5A3-F393-E0A9-E50E24DCCA9E')  # ESP32 → Browser

_FLAG_WRITE   = bluetooth.FLAG_WRITE | bluetooth.FLAG_WRITE_NO_RESPONSE
_FLAG_NOTIFY  = bluetooth.FLAG_NOTIFY | bluetooth.FLAG_READ

_UART_SERVICE = (
    _NUS_UUID,
    (
        (_RX_UUID, _FLAG_WRITE),
        (_TX_UUID, _FLAG_NOTIFY),
    ),
)

# ── Hardware setup ───────────────────────────────────────────────────────────
# Left motor
L_PWM = PWM(Pin(14), freq=1000); L_PWM.duty(0)
L_DIR = Pin(12, Pin.OUT); L_DIR.value(0)

# Right motor
R_PWM = PWM(Pin(27), freq=1000); R_PWM.duty(0)
R_DIR = Pin(26, Pin.OUT); R_DIR.value(0)

# Ultrasonic
TRIG = Pin(22, Pin.OUT)
ECHO = Pin(23, Pin.IN)

# Buzzer
BUZZER = PWM(Pin(18), freq=440); BUZZER.duty(0)

# Gripper servo (SG90) — standard hobby servo, 50Hz signal
SERVO_PIN   = 13
SERVO_PWM   = PWM(Pin(SERVO_PIN), freq=50)
GRIPPER_OPEN_ANGLE  = 150
GRIPPER_CLOSE_ANGLE = 30
GRIPPER_REST_ANGLE  = 90

# Line follower — 2x digital IR reflectance sensors
LINE_L = Pin(34, Pin.IN)
LINE_R = Pin(35, Pin.IN)
LINE_FOLLOW_SPEED = 40  # base motor speed (%) while following

# Note → frequency table (subset)
NOTE_FREQ = {
    'C4': 261, 'D4': 293, 'E4': 329, 'F4': 349,
    'G4': 392, 'A4': 440, 'B4': 493,
    'C5': 523, 'D5': 587, 'E5': 659,
}

# Colour lookup (R, G, B)
LED_COLOURS = {
    'RED': (200, 0,   0),
    'GRN': (0,   200, 0),
    'BLU': (0,   0,   200),
    'YLW': (200, 150, 0),
    'WHT': (200, 200, 200),
    'OFF': (0,   0,   0),
}

# ── Motor helpers ────────────────────────────────────────────────────────────
def _duty(pct):
    """Convert 0-100% → 0-1023 duty cycle."""
    return int(max(0, min(100, pct)) * 1023 / 100)

def motors_forward(speed):
    L_DIR.value(0); R_DIR.value(0)
    L_PWM.duty(_duty(speed)); R_PWM.duty(_duty(speed))

def motors_backward(speed):
    L_DIR.value(1); R_DIR.value(1)
    L_PWM.duty(_duty(speed)); R_PWM.duty(_duty(speed))

def motors_stop():
    L_PWM.duty(0); R_PWM.duty(0)

def turn_right(degrees, speed=40):
    # Approximate: tune TURN_MS_PER_DEG for your robot geometry
    TURN_MS_PER_DEG = 5.5
    L_DIR.value(0); R_DIR.value(1)  # left fwd, right back
    L_PWM.duty(_duty(speed)); R_PWM.duty(_duty(speed))
    time.sleep_ms(int(degrees * TURN_MS_PER_DEG))
    motors_stop()

def turn_left(degrees, speed=40):
    TURN_MS_PER_DEG = 5.5
    L_DIR.value(1); R_DIR.value(0)
    L_PWM.duty(_duty(speed)); R_PWM.duty(_duty(speed))
    time.sleep_ms(int(degrees * TURN_MS_PER_DEG))
    motors_stop()

# ── LED / Buzzer helpers ─────────────────────────────────────────────────────
def set_led(colour_code):
    if not HAS_NEOPIXEL:
        return
    rgb = LED_COLOURS.get(colour_code.upper(), (0, 0, 0))
    for i in range(NUM_LEDS):
        np[i] = rgb
    np.write()

def play_note(note, duration_ms):
    freq = NOTE_FREQ.get(note.upper(), 440)
    BUZZER.freq(freq)
    BUZZER.duty(512)
    time.sleep_ms(duration_ms)
    BUZZER.duty(0)

# ── Servo (gripper) ──────────────────────────────────────────────────────────
def set_servo_angle(angle):
    """Move the SG90 to `angle` degrees (0-180). SG90s expect a 0.5ms-2.5ms
    pulse width at 50Hz (20ms period); this converts that into the ESP32's
    10-bit PWM duty (0-1023)."""
    angle = max(0, min(180, angle))
    pulse_us = 500 + (2500 - 500) * angle / 180   # 0.5ms .. 2.5ms
    duty = int(pulse_us / 20000 * 1023)             # 20ms period @ 50Hz
    SERVO_PWM.duty(duty)

# ── Ultrasonic ───────────────────────────────────────────────────────────────
def read_distance_cm():
    TRIG.value(0); time.sleep_us(2)
    TRIG.value(1); time.sleep_us(10)
    TRIG.value(0)
    duration = time_pulse_us(ECHO, 1, 30000)  # 30ms timeout
    if duration < 0:
        return -1
    return round(duration / 58.0, 1)

# ── Line follower ────────────────────────────────────────────────────────────
def read_line_sensors():
    """Returns (left_on_line, right_on_line) booleans.
    NOTE: most IR reflectance modules are active-LOW (pin reads 0 when
    looking at the dark line, 1 over a light floor). Flip the `== 0`
    checks below if your particular module reports the opposite."""
    left_on_line  = (LINE_L.value() == 0)
    right_on_line = (LINE_R.value() == 0)
    return left_on_line, right_on_line

def follow_line(duration_ms):
    """Closed-loop line following for `duration_ms`. Steers by slowing the
    inner wheel rather than pivoting, so it's a smooth curve, not a jerky
    turn. If both sensors lose the line, it stops rather than guessing."""
    L_DIR.value(0); R_DIR.value(0)  # both wheels forward-facing for the whole loop
    start = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), start) < duration_ms:
        l, r = read_line_sensors()
        if l and r:
            L_PWM.duty(_duty(LINE_FOLLOW_SPEED)); R_PWM.duty(_duty(LINE_FOLLOW_SPEED))
        elif l and not r:
            # line has drifted toward the left sensor -> ease left
            L_PWM.duty(_duty(LINE_FOLLOW_SPEED // 3)); R_PWM.duty(_duty(LINE_FOLLOW_SPEED))
        elif r and not l:
            L_PWM.duty(_duty(LINE_FOLLOW_SPEED)); R_PWM.duty(_duty(LINE_FOLLOW_SPEED // 3))
        else:
            motors_stop()  # line lost entirely — stop rather than drive blind
        time.sleep_ms(30)
    motors_stop()

# ── Command parser ───────────────────────────────────────────────────────────
def handle_command(cmd_str, ble_send):
    """
    Parse a semicolon-delimited command string and execute each token.
    ble_send(msg) sends a reply string back to the browser.
    """
    tokens = [t.strip() for t in cmd_str.strip().split(';') if t.strip()]
    print('[CMD]', tokens)

    # Stack of dicts, one per currently-open IFLT/IFLINE block (top = innermost).
    #   'skip'       -> True while we should NOT execute tokens right now
    #                   (either the condition was false and we haven't hit
    #                   ELSE yet, or it was true and we're now past ELSE)
    #   'suppressed' -> True if this IF is nested inside an ALREADY-skipped
    #                   outer branch, meaning its own condition was never
    #                   really evaluated (no sensor read happened for it) —
    #                   its matching ELSE must therefore also stay a no-op,
    #                   rather than flipping 'skip' based on a fake result.
    if_stack = []

    for token in tokens:
        parts = token.split(':')
        op    = parts[0].upper()
        args  = parts[1:] if len(parts) > 1 else []

        currently_skipping = any(f['skip'] for f in if_stack)

        # IFLT/IFLINE/ELSE/IFEND are handled first and unconditionally,
        # since they're what controls if_stack itself (they must run even
        # while skipping, so nested if-blocks inside a false branch still
        # open/close correctly and don't leak into the parent's state).
        if op == 'IFLT':
            if currently_skipping:
                if_stack.append({'skip': True, 'suppressed': True})
                continue
            threshold = float(args[0]) if args else 20
            dist = read_distance_cm()
            condition_true = (dist >= 0) and (dist < threshold)
            if_stack.append({'skip': not condition_true, 'suppressed': False})
            continue

        if op == 'IFLINE':
            if currently_skipping:
                if_stack.append({'skip': True, 'suppressed': True})
                continue
            left_on_line, right_on_line = read_line_sensors()
            condition_true = left_on_line or right_on_line
            if_stack.append({'skip': not condition_true, 'suppressed': False})
            continue

        if op == 'ELSE':
            if not if_stack:
                continue  # malformed command string (ELSE with no matching IF) — ignore
            frame = if_stack[-1]
            if not frame['suppressed']:
                frame['skip'] = not frame['skip']  # flip: true-branch done -> skip else; false-branch skipped -> run else
            continue

        if op == 'IFEND':
            if if_stack:
                if_stack.pop()
            continue

        if currently_skipping:
            continue   # inside a false IF/ELSE branch — skip everything else

        if op == 'FWD':
            speed = int(args[0]) if args else 50
            motors_forward(speed)

        elif op == 'BWD':
            speed = int(args[0]) if args else 50
            motors_backward(speed)

        elif op == 'TRR':
            deg = int(args[0]) if args else 90
            turn_right(deg)

        elif op == 'TRL':
            deg = int(args[0]) if args else 90
            turn_left(deg)

        elif op == 'STP':
            motors_stop()

        elif op == 'LED':
            colour = args[0] if args else 'OFF'
            set_led(colour)

        elif op == 'DLY':
            ms = int(args[0]) if args else 1000
            motors_stop()          # safety: stop before waiting
            time.sleep_ms(ms)

        elif op == 'SND':
            note = args[0] if args else 'A4'
            dur  = int(args[1]) if len(args) > 1 else 500
            play_note(note, dur)

        elif op == 'PING':
            dist = read_distance_cm()
            ble_send(f'DIST:{dist}\n')

        elif op == 'SRV':
            angle = int(args[0]) if args else GRIPPER_REST_ANGLE
            set_servo_angle(angle)
            time.sleep_ms(400)   # let the SG90 physically finish travelling

        elif op == 'LINE':
            l, r = read_line_sensors()
            ble_send(f'LINE:{1 if l else 0},{1 if r else 0}\n')

        elif op == 'FOL':
            ms = int(args[0]) if args else 3000
            follow_line(ms)

        else:
            print('[WARN] Unknown command:', op)

    # Signal that all commands are done
    ble_send('DONE\n')

# ── BLE GATT Server ──────────────────────────────────────────────────────────
class BLEUART:
    def __init__(self, ble, name='RoboCore+'):
        self._ble       = ble
        self._connected = False
        self._conn_handle = None
        self._buffer    = bytearray()

        ble.active(True)
        ble.irq(self._irq)

        # Register services
        ((self._rx_handle, self._tx_handle),) = ble.gatts_register_services((_UART_SERVICE,))

        # Advertise
        self._advertise(name)
        print(f'[BLE] Advertising as "{name}"...')

    def _advertise(self, name):
        adv_data = bytearray()
        # Flags: LE General Discoverable + BR/EDR Not Supported
        adv_data += b'\x02\x01\x06'
        # Complete Local Name
        name_b = name.encode()
        adv_data += bytes([len(name_b) + 1, 0x09]) + name_b
        self._ble.gap_advertise(100_000, adv_data=adv_data)

    def _irq(self, event, data):
        if event == 1:   # _IRQ_CENTRAL_CONNECT
            self._conn_handle, _, _ = data
            self._connected = True
            self._ble.gap_advertise(None)   # stop advertising
            print('[BLE] Connected')

        elif event == 2: # _IRQ_CENTRAL_DISCONNECT
            self._conn_handle = None
            self._connected   = False
            self._buffer      = bytearray()
            self._advertise('RoboCore+')
            print('[BLE] Disconnected — re-advertising')

        elif event == 3: # _IRQ_GATTS_WRITE
            buf = self._ble.gatts_read(self._rx_handle)
            if buf:
                self._buffer.extend(buf)
                # Process complete lines (terminated with \n)
                while b'\n' in self._buffer:
                    line, self._buffer = self._buffer.split(b'\n', 1)
                    cmd = line.decode('utf-8', 'ignore').strip()
                    if cmd:
                        handle_command(cmd, self.send)

    def send(self, msg):
        if self._connected and self._conn_handle is not None:
            try:
                data = msg.encode() if isinstance(msg, str) else msg
                self._ble.gatts_notify(self._conn_handle, self._tx_handle, data)
            except Exception as e:
                print('[BLE] Send error:', e)

    @property
    def connected(self):
        return self._connected

# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    set_led('OFF')
    set_servo_angle(GRIPPER_REST_ANGLE)
    ble  = bluetooth.BLE()
    uart = BLEUART(ble, name='RoboCore+')

    # Blink LED blue while waiting for connection
    blink_state = False
    last_blink  = time.ticks_ms()
    BLINK_MS    = 500

    print('[RoboLearn] Ready. Waiting for Bluetooth connection...')

    while True:
        now = time.ticks_ms()

        if not uart.connected:
            # Blink blue to show advertising
            if time.ticks_diff(now, last_blink) >= BLINK_MS:
                blink_state = not blink_state
                set_led('BLU' if blink_state else 'OFF')
                last_blink = now
        else:
            # Solid green when connected
            set_led('GRN')

        time.sleep_ms(50)

main()