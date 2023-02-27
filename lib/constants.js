'use strict';

module.exports = {
    anchoringStatus: {
        NOTHING_TO_ANCHOR: 2,
        ANCHORING_IN_PROGRESS: 1,
        OK: 0,
        PERSIST_BRICKMAP_ERR: -1,
        ANCHOR_VERSION_ERR: -2,
        BRICKMAP_UPDATE_ERR: -3,
        BRICKMAP_LOAD_ERR: -4,
        BRICKMAP_RECONCILE_ERR: -5,
        BRICKMAP_RECONCILIATION_HANDOFF: -6
    }
}
