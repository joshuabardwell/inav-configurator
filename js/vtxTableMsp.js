'use strict';

/*
 * Reads and writes the VTX table (fork firmware with vtxtable support) over MSP.
 *
 * Kept out of js/msp/MSPHelper.js on purpose: that file and js/fc.js are loaded in
 * isolation by several tests, with every import stubbed by name, so a new import there
 * breaks them. Replies are decoded here, in the callback of the request that asked for
 * them. MSP.unsupported still describes that reply while its callback runs.
 */

import MSP from './msp';
import MSPCodes from './msp/MSPCodes';
import FC from './fc';
import {
    emptyVtxTable,
    normalizeVtxTable,
    encodeVtxTableSizes,
    encodeVtxTableBand,
    encodeVtxTablePowerLevel,
    decodeVtxTableSizes,
    decodeVtxTableBand,
    decodeVtxTablePowerLevel,
} from './vtxTable';

const vtxTableMsp = {};

/*
 * Reads the VTX table stored on the flight controller into FC.VTXTABLE.
 * On firmware without vtxtable support FC.VTXTABLE.supported is false afterwards.
 * Requests go one at a time: the rows share a message code, and the queue drops a
 * second request for a code that is still waiting for its reply.
 */
vtxTableMsp.load = function (callback) {
    FC.VTXTABLE.supported = false;
    FC.VTXTABLE.dirty = false;
    FC.VTXTABLE.bands = 0;
    FC.VTXTABLE.channels = 0;
    FC.VTXTABLE.power_levels = 0;
    FC.VTXTABLE.table = emptyVtxTable();

    const done = function () {
        if (callback) callback();
    };

    MSP.send_message(MSPCodes.MSP2_INAV_VTXTABLE_CONFIG, false, false, function (reply) {
        const sizes = (!reply || MSP.unsupported) ? null : decodeVtxTableSizes(reply.data);
        if (!sizes) {
            // Firmware without vtxtable support (upstream INAV) refuses the command
            done();
            return;
        }

        FC.VTXTABLE.supported = true;
        FC.VTXTABLE.bands = sizes.bands;
        FC.VTXTABLE.channels = sizes.channels;
        FC.VTXTABLE.power_levels = sizes.power_levels;
        FC.VTXTABLE.limits = sizes.limits;

        let band = 1;
        let level = 1;

        const nextLevel = function () {
            if (level > FC.VTXTABLE.power_levels) {
                done();
                return;
            }
            MSP.send_message(MSPCodes.MSP_VTXTABLE_POWERLEVEL, [level++], false, function (levelReply) {
                const decoded = (!levelReply || MSP.unsupported) ? null : decodeVtxTablePowerLevel(levelReply.data);
                if (decoded && decoded.number >= 1) {
                    FC.VTXTABLE.table.powerlevels_list[decoded.number - 1] = decoded.level;
                }
                nextLevel();
            });
        };

        const nextBand = function () {
            if (band > FC.VTXTABLE.bands) {
                nextLevel();
                return;
            }
            MSP.send_message(MSPCodes.MSP_VTXTABLE_BAND, [band++], false, function (bandReply) {
                const decoded = (!bandReply || MSP.unsupported) ? null : decodeVtxTableBand(bandReply.data);
                if (decoded && decoded.number >= 1) {
                    FC.VTXTABLE.table.bands_list[decoded.number - 1] = decoded.band;
                }
                nextBand();
            });
        };

        nextBand();
    });
};

/*
 * Writes FC.VTXTABLE.table to the flight controller when it was edited (dirty).
 * Does not write the EEPROM; the caller's save chain does that.
 * FC.VTXTABLE.write_refused is true afterwards when the flight controller rejected a message.
 */
vtxTableMsp.save = function (callback) {
    const done = function () {
        if (callback) callback();
    };

    if (!FC.VTXTABLE.supported || !FC.VTXTABLE.dirty) {
        done();
        return;
    }

    let table;
    try {
        table = normalizeVtxTable(FC.VTXTABLE.table, FC.VTXTABLE.limits);
    } catch (error) {
        // The tab validates before saving, so this is a last line of defence
        console.error('VTX table not saved: ' + error.message);
        done();
        return;
    }

    // Sizes first, with the clear flag: every row is then written from scratch
    const messages = [[MSPCodes.MSP2_INAV_SET_VTXTABLE_CONFIG, encodeVtxTableSizes(table, true)]];
    table.bands_list.forEach(function (band, index) {
        messages.push([MSPCodes.MSP_SET_VTXTABLE_BAND, encodeVtxTableBand(index + 1, band)]);
    });
    table.powerlevels_list.forEach(function (level, index) {
        messages.push([MSPCodes.MSP_SET_VTXTABLE_POWERLEVEL, encodeVtxTablePowerLevel(index + 1, level)]);
    });

    FC.VTXTABLE.write_refused = false;

    const next = function () {
        if (messages.length === 0) {
            if (!FC.VTXTABLE.write_refused) {
                FC.VTXTABLE.dirty = false;
            }
            done();
            return;
        }
        const message = messages.shift();
        MSP.send_message(message[0], message[1], false, function (reply) {
            if (reply === false || MSP.unsupported) {
                FC.VTXTABLE.write_refused = true;
                console.error('Flight controller refused VTX table message 0x' + message[0].toString(16));
            }
            next();
        });
    };

    next();
};

export default vtxTableMsp;
