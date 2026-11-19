// Unit tests for js/vtxReady.js: the Configuration tab's VTX "device ready" readout.
import test from 'node:test';
import assert from 'node:assert/strict';

import { EDITABLE_FIELDS, pickEditable, restoreEditable, readyMessageKey } from '../js/vtxReady.js';

const saved = () => ({
    device_type: 3, band: 5, channel: 3, power: 2, pitmode: 0, device_ready: 1,
    low_power_disarm: 0, band_count: 5, channel_count: 8, power_count: 5, power_min: 1,
});

test('pickEditable copies only the fields the menus edit', () => {
    assert.deepEqual(pickEditable(saved()), { band: 5, channel: 3, power: 2, low_power_disarm: 0 });
    assert.deepEqual(Object.keys(pickEditable(saved())), EDITABLE_FIELDS);
});

test('an unsaved menu choice survives a refresh that overwrites FC.VTX_CONFIG', () => {
    const cfg = saved();
    cfg.band = 1;                       // user picks band A, not saved yet
    cfg.channel = 8;
    const copy = pickEditable(cfg);
    Object.assign(cfg, saved(), { device_ready: 0 });   // the refresh reply: saved values, VTX now silent
    restoreEditable(cfg, copy);
    assert.equal(cfg.band, 1);
    assert.equal(cfg.channel, 8);
    assert.equal(cfg.power, 2);
    assert.equal(cfg.device_ready, 0, 'the ready flag comes from the reply');
});

test('the copy is independent of later changes to FC.VTX_CONFIG', () => {
    const cfg = saved();
    const copy = pickEditable(cfg);
    cfg.power = 4;
    assert.equal(copy.power, 2);
});

test('restoreEditable leaves fields the copy does not have', () => {
    const cfg = saved();
    restoreEditable(cfg, { band: 2 });
    assert.equal(cfg.band, 2);
    assert.equal(cfg.channel, 3);
});

test('readyMessageKey follows the ready byte', () => {
    assert.equal(readyMessageKey({ device_ready: 1 }), 'configurationVTXDeviceReadyYes');
    assert.equal(readyMessageKey({ device_ready: 0 }), 'configurationVTXDeviceReadyNo');
    assert.equal(readyMessageKey({}), 'configurationVTXDeviceReadyNo', 'older state without the field');
});
