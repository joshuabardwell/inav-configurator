'use strict';

/*
 * VTX table (user-defined bands, channels and power levels).
 *
 * The table uses the same shape as Betaflight's vtxtable JSON files, so those files
 * can be loaded and saved unchanged:
 *
 *   {
 *     "description": "...",
 *     "version": "1.0",
 *     "vtx_table": {
 *       "bands_list": [ { "name": "BOSCAM_A", "letter": "A", "is_factory_band": true,
 *                         "frequencies": [5865, 5845, ...] }, ... ],
 *       "powerlevels_list": [ { "value": 25, "label": "25" }, ... ]
 *     }
 *   }
 *
 * This module has no DOM or MSP dependencies so it can be unit tested with node.
 */

export const VTX_TABLE_DEFAULT_LIMITS = {
    max_bands: 8,
    max_channels: 8,
    max_power_levels: 8,
    band_name_length: 8,
    power_label_length: 3,
    max_frequency: 9999,
};

// Bands built into the firmware, used while no table is stored on the flight controller.
export const VTX_BUILTIN_BANDS = [
    { name: 'BOSCAM_A', letter: 'A', is_factory_band: true, frequencies: [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725] },
    { name: 'BOSCAM_B', letter: 'B', is_factory_band: true, frequencies: [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866] },
    { name: 'BOSCAM_E', letter: 'E', is_factory_band: true, frequencies: [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945] },
    { name: 'FATSHARK', letter: 'F', is_factory_band: true, frequencies: [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880] },
    { name: 'RACEBAND', letter: 'R', is_factory_band: true, frequencies: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917] },
];

export function emptyVtxTable() {
    return { bands_list: [], powerlevels_list: [] };
}

export function cloneVtxTable(table) {
    return {
        bands_list: table.bands_list.map(band => ({
            name: band.name,
            letter: band.letter,
            is_factory_band: !!band.is_factory_band,
            frequencies: band.frequencies.slice(),
        })),
        powerlevels_list: table.powerlevels_list.map(level => ({ value: level.value, label: level.label })),
    };
}

// The firmware stores one channel count for the whole table.
export function vtxTableChannelCount(table) {
    return table.bands_list.reduce((max, band) => Math.max(max, band.frequencies.length), 0);
}

function cleanText(value, maxLength) {
    // The firmware upper-cases names and reads the CLI line word by word, so no spaces.
    return String(value === undefined || value === null ? '' : value)
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '_')
        .replace(/[^\x21-\x7E]/g, '')
        .substring(0, maxLength);
}

function cleanInteger(value, min, max, what) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new Error(what + ' must be a whole number from ' + min + ' to ' + max + ' (got ' + JSON.stringify(value) + ')');
    }
    return number;
}

/*
 * Returns a cleaned copy of a table that the firmware will accept, or throws an Error
 * that says what is wrong. All bands get the same number of channels; short bands are
 * padded with 0, which the firmware treats as "channel not used".
 */
export function normalizeVtxTable(table, limits = VTX_TABLE_DEFAULT_LIMITS) {
    if (!table || !Array.isArray(table.bands_list) || !Array.isArray(table.powerlevels_list)) {
        throw new Error('The table needs a bands_list and a powerlevels_list');
    }
    if (table.bands_list.length > limits.max_bands) {
        throw new Error('The table has ' + table.bands_list.length + ' bands; the firmware holds at most ' + limits.max_bands);
    }
    if (table.powerlevels_list.length > limits.max_power_levels) {
        throw new Error('The table has ' + table.powerlevels_list.length + ' power levels; the firmware holds at most ' + limits.max_power_levels);
    }

    const bands = table.bands_list.map((band, index) => {
        const where = 'Band ' + (index + 1);
        if (!band || !Array.isArray(band.frequencies)) {
            throw new Error(where + ' has no list of frequencies');
        }
        if (band.frequencies.length > limits.max_channels) {
            throw new Error(where + ' has ' + band.frequencies.length + ' channels; the firmware holds at most ' + limits.max_channels);
        }
        const name = cleanText(band.name, limits.band_name_length) || ('BAND' + (index + 1));
        const letter = cleanText(band.letter, 1) || name.charAt(0);
        return {
            name: name,
            letter: letter,
            is_factory_band: !!band.is_factory_band,
            frequencies: band.frequencies.map((frequency, channel) =>
                cleanInteger(frequency, 0, limits.max_frequency, where + ' channel ' + (channel + 1) + ' frequency')),
        };
    });

    const channels = bands.reduce((max, band) => Math.max(max, band.frequencies.length), 0);
    bands.forEach(band => {
        while (band.frequencies.length < channels) {
            band.frequencies.push(0);
        }
    });

    const powerLevels = table.powerlevels_list.map((level, index) => {
        const where = 'Power level ' + (index + 1);
        if (!level) {
            throw new Error(where + ' is empty');
        }
        return {
            value: cleanInteger(level.value, 0, 65535, where + ' value'),
            label: cleanText(level.label, limits.power_label_length) || ('LV' + index),
        };
    });

    return { bands_list: bands, powerlevels_list: powerLevels };
}

/* Parses the text of a Betaflight vtxtable JSON file. Throws an Error with a readable message. */
export function vtxTableFromBetaflightJson(text, limits = VTX_TABLE_DEFAULT_LIMITS) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error('The file is not valid JSON: ' + error.message);
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.vtx_table || typeof parsed.vtx_table !== 'object') {
        throw new Error('The file has no "vtx_table" section, so it is not a Betaflight VTX table file');
    }
    return normalizeVtxTable({
        bands_list: parsed.vtx_table.bands_list,
        powerlevels_list: parsed.vtx_table.powerlevels_list,
    }, limits);
}

/* Returns the text of a Betaflight vtxtable JSON file for this table. */
export function vtxTableToBetaflightJson(table, description) {
    const clean = normalizeVtxTable(table);
    return JSON.stringify({
        description: description || 'VTX table saved from INAV Configurator',
        version: '1.0',
        vtx_table: {
            bands_list: clean.bands_list,
            powerlevels_list: clean.powerlevels_list,
        },
    }, null, 4) + '\n';
}

/*
 * MSP payloads. The rows use Betaflight's message layout:
 *   band:        band, nameLength, name[], letter, isFactory, channelCount, frequency[] (U16 LE)
 *   power level: level, value (U16 LE), labelLength, label[]
 * The sizes message is fork-local: bands, channels, powerLevels, clear flag.
 * Encoders return plain byte arrays; decoders take a DataView.
 */

function asciiBytes(text) {
    return Array.from(text).map(character => character.charCodeAt(0) & 0x7F);
}

function readAscii(view, offset, length) {
    let text = '';
    for (let index = 0; index < length; index++) {
        text += String.fromCharCode(view.getUint8(offset + index));
    }
    return text;
}

export function encodeVtxTableSizes(table, clear = true) {
    return [table.bands_list.length, vtxTableChannelCount(table), table.powerlevels_list.length, clear ? 1 : 0];
}

export function encodeVtxTableBand(bandNumber, band) {
    const payload = [bandNumber, band.name.length].concat(asciiBytes(band.name));
    payload.push(band.letter.charCodeAt(0) & 0x7F);
    payload.push(band.is_factory_band ? 1 : 0);
    payload.push(band.frequencies.length);
    band.frequencies.forEach(frequency => {
        payload.push(frequency & 0xFF);
        payload.push((frequency >> 8) & 0xFF);
    });
    return payload;
}

export function encodeVtxTablePowerLevel(levelNumber, level) {
    return [levelNumber, level.value & 0xFF, (level.value >> 8) & 0xFF, level.label.length].concat(asciiBytes(level.label));
}

/* Returns { bands, channels, power_levels, limits } or null when the reply is too short. */
export function decodeVtxTableSizes(view) {
    if (view.byteLength < 3) {
        return null;
    }
    const sizes = {
        bands: view.getUint8(0),
        channels: view.getUint8(1),
        power_levels: view.getUint8(2),
        limits: { ...VTX_TABLE_DEFAULT_LIMITS },
    };
    if (view.byteLength >= 10) {
        sizes.limits = {
            max_bands: view.getUint8(3),
            max_channels: view.getUint8(4),
            max_power_levels: view.getUint8(5),
            band_name_length: view.getUint8(6),
            power_label_length: view.getUint8(7),
            max_frequency: view.getUint16(8, true),
        };
    }
    return sizes;
}

/* Returns { number, band } or null when the reply is malformed. */
export function decodeVtxTableBand(view) {
    if (view.byteLength < 5) {
        return null;
    }
    let offset = 0;
    const number = view.getUint8(offset++);
    const nameLength = view.getUint8(offset++);
    if (view.byteLength < 2 + nameLength + 3) {
        return null;
    }
    const name = readAscii(view, offset, nameLength).trim();
    offset += nameLength;
    const letter = String.fromCharCode(view.getUint8(offset++));
    const isFactory = view.getUint8(offset++) !== 0;
    const channelCount = view.getUint8(offset++);
    if (view.byteLength < offset + channelCount * 2) {
        return null;
    }
    const frequencies = [];
    for (let channel = 0; channel < channelCount; channel++) {
        frequencies.push(view.getUint16(offset, true));
        offset += 2;
    }
    return { number: number, band: { name: name, letter: letter, is_factory_band: isFactory, frequencies: frequencies } };
}

/* Returns { number, level } or null when the reply is malformed. */
export function decodeVtxTablePowerLevel(view) {
    if (view.byteLength < 4) {
        return null;
    }
    const number = view.getUint8(0);
    const value = view.getUint16(1, true);
    const labelLength = view.getUint8(3);
    if (view.byteLength < 4 + labelLength) {
        return null;
    }
    return { number: number, level: { value: value, label: readAscii(view, 4, labelLength).trim() } };
}

/* The same table as `vtxtable` CLI lines (identical syntax in INAV with vtxtable support and in Betaflight). */
export function vtxTableToCliLines(table) {
    const clean = normalizeVtxTable(table);
    const lines = [
        'vtxtable bands ' + clean.bands_list.length,
        'vtxtable channels ' + vtxTableChannelCount(clean),
    ];
    clean.bands_list.forEach((band, index) => {
        lines.push('vtxtable band ' + (index + 1) + ' ' + band.name + ' ' + band.letter + ' ' +
            (band.is_factory_band ? 'FACTORY' : 'CUSTOM') + ' ' + band.frequencies.join(' '));
    });
    lines.push('vtxtable powerlevels ' + clean.powerlevels_list.length);
    lines.push(('vtxtable powervalues ' + clean.powerlevels_list.map(level => level.value).join(' ')).trim());
    lines.push(('vtxtable powerlabels ' + clean.powerlevels_list.map(level => level.label).join(' ')).trim());
    return lines;
}
