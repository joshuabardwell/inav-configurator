'use strict';

// "Device ready" readout for the VTX box in the Configuration tab. DOM-free.
//
// MSP_VTX_CONFIG carries the VTX's ready flag next to the saved band, channel and power. The
// tab requests it again every second to keep the flag current. Each reply also overwrites
// FC.VTX_CONFIG's band, channel, power and low-power-disarm with the saved values, which
// would throw away menu choices the user has not saved yet, so the tab keeps a copy of those
// fields and puts it back after each reply.

export const EDITABLE_FIELDS = ['band', 'channel', 'power', 'low_power_disarm'];

/** The fields the VTX menus edit, copied out of FC.VTX_CONFIG */
export function pickEditable(vtxConfig) {
    const copy = {};
    for (const field of EDITABLE_FIELDS) {
        copy[field] = vtxConfig[field];
    }
    return copy;
}

/** Writes a copy made by pickEditable back into FC.VTX_CONFIG */
export function restoreEditable(vtxConfig, copy) {
    for (const field of EDITABLE_FIELDS) {
        if (copy[field] !== undefined) {
            vtxConfig[field] = copy[field];
        }
    }
}

/** i18n key for the readout */
export function readyMessageKey(vtxConfig) {
    return vtxConfig.device_ready ? 'configurationVTXDeviceReadyYes' : 'configurationVTXDeviceReadyNo';
}
