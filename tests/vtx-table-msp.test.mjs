// Tests js/vtxTableMsp.js (VTX table load and save over MSP) against an in-memory
// stand-in for the flight controller that answers the way the fork firmware does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { makeHarness } from './helpers/harness.mjs';
import { vtxTableFromBetaflightJson } from '../js/vtxTable.js';

const { repoRoot, rewriteAndWrite } = makeHarness(import.meta.url, 'vtx-table-msp.test.mjs', 'vtx-table-msp-');

function dataModule(code) {
    const encoded = encodeURIComponent(code).replace(/['()!*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return 'data:text/javascript,' + encoded;
}

// MSP and FC stand-ins live on globalThis so each test can swap them. The stub modules are
// evaluated once and cached, so they forward to whatever is current at call time.
globalThis.__vtxTest = { MSP: null, FC: null };
const mspUrl = dataModule(`
    export default {
        send_message(...args) { return globalThis.__vtxTest.MSP.send_message(...args); },
        get unsupported() { return globalThis.__vtxTest.MSP.unsupported; },
    };
`);
const fcUrl = dataModule(`
    export default {
        get VTXTABLE() { return globalThis.__vtxTest.FC.VTXTABLE; },
    };
`);
const codesUrl = pathToFileURL(join(repoRoot, 'js/msp/MSPCodes.js')).href;
const tableUrl = pathToFileURL(join(repoRoot, 'js/vtxTable.js')).href;

const CODES = {
    BAND: 137, POWER: 138, SET_BAND: 227, SET_POWER: 228, CONFIG: 0x2F00, SET_CONFIG: 0x2F01,
};

// A flight controller that stores a table the way the firmware does (padded names, 0 = unused)
class FakeFlightController {
    constructor({ supported = true, refuse = [] } = {}) {
        this.supported = supported;
        this.refuse = refuse;
        this.bands = [];
        this.levels = [];
        this.channels = 0;
        this.log = [];
        this.unsupported = 0;
        this.inFlight = 0;
        this.maxInFlight = 0;
    }

    // Same signature as MSP.send_message(code, data, callback_sent, callback_msp)
    send_message(code, data, sent, callback) {
        const payload = data || [];
        this.log.push(code);
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        setTimeout(() => {
            const reply = this.supported && !this.refuse.includes(code) ? this.handle(code, payload) : null;
            this.unsupported = reply === null ? 1 : 0;
            const bytes = Uint8Array.from(reply || []);
            this.inFlight--;
            callback({ command: code, data: new DataView(bytes.buffer), length: bytes.length });
            this.unsupported = 0;
        }, 0);
        return true;
    }

    handle(code, p) {
        const pad = (text, length) => Array.from(text.padEnd(length, ' ')).map(c => c.charCodeAt(0));
        switch (code) {
            case CODES.CONFIG:
                return [this.bands.length, this.channels, this.levels.length, 8, 8, 8, 8, 3, 9999 & 0xFF, 9999 >> 8];
            case CODES.SET_CONFIG:
                if (p[0] > 8 || p[1] > 8 || p[2] > 8) return null;
                this.bands = Array.from({ length: p[0] }, (_, i) => (p[3] ? null : this.bands[i]) ||
                    { name: 'BAND' + (i + 1), letter: String(i + 1), factory: 0, freqs: new Array(p[1]).fill(0) });
                this.channels = p[1];
                this.levels = Array.from({ length: p[2] }, (_, i) => (p[3] ? null : this.levels[i]) || { value: 0, label: 'LV' + i });
                return [];
            case CODES.SET_BAND: {
                const nameLength = p[1];
                const name = String.fromCharCode(...p.slice(2, 2 + nameLength));
                let o = 2 + nameLength;
                const letter = String.fromCharCode(p[o++]);
                const factory = p[o++];
                const count = p[o++];
                const freqs = [];
                for (let i = 0; i < count; i++) {
                    freqs.push(p[o] | (p[o + 1] << 8));
                    o += 2;
                }
                if (p[0] < 1 || p[0] > this.bands.length) return null;
                this.bands[p[0] - 1] = { name, letter, factory, freqs: freqs.slice(0, this.channels) };
                return [];
            }
            case CODES.SET_POWER: {
                if (p[0] < 1 || p[0] > this.levels.length) return null;
                this.levels[p[0] - 1] = { value: p[1] | (p[2] << 8), label: String.fromCharCode(...p.slice(4, 4 + p[3])) };
                return [];
            }
            case CODES.BAND: {
                const band = this.bands[p[0] - 1];
                if (!band) return null;
                const out = [p[0], 8, ...pad(band.name, 8), band.letter.charCodeAt(0), band.factory, this.channels];
                for (let i = 0; i < this.channels; i++) {
                    const f = band.freqs[i] || 0;
                    out.push(f & 0xFF, f >> 8);
                }
                return out;
            }
            case CODES.POWER: {
                const level = this.levels[p[0] - 1];
                if (!level) return null;
                return [p[0], level.value & 0xFF, level.value >> 8, 3, ...pad(level.label, 3)];
            }
            default:
                return null;
        }
    }
}

function freshFc() {
    return {
        VTXTABLE: {
            supported: false, bands: 0, channels: 0, power_levels: 0,
            limits: { max_bands: 8, max_channels: 8, max_power_levels: 8, band_name_length: 8, power_label_length: 3, max_frequency: 9999 },
            table: { bands_list: [], powerlevels_list: [] }, dirty: false, write_refused: false,
        },
    };
}

let importCounter = 0;
async function loadModule(msp) {
    globalThis.__vtxTest.MSP = msp;
    globalThis.__vtxTest.FC = freshFc();
    const url = rewriteAndWrite('js/vtxTableMsp.js', [
        [/^import MSP from '\.\/msp';$/m, `import MSP from '${mspUrl}';`, 'import MSP'],
        [/^import MSPCodes from '\.\/msp\/MSPCodes';$/m, `import MSPCodes from '${codesUrl}';`, 'import MSPCodes'],
        [/^import FC from '\.\/fc';$/m, `import FC from '${fcUrl}';`, 'import FC'],
        [/from '\.\/vtxTable';$/m, `from '${tableUrl}';`, 'import vtxTable'],
    ], 'vtxTableMsp-' + (importCounter++));
    const module = await import(url);
    return { vtxTableMsp: module.default, FC: globalThis.__vtxTest.FC };
}

const TABLE = vtxTableFromBetaflightJson(JSON.stringify({
    vtx_table: {
        bands_list: [
            { name: 'RACEBAND', letter: 'R', is_factory_band: true, frequencies: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917] },
            { name: 'LOWBAND', letter: 'L', is_factory_band: false, frequencies: [4990, 5000, 5010, 5020, 5030, 5040, 5050, 5060] },
            { name: 'HIGHBAND', letter: 'H', is_factory_band: false, frequencies: [5960, 5970, 5980, 5990, 6000, 6010, 6020, 6030] },
            { name: 'SPARSE', letter: 'X', is_factory_band: false, frequencies: [5333, 0, 0, 5444] },
        ],
        powerlevels_list: [{ value: 14, label: '25' }, { value: 26, label: '400' }, { value: 35, label: '3W' }],
    },
}));

const run = fn => new Promise(resolve => fn(resolve));

test('firmware without vtxtable support: supported stays false and nothing else is requested', async () => {
    const fc = new FakeFlightController({ supported: false });
    const { vtxTableMsp, FC } = await loadModule(fc);
    await run(done => vtxTableMsp.load(done));
    assert.equal(FC.VTXTABLE.supported, false);
    assert.deepEqual(fc.log, [CODES.CONFIG]);

    FC.VTXTABLE.dirty = true;
    await run(done => vtxTableMsp.save(done));
    assert.deepEqual(fc.log, [CODES.CONFIG], 'save sends nothing when the firmware has no vtxtable');
});

test('empty table on the flight controller loads as supported and empty', async () => {
    const fc = new FakeFlightController();
    const { vtxTableMsp, FC } = await loadModule(fc);
    await run(done => vtxTableMsp.load(done));
    assert.equal(FC.VTXTABLE.supported, true);
    assert.deepEqual(FC.VTXTABLE.table, { bands_list: [], powerlevels_list: [] });
    assert.deepEqual(fc.log, [CODES.CONFIG]);
});

test('save writes sizes, every band and every level, then load reads the same table back', async () => {
    const fc = new FakeFlightController();
    const { vtxTableMsp, FC } = await loadModule(fc);
    await run(done => vtxTableMsp.load(done));

    FC.VTXTABLE.table = structuredClone(TABLE);
    FC.VTXTABLE.dirty = true;
    fc.log = [];
    await run(done => vtxTableMsp.save(done));

    assert.deepEqual(fc.log, [CODES.SET_CONFIG, CODES.SET_BAND, CODES.SET_BAND, CODES.SET_BAND, CODES.SET_BAND,
        CODES.SET_POWER, CODES.SET_POWER, CODES.SET_POWER]);
    assert.equal(FC.VTXTABLE.dirty, false);
    assert.equal(FC.VTXTABLE.write_refused, false);
    assert.equal(fc.maxInFlight, 1, 'messages go one at a time');
    assert.deepEqual(fc.bands[2].freqs, [5960, 5970, 5980, 5990, 6000, 6010, 6020, 6030]);

    fc.log = [];
    await run(done => vtxTableMsp.load(done));
    assert.deepEqual(fc.log, [CODES.CONFIG, CODES.BAND, CODES.BAND, CODES.BAND, CODES.BAND, CODES.POWER, CODES.POWER, CODES.POWER]);
    assert.deepEqual(FC.VTXTABLE.table, TABLE);
    assert.deepEqual([FC.VTXTABLE.bands, FC.VTXTABLE.channels, FC.VTXTABLE.power_levels], [4, 8, 3]);
    assert.equal(FC.VTXTABLE.dirty, false);
});

test('an unedited table is not written', async () => {
    const fc = new FakeFlightController();
    const { vtxTableMsp, FC } = await loadModule(fc);
    await run(done => vtxTableMsp.load(done));
    FC.VTXTABLE.table = structuredClone(TABLE);
    fc.log = [];
    await run(done => vtxTableMsp.save(done));
    assert.deepEqual(fc.log, []);
});

test('saving an empty table clears the stored one', async () => {
    const fc = new FakeFlightController();
    const { vtxTableMsp, FC } = await loadModule(fc);
    await run(done => vtxTableMsp.load(done));
    FC.VTXTABLE.table = structuredClone(TABLE);
    FC.VTXTABLE.dirty = true;
    await run(done => vtxTableMsp.save(done));

    FC.VTXTABLE.table = { bands_list: [], powerlevels_list: [] };
    FC.VTXTABLE.dirty = true;
    fc.log = [];
    await run(done => vtxTableMsp.save(done));
    assert.deepEqual(fc.log, [CODES.SET_CONFIG]);
    assert.deepEqual([fc.bands.length, fc.channels, fc.levels.length], [0, 0, 0]);
});

test('a refused write is recorded and leaves the table marked unsaved', async () => {
    const fc = new FakeFlightController({ refuse: [CODES.SET_POWER] });
    const { vtxTableMsp, FC } = await loadModule(fc);
    await run(done => vtxTableMsp.load(done));
    FC.VTXTABLE.table = structuredClone(TABLE);
    FC.VTXTABLE.dirty = true;
    await run(done => vtxTableMsp.save(done));
    assert.equal(FC.VTXTABLE.write_refused, true);
    assert.equal(FC.VTXTABLE.dirty, true);
});

test('an invalid table is not sent', async () => {
    const fc = new FakeFlightController();
    const { vtxTableMsp, FC } = await loadModule(fc);
    await run(done => vtxTableMsp.load(done));
    FC.VTXTABLE.table = { bands_list: [{ name: 'BAD', letter: 'B', is_factory_band: false, frequencies: [123456] }], powerlevels_list: [] };
    FC.VTXTABLE.dirty = true;
    fc.log = [];
    await run(done => vtxTableMsp.save(done));
    assert.deepEqual(fc.log, []);
    assert.equal(FC.VTXTABLE.dirty, true);
});
