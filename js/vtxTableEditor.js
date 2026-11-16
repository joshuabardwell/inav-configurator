'use strict';

/*
 * VTX table editor for the Configuration tab (fork firmware with vtxtable support).
 *
 * - Edits FC.VTXTABLE.table in place and marks it dirty; the tab's "Save and Reboot"
 *   writes it with mspHelper.saveVtxTable.
 * - Loads and saves Betaflight vtxtable JSON files.
 * - Rebuilds the VTX band, channel and power menus from the table, so the menus show
 *   the table's band names and each channel's frequency.
 *
 * On firmware without vtxtable support the editor box stays hidden and the menus are
 * left exactly as the Configuration tab built them.
 */

import FC from './fc';
import GUI from './gui';
import i18n from './localization';
import dialog from './dialog';
import VTX from './vtx';
import {
    VTX_BUILTIN_BANDS,
    cloneVtxTable,
    emptyVtxTable,
    normalizeVtxTable,
    vtxTableChannelCount,
    vtxTableFromBetaflightJson,
    vtxTableToBetaflightJson,
    vtxTableToCliLines,
} from './vtxTable';

const vtxTableEditor = {};

// Channel count shown in the editor. Kept separately because a table with no bands has no channels to count.
let editorChannels = 8;

function msg(key, values) {
    let text = i18n.getMessage(key) || key;
    Object.keys(values || {}).forEach(name => {
        text = text.split('{' + name + '}').join(values[name]);
    });
    return text;
}

function bandsInUse() {
    const table = FC.VTXTABLE.table;
    return FC.VTXTABLE.supported && table.bands_list.length > 0 && vtxTableChannelCount(table) > 0;
}

function powerLevelsInUse() {
    return FC.VTXTABLE.supported && FC.VTXTABLE.table.powerlevels_list.length > 0;
}

function showError(message) {
    const $error = $('#vtxtable_error');
    if (message) {
        $error.text(message).show();
    } else {
        $error.text('').hide();
    }
}

function markDirty() {
    FC.VTXTABLE.dirty = true;
    showError('');
    renderSummary();
    vtxTableEditor.renderVtxSelectors();
}

function renderSummary() {
    const table = FC.VTXTABLE.table;
    const parts = [];

    if (bandsInUse()) {
        parts.push(msg('vtxTableSummaryBands', { bands: table.bands_list.length, channels: vtxTableChannelCount(table) }));
    } else {
        parts.push(msg('vtxTableSummaryNoBands'));
    }
    if (powerLevelsInUse()) {
        parts.push(msg('vtxTableSummaryPower', { levels: table.powerlevels_list.length }));
    } else {
        parts.push(msg('vtxTableSummaryNoPower'));
    }
    if (FC.VTXTABLE.dirty) {
        parts.push(msg('vtxTableSummaryUnsaved'));
    }

    $('#vtxtable_summary').text(parts.join(' '));
}

function resizeTable(bands, channels, levels) {
    const table = FC.VTXTABLE.table;

    while (table.bands_list.length < bands) {
        const number = table.bands_list.length + 1;
        table.bands_list.push({ name: 'BAND' + number, letter: String(number), is_factory_band: false, frequencies: [] });
    }
    table.bands_list.length = bands;
    table.bands_list.forEach(band => {
        while (band.frequencies.length < channels) {
            band.frequencies.push(0);
        }
        band.frequencies.length = channels;
    });

    while (table.powerlevels_list.length < levels) {
        table.powerlevels_list.push({ value: 0, label: 'LV' + table.powerlevels_list.length });
    }
    table.powerlevels_list.length = levels;

    editorChannels = channels;
}

function numberInput(value, min, max) {
    return $('<input type="number" step="1">').attr('min', min).attr('max', max).val(value);
}

function readInteger($input, min, max) {
    let value = parseInt($input.val(), 10);
    if (isNaN(value)) {
        value = min;
    }
    value = Math.min(max, Math.max(min, value));
    $input.val(value);
    return value;
}

function renderEditor() {
    const table = FC.VTXTABLE.table;
    const limits = FC.VTXTABLE.limits;
    const $editor = $('#vtxtable_editor').empty();

    // --- sizes ---
    const $sizes = $('<div class="vtxtable-sizes">').appendTo($editor);
    const addSize = function (labelKey, value, max, onChange) {
        const $label = $('<label>').appendTo($sizes);
        $('<span>').text(msg(labelKey)).appendTo($label);
        const $input = numberInput(value, 0, max).appendTo($label);
        $input.on('change', function () {
            onChange(readInteger($input, 0, max));
            markDirty();
            renderEditor();
        });
    };
    addSize('vtxTableBands', table.bands_list.length, limits.max_bands,
        value => resizeTable(value, editorChannels, table.powerlevels_list.length));
    addSize('vtxTableChannels', editorChannels, limits.max_channels,
        value => resizeTable(table.bands_list.length, value, table.powerlevels_list.length));
    addSize('vtxTablePowerLevels', table.powerlevels_list.length, limits.max_power_levels,
        value => resizeTable(table.bands_list.length, editorChannels, value));

    // --- bands ---
    if (table.bands_list.length > 0) {
        const $bands = $('<table class="vtxtable-grid vtxtable-bands">').appendTo($editor);
        const $head = $('<tr>').appendTo($('<thead>').appendTo($bands));
        $('<th>').text('#').appendTo($head);
        $('<th>').text(msg('vtxTableBandName')).appendTo($head);
        $('<th>').text(msg('vtxTableBandLetter')).appendTo($head);
        $('<th>').text(msg('vtxTableBandFactory')).attr('title', msg('vtxTableBandFactoryHelp')).appendTo($head);
        for (let channel = 1; channel <= editorChannels; channel++) {
            $('<th>').text(msg('vtxTableChannelHeader', { channel: channel })).appendTo($head);
        }

        const $body = $('<tbody>').appendTo($bands);
        table.bands_list.forEach(function (band, index) {
            const $row = $('<tr>').appendTo($body);
            $('<td>').text(index + 1).appendTo($row);

            const $name = $('<input type="text" class="vtxtable-name">').attr('maxlength', limits.band_name_length).val(band.name);
            $name.on('change', function () {
                band.name = $name.val().trim().toUpperCase().replace(/\s+/g, '_');
                $name.val(band.name);
                markDirty();
            });
            $('<td>').append($name).appendTo($row);

            const $letter = $('<input type="text" class="vtxtable-letter">').attr('maxlength', 1).val(band.letter);
            $letter.on('change', function () {
                band.letter = $letter.val().trim().toUpperCase().substring(0, 1);
                $letter.val(band.letter);
                markDirty();
            });
            $('<td>').append($letter).appendTo($row);

            const $factory = $('<input type="checkbox">').prop('checked', !!band.is_factory_band)
                .attr('title', msg('vtxTableBandFactoryHelp'));
            $factory.on('change', function () {
                band.is_factory_band = $factory.is(':checked');
                markDirty();
            });
            $('<td>').append($factory).appendTo($row);

            for (let channel = 0; channel < editorChannels; channel++) {
                const $frequency = numberInput(band.frequencies[channel] || 0, 0, limits.max_frequency).addClass('vtxtable-frequency');
                $frequency.on('change', function () {
                    band.frequencies[channel] = readInteger($frequency, 0, limits.max_frequency);
                    markDirty();
                });
                $('<td>').append($frequency).appendTo($row);
            }
        });
    }

    // --- power levels ---
    if (table.powerlevels_list.length > 0) {
        const $power = $('<table class="vtxtable-grid vtxtable-power">').appendTo($editor);
        const $head = $('<tr>').appendTo($('<thead>').appendTo($power));
        $('<th>').text(msg('vtxTablePowerLevel')).appendTo($head);
        const $values = $('<tr>');
        const $labels = $('<tr>');
        $('<tbody>').append($values).append($labels).appendTo($power);
        $('<th>').text(msg('vtxTablePowerValue')).attr('title', msg('vtxTablePowerValueHelp')).appendTo($values);
        $('<th>').text(msg('vtxTablePowerLabel')).appendTo($labels);

        table.powerlevels_list.forEach(function (level, index) {
            $('<th>').text(index + 1).appendTo($head);

            const $value = numberInput(level.value, 0, 65535).addClass('vtxtable-powervalue')
                .attr('title', msg('vtxTablePowerValueHelp'));
            $value.on('change', function () {
                level.value = readInteger($value, 0, 65535);
                markDirty();
            });
            $('<td>').append($value).appendTo($values);

            const $label = $('<input type="text" class="vtxtable-powerlabel">').attr('maxlength', limits.power_label_length).val(level.label);
            $label.on('change', function () {
                level.label = $label.val().trim().toUpperCase().replace(/\s+/g, '');
                $label.val(level.label);
                markDirty();
            });
            $('<td>').append($label).appendTo($labels);
        });
    }

    renderSummary();
}

function replaceTable(table) {
    FC.VTXTABLE.table = table;
    editorChannels = vtxTableChannelCount(table) || editorChannels;
    renderEditor();
    markDirty();
}

function loadFromFile() {
    const options = {
        filters: [
            { name: 'JSON', extensions: ['json'] },
            { name: 'ALL', extensions: ['*'] },
        ],
    };
    dialog.showOpenDialog(options).then(function (result) {
        if (result.canceled || result.filePaths.length !== 1) {
            return;
        }
        window.electronAPI.readFile(result.filePaths[0]).then(function (response) {
            if (response.error) {
                GUI.log(i18n.getMessage('ErrorReadingFile'));
                console.error(response.error);
                return;
            }
            try {
                replaceTable(vtxTableFromBetaflightJson(response.data, FC.VTXTABLE.limits));
                GUI.log(msg('vtxTableLoaded'));
            } catch (error) {
                showError(msg('vtxTableLoadFailed', { reason: error.message }));
            }
        });
    }).catch(function (error) {
        console.log(error);
    });
}

function saveToFile() {
    let text;
    try {
        text = vtxTableToBetaflightJson(FC.VTXTABLE.table);
    } catch (error) {
        showError(error.message);
        return;
    }
    const options = {
        defaultPath: 'vtxtable.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    dialog.showSaveDialog(options).then(function (result) {
        if (result.canceled) {
            return;
        }
        window.electronAPI.writeFile(result.filePath, text).then(function (error) {
            if (error) {
                GUI.log(i18n.getMessage('ErrorWritingFile'));
                console.error(error);
                return;
            }
            GUI.log(i18n.getMessage('FileSaved'));
        });
    }).catch(function (error) {
        console.log(error);
    });
}

function copyAsCli() {
    let text;
    try {
        text = vtxTableToCliLines(FC.VTXTABLE.table).join('\n') + '\n';
    } catch (error) {
        showError(error.message);
        return;
    }
    navigator.clipboard.writeText(text).then(function () {
        GUI.log(msg('vtxTableCopied'));
    }).catch(function (error) {
        console.error(error);
        showError(msg('vtxTableCopyFailed'));
    });
}

function fillStockSelectors() {
    // What the Configuration tab shows without a table (same as upstream)
    const $band = $('#vtx_band').off('change').empty();
    const $note = $('#vtx_no_band');
    if (FC.VTX_CONFIG.band < VTX.BAND_MIN || FC.VTX_CONFIG.band > VTX.BAND_MAX) {
        $('<option>').val(0).text(i18n.getMessage('configurationNoBand')).appendTo($band);
        $note.show();
    } else {
        $note.hide();
    }
    VTX.BANDS.forEach(band => $('<option>').val(band.code).text(band.name).appendTo($band));
    $band.val(FC.VTX_CONFIG.band >= VTX.BAND_MIN && FC.VTX_CONFIG.band <= VTX.BAND_MAX ? FC.VTX_CONFIG.band : 0);
    $band.on('change', function () {
        FC.VTX_CONFIG.band = parseInt($(this).val());
    });

    const $channel = $('#vtx_channel').off('change').empty();
    for (let channel = VTX.CHANNEL_MIN; channel <= VTX.CHANNEL_MAX; channel++) {
        $('<option>').val(channel).text(channel).appendTo($channel);
    }
    $channel.val(FC.VTX_CONFIG.channel);
    $channel.on('change', function () {
        FC.VTX_CONFIG.channel = parseInt($(this).val());
    });
}

function fillTableBandSelectors() {
    const table = FC.VTXTABLE.table;
    const bands = table.bands_list;
    const channels = vtxTableChannelCount(table);
    const $band = $('#vtx_band').off('change').empty();
    const $channel = $('#vtx_channel').off('change').empty();
    const $note = $('#vtx_no_band');

    const bandValid = FC.VTX_CONFIG.band >= 1 && FC.VTX_CONFIG.band <= bands.length;
    if (!bandValid) {
        $('<option>').val(0).text(i18n.getMessage('configurationNoBand')).appendTo($band);
        $note.show();
    } else {
        $note.hide();
    }
    bands.forEach(function (band, index) {
        $('<option>').val(index + 1).text((index + 1) + ': ' + band.name + ' (' + band.letter + ')').appendTo($band);
    });
    $band.val(bandValid ? FC.VTX_CONFIG.band : 0);

    const fillChannels = function () {
        $channel.empty();
        const band = bands[FC.VTX_CONFIG.band - 1];
        for (let channel = 1; channel <= channels; channel++) {
            const $option = $('<option>').val(channel);
            if (!band) {
                $option.text(channel);
            } else if (band.frequencies[channel - 1]) {
                $option.text(channel + ': ' + band.frequencies[channel - 1] + ' MHz');
            } else {
                $option.text(channel + ': ' + msg('vtxTableChannelUnused')).prop('disabled', true);
            }
            $option.appendTo($channel);
        }
        // Keep the stored channel when the band has it; otherwise move to the band's first usable channel
        const usable = channel => !band || !!band.frequencies[channel - 1];
        let selected = FC.VTX_CONFIG.channel;
        if (selected < 1 || selected > channels || !usable(selected)) {
            selected = 0;
            for (let channel = 1; channel <= channels && !selected; channel++) {
                if (usable(channel)) {
                    selected = channel;
                }
            }
        }
        if (selected) {
            FC.VTX_CONFIG.channel = selected;
            $channel.val(selected);
        }
    };

    $band.on('change', function () {
        FC.VTX_CONFIG.band = parseInt($(this).val());
        fillChannels();
    });
    $channel.on('change', function () {
        FC.VTX_CONFIG.channel = parseInt($(this).val());
    });
    fillChannels();
}

function fillPowerSelector(useTable) {
    const $power = $('#vtx_power').off('change').empty();
    const levels = FC.VTXTABLE.table.powerlevels_list;
    const count = useTable ? levels.length : FC.VTX_CONFIG.power_count;

    for (let index = FC.VTX_CONFIG.power_min; index <= count; index++) {
        const $option = $('<option>').val(index);
        if (useTable && index >= 1) {
            $option.text(index + ': ' + levels[index - 1].label);
        } else {
            $option.text(index);
        }
        $option.appendTo($power);
    }
    if (FC.VTX_CONFIG.power >= FC.VTX_CONFIG.power_min && FC.VTX_CONFIG.power <= count) {
        $power.val(FC.VTX_CONFIG.power);
    } else if (count >= FC.VTX_CONFIG.power_min) {
        // The stored level is beyond the table: fall back to the lowest level
        FC.VTX_CONFIG.power = Math.max(1, FC.VTX_CONFIG.power_min);
        $power.val(FC.VTX_CONFIG.power);
    }
    $power.on('change', function () {
        FC.VTX_CONFIG.power = parseInt($(this).val());
    });
}

// Whether the menus currently show table entries; lets a cleared table put the stock menus back.
let menusShowBands = false;
let menusShowPower = false;

/* Rebuilds the VTX band, channel and power menus from the table, where the table defines them. */
vtxTableEditor.renderVtxSelectors = function () {
    if (!FC.VTXTABLE.supported || FC.VTX_CONFIG.device_type == VTX.DEV_UNKNOWN) {
        return;
    }

    if (bandsInUse()) {
        fillTableBandSelectors();
        menusShowBands = true;
    } else if (menusShowBands) {
        fillStockSelectors();
        menusShowBands = false;
    }

    if (powerLevelsInUse()) {
        fillPowerSelector(true);
        menusShowPower = true;
    } else if (menusShowPower) {
        fillPowerSelector(false);
        menusShowPower = false;
    }
};

/*
 * Called by the Configuration tab before saving. Returns false, and shows why, when the
 * edited table is not something the firmware would accept.
 */
vtxTableEditor.validate = function () {
    if (!FC.VTXTABLE.supported || !FC.VTXTABLE.dirty) {
        return true;
    }
    try {
        FC.VTXTABLE.table = normalizeVtxTable(FC.VTXTABLE.table, FC.VTXTABLE.limits);
        showError('');
        return true;
    } catch (error) {
        showError(msg('vtxTableInvalid', { reason: error.message }));
        GUI.log(msg('vtxTableInvalid', { reason: error.message }));
        return false;
    }
};

/* Called by the Configuration tab once its HTML is in place and FC.VTXTABLE is loaded. */
vtxTableEditor.init = function () {
    const $box = $('.config-vtxtable');
    menusShowBands = false;
    menusShowPower = false;

    if (!FC.VTXTABLE.supported) {
        $box.hide();
        return;
    }

    editorChannels = vtxTableChannelCount(FC.VTXTABLE.table) || FC.VTXTABLE.limits.max_channels;
    showError('');

    $('#vtxtable_load_file').off('click').on('click', function (event) {
        event.preventDefault();
        loadFromFile();
    });
    $('#vtxtable_save_file').off('click').on('click', function (event) {
        event.preventDefault();
        saveToFile();
    });
    $('#vtxtable_copy_cli').off('click').on('click', function (event) {
        event.preventDefault();
        copyAsCli();
    });
    $('#vtxtable_builtin').off('click').on('click', function (event) {
        event.preventDefault();
        const table = cloneVtxTable(FC.VTXTABLE.table);
        table.bands_list = cloneVtxTable({ bands_list: VTX_BUILTIN_BANDS, powerlevels_list: [] }).bands_list;
        replaceTable(table);
    });
    $('#vtxtable_clear').off('click').on('click', function (event) {
        event.preventDefault();
        replaceTable(emptyVtxTable());
    });

    renderEditor();
    vtxTableEditor.renderVtxSelectors();
    $box.show();
};

export default vtxTableEditor;
