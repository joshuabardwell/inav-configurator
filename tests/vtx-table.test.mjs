// Unit tests for js/vtxTable.js: Betaflight vtxtable JSON import/export and validation.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    VTX_BUILTIN_BANDS,
    decodeVtxTableBand,
    decodeVtxTablePowerLevel,
    decodeVtxTableSizes,
    emptyVtxTable,
    encodeVtxTableBand,
    encodeVtxTablePowerLevel,
    encodeVtxTableSizes,
    normalizeVtxTable,
    vtxTableChannelCount,
    vtxTableFromBetaflightJson,
    vtxTableToBetaflightJson,
    vtxTableToCliLines,
} from '../js/vtxTable.js';

// Shape of the files Betaflight Configurator saves (resources/jsonschema/vtxconfig_schema-1.0.json)
const BETAFLIGHT_FILE = JSON.stringify({
    description: 'Betaflight VTX Config file for SmartAudio 2.0',
    version: '1.0',
    vtx_table: {
        bands_list: [
            { name: 'BOSCAM_A', letter: 'A', is_factory_band: true, frequencies: [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725] },
            { name: 'RACEBAND', letter: 'R', is_factory_band: true, frequencies: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917] },
            { name: 'lowband', letter: 'l', is_factory_band: false, frequencies: [4990, 5000, 5010, 5020] },
        ],
        powerlevels_list: [
            { value: 0, label: '25 ' },
            { value: 1, label: '200' },
            { value: 2, label: '500' },
        ],
    },
});

test('a Betaflight vtxtable file loads', () => {
    const table = vtxTableFromBetaflightJson(BETAFLIGHT_FILE);
    assert.equal(table.bands_list.length, 3);
    assert.equal(table.powerlevels_list.length, 3);
    assert.deepEqual(table.bands_list[0], {
        name: 'BOSCAM_A', letter: 'A', is_factory_band: true,
        frequencies: [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725],
    });
});

test('names and labels are upper-cased and trimmed, short bands are padded with unused channels', () => {
    const table = vtxTableFromBetaflightJson(BETAFLIGHT_FILE);
    assert.equal(table.bands_list[2].name, 'LOWBAND');
    assert.equal(table.bands_list[2].letter, 'L');
    assert.equal(table.bands_list[2].is_factory_band, false);
    assert.deepEqual(table.bands_list[2].frequencies, [4990, 5000, 5010, 5020, 0, 0, 0, 0]);
    assert.equal(vtxTableChannelCount(table), 8);
    assert.equal(table.powerlevels_list[0].label, '25');
});

test('saving and loading again gives the same table', () => {
    const table = vtxTableFromBetaflightJson(BETAFLIGHT_FILE);
    const text = vtxTableToBetaflightJson(table, 'round trip');
    const parsed = JSON.parse(text);
    assert.equal(parsed.version, '1.0');
    assert.equal(parsed.description, 'round trip');
    assert.deepEqual(Object.keys(parsed.vtx_table), ['bands_list', 'powerlevels_list']);
    assert.deepEqual(vtxTableFromBetaflightJson(text), table);
});

test('frequencies outside 5000-5999 are accepted up to the firmware limit', () => {
    const table = normalizeVtxTable({
        bands_list: [{ name: 'WIDE', letter: 'W', is_factory_band: false, frequencies: [4990, 6030, 1280, 9999] }],
        powerlevels_list: [],
    });
    assert.deepEqual(table.bands_list[0].frequencies, [4990, 6030, 1280, 9999]);
    assert.throws(() => normalizeVtxTable({
        bands_list: [{ name: 'BAD', letter: 'B', is_factory_band: false, frequencies: [10000] }],
        powerlevels_list: [],
    }), /Band 1 channel 1 frequency/);
});

test('files that are not vtxtables are refused with a readable reason', () => {
    assert.throws(() => vtxTableFromBetaflightJson('not json'), /not valid JSON/);
    assert.throws(() => vtxTableFromBetaflightJson('{"hello": 1}'), /no "vtx_table" section/);
    assert.throws(() => vtxTableFromBetaflightJson('{"vtx_table": {"bands_list": []}}'), /bands_list and a powerlevels_list/);
});

test('tables beyond the firmware limits are refused', () => {
    const band = { name: 'B', letter: 'B', is_factory_band: false, frequencies: [5800] };
    assert.throws(() => normalizeVtxTable({ bands_list: new Array(9).fill(band), powerlevels_list: [] }), /at most 8/);
    assert.throws(() => normalizeVtxTable({
        bands_list: [{ ...band, frequencies: new Array(9).fill(5800) }], powerlevels_list: [],
    }), /at most 8/);
    assert.throws(() => normalizeVtxTable({
        bands_list: [], powerlevels_list: new Array(9).fill({ value: 1, label: 'X' }),
    }), /at most 8/);
    assert.throws(() => normalizeVtxTable({
        bands_list: [{ ...band, frequencies: [5800.5] }], powerlevels_list: [],
    }), /whole number/);
    assert.throws(() => normalizeVtxTable({
        bands_list: [], powerlevels_list: [{ value: -1, label: 'X' }],
    }), /Power level 1 value/);
});

test('blank names, letters and labels get the firmware defaults', () => {
    const table = normalizeVtxTable({
        bands_list: [{ name: '', letter: '', is_factory_band: false, frequencies: [5800] }],
        powerlevels_list: [{ value: 25, label: '' }],
    });
    assert.equal(table.bands_list[0].name, 'BAND1');
    assert.equal(table.bands_list[0].letter, 'B');
    assert.equal(table.powerlevels_list[0].label, 'LV0');
});

test('names are cut to 8 characters and labels to 3, spaces become underscores', () => {
    const table = normalizeVtxTable({
        bands_list: [{ name: 'boscam a long', letter: 'ab', is_factory_band: true, frequencies: [5865] }],
        powerlevels_list: [{ value: 1000, label: '1000' }],
    });
    assert.equal(table.bands_list[0].name, 'BOSCAM_A');
    assert.equal(table.bands_list[0].letter, 'A');
    assert.equal(table.powerlevels_list[0].label, '100');
});

test('CLI lines match the firmware vtxtable syntax', () => {
    const lines = vtxTableToCliLines(vtxTableFromBetaflightJson(BETAFLIGHT_FILE));
    assert.deepEqual(lines, [
        'vtxtable bands 3',
        'vtxtable channels 8',
        'vtxtable band 1 BOSCAM_A A FACTORY 5865 5845 5825 5805 5785 5765 5745 5725',
        'vtxtable band 2 RACEBAND R FACTORY 5658 5695 5732 5769 5806 5843 5880 5917',
        'vtxtable band 3 LOWBAND L CUSTOM 4990 5000 5010 5020 0 0 0 0',
        'vtxtable powerlevels 3',
        'vtxtable powervalues 0 1 2',
        'vtxtable powerlabels 25 200 500',
    ]);
});

test('an empty table is valid and clears the stored table', () => {
    const lines = vtxTableToCliLines(emptyVtxTable());
    assert.deepEqual(lines, [
        'vtxtable bands 0',
        'vtxtable channels 0',
        'vtxtable powerlevels 0',
        'vtxtable powervalues',
        'vtxtable powerlabels',
    ]);
});

test('MSP band and power level payloads decode back to the same rows', () => {
    const band = { name: 'HIGHBAND', letter: 'H', is_factory_band: false, frequencies: [5960, 5970, 5980, 5990, 6000, 6010, 6020, 6030] };
    const bandBytes = encodeVtxTableBand(7, band);
    // band, nameLength, 8 name bytes, letter, factory, channel count, 8 x U16
    assert.equal(bandBytes.length, 2 + 8 + 3 + 16);
    assert.deepEqual(bandBytes.slice(0, 2), [7, 8]);
    assert.deepEqual(bandBytes.slice(-2), [6030 & 0xFF, 6030 >> 8]);
    assert.deepEqual(decodeVtxTableBand(new DataView(Uint8Array.from(bandBytes).buffer)), { number: 7, band: band });

    const level = { value: 3000, label: '3W' };
    const levelBytes = encodeVtxTablePowerLevel(5, level);
    assert.deepEqual(levelBytes, [5, 3000 & 0xFF, 3000 >> 8, 2, 0x33, 0x57]);
    assert.deepEqual(decodeVtxTablePowerLevel(new DataView(Uint8Array.from(levelBytes).buffer)), { number: 5, level: level });
});

test('the firmware pads names and labels with spaces; decoding trims them', () => {
    const padded = [1, 8, ...'BAND1   '.split('').map(c => c.charCodeAt(0)), 0x31, 0, 2, 0x10, 0x17, 0, 0];
    assert.deepEqual(decodeVtxTableBand(new DataView(Uint8Array.from(padded).buffer)),
        { number: 1, band: { name: 'BAND1', letter: '1', is_factory_band: false, frequencies: [5904, 0] } });
    const label = [2, 25, 0, 3, 0x32, 0x35, 0x20];
    assert.deepEqual(decodeVtxTablePowerLevel(new DataView(Uint8Array.from(label).buffer)),
        { number: 2, level: { value: 25, label: '25' } });
});

test('sizes message: encode, decode, and short or malformed replies', () => {
    const table = vtxTableFromBetaflightJson(BETAFLIGHT_FILE);
    assert.deepEqual(encodeVtxTableSizes(table), [3, 8, 3, 1]);
    assert.deepEqual(encodeVtxTableSizes(emptyVtxTable(), false), [0, 0, 0, 0]);

    const reply = Uint8Array.from([6, 8, 5, 8, 8, 8, 8, 3, 9999 & 0xFF, 9999 >> 8]);
    assert.deepEqual(decodeVtxTableSizes(new DataView(reply.buffer)), {
        bands: 6, channels: 8, power_levels: 5,
        limits: { max_bands: 8, max_channels: 8, max_power_levels: 8, band_name_length: 8, power_label_length: 3, max_frequency: 9999 },
    });
    assert.equal(decodeVtxTableSizes(new DataView(new ArrayBuffer(0))), null);
    assert.equal(decodeVtxTableBand(new DataView(new ArrayBuffer(2))), null);
    assert.equal(decodeVtxTableBand(new DataView(Uint8Array.from([1, 8, 65, 66, 67]).buffer)), null);
    assert.equal(decodeVtxTablePowerLevel(new DataView(Uint8Array.from([1, 25, 0, 3, 65]).buffer)), null);
});

test('built-in bands are the five standard 5.8 GHz bands', () => {
    assert.deepEqual(VTX_BUILTIN_BANDS.map(band => band.letter), ['A', 'B', 'E', 'F', 'R']);
    assert.ok(VTX_BUILTIN_BANDS.every(band => band.frequencies.length === 8 && band.is_factory_band));
});
