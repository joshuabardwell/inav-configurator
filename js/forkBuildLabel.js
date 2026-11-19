'use strict';

// JB's fork: the Configurator's own build label, so this app can't pass for the official one.
// Set at build time from JB_BUILD_LABEL (see vite.main-renderer.config.js and
// tools/build_label.sh). DOM-free so tests/forkBuildLabel.test.mjs can load it.

const MAX_LABEL_LENGTH = 31;

export function withLabel(text, label) {
    return label ? text + ' ' + label : text;
}

// "jb-dev" when the app was built without JB_BUILD_LABEL (yarn start, web build).
// Only the characters build_label.sh produces are kept: the label also goes into an HTML log line.
export function configuratorBuildLabel() {
    /* global __JB_BUILD_LABEL__ */
    const raw = typeof __JB_BUILD_LABEL__ !== 'undefined' ? String(__JB_BUILD_LABEL__) : '';
    const label = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, MAX_LABEL_LENGTH);
    return label || 'jb-dev';
}
