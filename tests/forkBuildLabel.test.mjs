import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withLabel, configuratorBuildLabel } from '../js/forkBuildLabel.js';

test('version text gets the label after it, nothing extra without one', () => {
    assert.equal(withLabel('10.0.0', 'jb-10.0.0-rc2-c'), '10.0.0 jb-10.0.0-rc2-c');
    assert.equal(withLabel('10.0.0', ''), '10.0.0');
});

test('Configurator built without JB_BUILD_LABEL reports jb-dev', () => {
    assert.equal(configuratorBuildLabel(), 'jb-dev');
});
