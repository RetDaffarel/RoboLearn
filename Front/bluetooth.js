/**
 * RoboLearn — bluetooth.js
 *
 * Web Bluetooth API wrapper for ESP32 BLE UART (Nordic UART Service).
 *
 * Usage:
 *   import RoboBLE from './bluetooth.js';
 *
 *   const robot = new RoboBLE();
 *   await robot.connect();          // opens browser Bluetooth picker
 *   await robot.sendCommand('FWD:50;TRN:90;LED:GRN;');
 *   robot.onData(raw => console.log('From robot:', raw));
 *   await robot.disconnect();
 */

// ── Nordic UART Service (NUS) UUIDs ──────────────────────────────────────────
const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify (ESP32 → Browser)
const NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // WriteWithoutResponse (Browser → ESP32)

/**
 * Simple additive checksum over a string's UTF-8 bytes, as 4 hex digits.
 * Must match checksum16() in main.py exactly — both sides compute it the
 * same way so the firmware can detect a corrupted line before executing
 * it (observed in the wild: BLE glitches mangling/duplicating bytes
 * mid-transit even with acknowledged writes).
 */
function checksum16(str) {
    const bytes = new TextEncoder().encode(str);
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xFFFF;
    return sum.toString(16).padStart(4, '0');
}

export class RoboBLE extends EventTarget {
    constructor() {
        super();
        this._device      = null;
        this._server      = null;
        this._rxChar      = null;   // write to robot
        this._txChar      = null;   // notifications from robot
        this._connected   = false;
        this._encoder     = new TextEncoder();
        this._decoder     = new TextDecoder();
        this._mtu         = 20;     // safe BLE packet size for ESP32
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /** Opens the browser's Bluetooth device picker and connects. */
    async connect() {
        if (!navigator.bluetooth) {
            throw new Error(
                'Web Bluetooth is not available. Use Chrome/Edge on desktop, or Chrome for Android.'
            );
        }

        this._device = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'RoboCore+' }],
            // Uncomment to show ANY BLE device (useful during dev):
            // acceptAllDevices: true,
            optionalServices: [NUS_SERVICE_UUID],
        });

        this._device.addEventListener('gattserverdisconnected', () => this._onDisconnected());

        this._server = await this._device.gatt.connect();

        const service  = await this._server.getPrimaryService(NUS_SERVICE_UUID);
        this._rxChar   = await service.getCharacteristic(NUS_RX_CHAR_UUID);
        this._txChar   = await service.getCharacteristic(NUS_TX_CHAR_UUID);

        // Subscribe to notifications from the ESP32 (e.g. sensor readings)
        await this._txChar.startNotifications();
        this._txChar.addEventListener('characteristicvaluechanged', e => {
            const raw = this._decoder.decode(e.target.value);
            this.dispatchEvent(new CustomEvent('data', { detail: raw }));
        });

        this._connected = true;
        this.dispatchEvent(new CustomEvent('connected', { detail: this._device.name }));
        console.log('[RoboBLE] Connected to', this._device.name);
    }

    /** Disconnect gracefully. */
    async disconnect() {
        if (this._device && this._device.gatt.connected) {
            await this._device.gatt.disconnect();
        }
    }

    /**
     * Send a raw command string to the ESP32.
     * Strings longer than the MTU are automatically chunked.
     * @param {string} commandStr  e.g. "FWD:50;TRN:90;LED:GRN;"
     */
    async sendCommand(commandStr) {
        if (!this._connected || !this._rxChar) {
            throw new Error('Not connected. Call connect() first.');
        }

        const encoded = this._encoder.encode(commandStr);

        // Chunk into MTU-sized packets.
        // writeValueWithResponse (not WithoutResponse) on purpose: without
        // response is fire-and-forget, and under load the OS/BLE stack can
        // silently drop a chunk — no error, just missing bytes on the
        // ESP32 side, which showed up as mangled tokens like "TRR:90"
        // arriving as just "30". WithResponse waits for the peripheral to
        // ack each chunk before the next is sent, so nothing gets lost;
        // the trade-off is it's a bit slower, which is fine here since a
        // full program is only sent once per Run, not per animation frame.
        for (let offset = 0; offset < encoded.byteLength; offset += this._mtu) {
            const chunk = encoded.slice(offset, offset + this._mtu);
            await this._rxChar.writeValueWithResponse(chunk);
        }

        console.log('[RoboBLE] Sent:', commandStr);
    }

    /**
     * Convenience method: register a callback for data arriving from the ESP32.
     * @param {(raw: string) => void} callback
     */
    onData(callback) {
        this.addEventListener('data', e => callback(e.detail));
    }

    get connected() { return this._connected; }
    get deviceName() { return this._device?.name ?? null; }

    // ── Block-to-Command compiler ──────────────────────────────────────────────

    /**
     * Convert a flat or nested array of block objects (from the editor) into
     * the compact token string understood by the ESP32 MicroPython script.
     *
     * Block schema:
     *   { type: 'move_forward',    params: { speed: 50 } }
     *   { type: 'turn_right',      params: { degrees: 90 } }
     *   { type: 'set_led',         params: { color: 'green' } }
     *   { type: 'wait',            params: { seconds: 1 } }
     *   { type: 'play_sound',      params: { note: 'C4', duration: 500 } }
     *   { type: 'repeat',          params: { times: 4 }, children: [...] }
     *   { type: 'if',              params: { threshold: 20 }, children: [...] }
     *     — runs `children` only if the live ultrasonic distance < threshold
     *   { type: 'if_line',         params: {}, children: [...] }
     *     — runs `children` only if either line sensor currently sees the line
     *   { type: 'else',            params: {}, children: [...] }
     *     — false-branch for whichever `if`/`if_line` is its IMMEDIATE
     *       previous sibling (checked by array position, not nesting — the
     *       block editor has no dual-body block shape, so if/else is two
     *       adjacent single-body C-blocks rather than one block with two
     *       slots). An `else` with no matching if/if_line right before it
     *       compiles to nothing and is reported via `unsupported`.
     *   { type: 'forever',         params: {}, children: [...] }
     *     — NOT truly infinite: the firmware executes one blocking command
     *       string with no way for the browser to interrupt it mid-run, so
     *       this is unrolled into FOREVER_CAP repeats client-side instead.
     *       See the `forever`-related note in main.py for why.
     *   { type: 'sensor_ping',     params: {} }
     *     — sends PING; firmware replies with a `DIST:<cm>` notification.
     *   { type: 'gripper_open',    params: {} }
     *   { type: 'gripper_close',   params: {} }
     *     — moves the SG90 gripper servo to a preset angle. Blocking
     *       ~400ms firmware-side so the servo physically finishes moving.
     *   { type: 'follow_line',     params: { seconds: 3 } }
     *     — closed-loop line following, entirely on the firmware (it needs
     *       to react every ~30ms, far faster than a BLE round-trip to the
     *       browser could keep up with). Bounded by `seconds`, unlike
     *       `forever` this has an honest, real stopping point.
     *   { type: 'sensor_line',     params: {} }
     *     — sends LINE; firmware replies with e.g. `LINE:1,0` (left,right).
     *
     * Block types with no compiler support yet (rendered in the editor but
     * produce no robot command): op_add, op_sub, op_mul, op_div, op_eq,
     * op_neq, op_gt, op_lt, op_gte, op_lte, op_and, op_or, op_not, var_set,
     * var_change — these need a variable/expression engine, which is a
     * separate, bigger piece of work than this compiler.
     *
     * @param {Array}  blocks  - flat or nested block list
     * @param {number} [repeatCount=1]
     * @returns {{ commandStr: string, unsupported: string[], foreverCapped: boolean }}
     */
    static compileBlocks(blocks, repeatCount = 1) {
        const FOREVER_CAP = 10; // see class-level docstring above for why this isn't infinite

        const tokens = [];
        const unsupportedTypes = new Set();
        let foreverCapped = false;

        const compile = (blockList) => {
            for (let i = 0; i < blockList.length; i++) {
                const block = blockList[i];
                switch (block.type) {
                    case "move_forward":
                        tokens.push(`FWD:${block.params.speed || 50}`);
                        break;

                    case "move_backward":
                        tokens.push(`BWD:${block.params.speed || 50}`);
                        break;

                    case "turn_right":
                        tokens.push(`TRR:${block.params.angle || 90}`);
                        break;

                    case "turn_left":
                        tokens.push(`TRL:${block.params.angle || 90}`);
                        break;

                    case "stop":
                        tokens.push("STP");
                        break;

                    case "delay":
                        tokens.push(`DLY:${block.params.time || 1000}`);
                        break;

                    case "servo":
                        tokens.push(`SRV:${block.params.angle || 90}`);
                        break;
                    case 'set_led': {
                        const colorMap = {
                            red: 'RED', green: 'GRN', blue: 'BLU',
                            yellow: 'YLW', white: 'WHT', off: 'OFF',
                        };
                        const c = colorMap[block.params.color?.toLowerCase()] ?? 'OFF';
                        tokens.push(`LED:${c}`);
                        break;
                    }
                    case 'wait': {
                        const ms = Math.round((block.params.seconds ?? 1) * 1000);
                        tokens.push(`DLY:${ms}`);
                        break;
                    }
                    case 'play_sound':
                        tokens.push(`SND:${block.params.note ?? 'C4'}:${block.params.duration ?? 500}`);
                        break;
                    case 'repeat': {
                        const n = block.params.times ?? 1;
                        for (let r = 0; r < n; r++) {
                            if (block.children?.length) compile(block.children);
                        }
                        break;
                    }
                    case 'if':
                    case 'if_line': {
                        // Real conditional: the firmware reads the sensor live and
                        // skips the body between IF.../IFEND if it's not satisfied.
                        // An `else` block sitting as this block's VERY NEXT SIBLING
                        // (checked here, not nested inside it — the editor has no
                        // dual-body block shape, so if/else is modelled as two
                        // adjacent single-body C-blocks instead) becomes the false
                        // branch, compiled between an ELSE token and IFEND.
                        if (block.type === 'if') {
                            tokens.push(`IFLT:${block.params.threshold ?? 20}`);
                        } else {
                            tokens.push('IFLINE');
                        }
                        if (block.children?.length) compile(block.children);

                        const next = blockList[i + 1];
                        if (next && next.type === 'else') {
                            tokens.push('ELSE');
                            if (next.children?.length) compile(next.children);
                            i++; // consume the else block too — don't let the outer loop hit it again
                        }
                        tokens.push('IFEND');
                        break;
                    }
                    case 'else':
                        // Reaching here means an `else` was found WITHOUT an if/if_line
                        // immediately before it (the paired case is consumed above via
                        // the `i++` lookahead) — it's a misplaced/dangling else with
                        // nothing to attach to, so flag it rather than silently compiling
                        // its body unconditionally.
                        unsupportedTypes.add('else (tanpa blok if sebelumnya)');
                        break;
                    case 'forever': {
                        // See docstring: capped, not infinite. Flagged via foreverCapped
                        // so the caller can tell the student what actually happened.
                        foreverCapped = true;
                        for (let r = 0; r < FOREVER_CAP; r++) {
                            if (block.children?.length) compile(block.children);
                        }
                        break;
                    }
                    case 'sensor_ping':
                        tokens.push('PING');
                        break;
                    case 'gripper_open':
                        tokens.push('SRV:150'); // must match GRIPPER_OPEN_ANGLE in main.py
                        break;
                    case 'gripper_close':
                        tokens.push('SRV:30');  // must match GRIPPER_CLOSE_ANGLE in main.py
                        break;
                    case 'follow_line': {
                        const ms = Math.round((block.params.seconds ?? 3) * 1000);
                        tokens.push(`FOL:${ms}`);
                        break;
                    }
                    case 'sensor_line':
                        tokens.push('LINE');
                        break;
                    default:
                        unsupportedTypes.add(block.type);
                        console.warn('[RoboBLE] Block type not yet supported by the compiler:', block.type);
                }
            }
        };

        for (let i = 0; i < repeatCount; i++) {
            compile(blocks);
        }

        // Terminate with a newline so ESP32 readline() works, and append
        // a checksum so the firmware can detect a corrupted line (see
        // checksum16 above) before executing it instead of after.
        const body = tokens.join(';') + ';';
        return {
            commandStr:    `${body}#${checksum16(body)}\n`,
            unsupported:   Array.from(unsupportedTypes),
            foreverCapped,
        };
    }

    // ── Private ────────────────────────────────────────────────────────────────

    _onDisconnected() {
        this._connected = false;
        this._rxChar    = null;
        this._txChar    = null;
        this.dispatchEvent(new CustomEvent('disconnected'));
        console.log('[RoboBLE] Disconnected');
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default RoboBLE;


// ── Standalone React hook (if using React) ───────────────────────────────────
/*
import { useState, useRef, useCallback } from 'react';

export function useRoboBLE() {
    const robotRef = useRef(new RoboBLE());
    const [connected, setConnected] = useState(false);
    const [deviceName, setDeviceName] = useState(null);
    const [lastData, setLastData] = useState('');

    const connect = useCallback(async () => {
        const robot = robotRef.current;
        robot.addEventListener('connected',    e  => { setConnected(true);  setDeviceName(e.detail); });
        robot.addEventListener('disconnected', () => { setConnected(false); setDeviceName(null); });
        robot.onData(raw => setLastData(raw));
        await robot.connect();
    }, []);

    const runBlocks = useCallback(async (blocks) => {
        const cmd = RoboBLE.compileBlocks(blocks);
        await robotRef.current.sendCommand(cmd);
    }, []);

    const disconnect = useCallback(() => robotRef.current.disconnect(), []);

    return { connect, disconnect, runBlocks, connected, deviceName, lastData };
}
*/