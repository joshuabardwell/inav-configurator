'use strict';

import { getElevation as lookUpElevation } from './elevationProvider.js';

const ApproachDirection = Object.freeze({
    LEFT: 0,
    RIGHT: 1,
})

let FwApproach = function (number, approachAltAsl = 0, landAltAsl = 0, approachDirection = 0, landHeading1 = 0, landHeading2 = 0, isSeaLevelRef = 0, elevation = 0) {

    var self = {};

    self.getNumber = function () {
        return number;
    };

    self.setNumber = function (data) {
        number = data;
    };

    self.getApproachAltAsl = function () {
        return approachAltAsl;
    }

    self.setApproachAltAsl = function (data) {
        approachAltAsl = data;
    }

    self.getLandAltAsl = function () {
        return landAltAsl;
    }

    self.setLandAltAsl = function (data) {
        landAltAsl = data;
    }

    self.getApproachDirection = function () {
        return approachDirection;
    }

    self.setApproachDirection = function (data) {
        approachDirection = data;
    }

    self.getLandHeading1 = function () {
        return landHeading1;
    }

    self.setLandHeading1 = function (data) {
        landHeading1 = data;
    }

    self.getLandHeading2 = function () {
        return landHeading2;
    }

    self.setLandHeading2 = function (data) {
        landHeading2 = data;
    }

    self.getIsSeaLevelRef = function () {
        return isSeaLevelRef;
    }

    self.setIsSeaLevelRef = function (data) {
        isSeaLevelRef = data;
    }

    self.getElevation = function() {
        return elevation;
    }

    self.setElevation = function (data) {
        elevation = data;
    }

    self.cleanup = function () {
        approachAltAsl = 0;
        landAltAsl = 0;
        approachDirection = 0;
        landHeading1 = 0;
        landHeading2 = 0;
        isSeaLevelRef = 0;
        elevation = 0
    };

    self.getElevationFromServer = async function (lon, lat, globalSettings) {
        // Terrain folder first, online lookup otherwise (js/elevationProvider.js).
        let elevation = "N/A";
        try {
            const result = await lookUpElevation(lat, lon);
            if (result.elevation != null) {
                elevation = result.elevation;
            }
        } catch (error) {
            console.log('Elevation lookup failed: ' + error.message);
        }
        return elevation;
    }

    return self;
};

export { ApproachDirection, FwApproach };
