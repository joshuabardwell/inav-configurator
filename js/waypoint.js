'use strict';

import { getElevation as lookUpElevation } from './elevationProvider.js';

let Waypoint = function (number, action, lat, lon, alt=0, p1=0, p2=0, p3=0, endMission=0, isUsed=true, isAttached=false, attachedId="", multiMissionIdx = 0) {

    var self = {};
    let layerNumber = "undefined";
    let attachedNumber = "undefined";
    let poiNumber = "undefined";
    let elevationSource = "none";
    let elevationFile = null;

    self.getNumber = function () {
        return number;
    };

    self.setNumber = function (data) {
        number = data;
    };

    self.getLayerNumber = function () {
        return layerNumber;
    };

    self.setLayerNumber = function (data) {
        layerNumber = data;
    };

    self.getPoiNumber = function () {
        return poiNumber;
    };

    self.setPoiNumber = function (data) {
        poiNumber = data;
    };

    self.isUsed = function () {
        return isUsed;
    };

    self.setUsed = function (data) {
        isUsed = data;
    };

    self.isAttached = function () {
        return isAttached;
    };

    self.setAttached = function (data) {
        isAttached = data;
    };

    self.getLon = function () {
        return lon;
    };

    self.getLonMap = function () {
        return lon / 10000000;
    };

    self.setLon = function (data) {
        lon = data;
    };

    self.getLat = function () {
        return lat;
    };

    self.getLatMap = function () {
        return lat / 10000000;
    };

    self.setLat = function (data) {
        lat = data;
    };

    self.getAction = function () {
        return action;
    };

    self.setAction = function (data) {
        action = data;
    };

    self.getAlt = function () {
        return alt;
    };

    self.setAlt = function (data) {
        alt = data;
    };

    self.getP1 = function () {
        return p1;
    };

    self.setP1 = function (data) {
        p1 = data;
    };

    self.getP2 = function () {
        return p2;
    };

    self.setP2 = function (data) {
        p2 = data;
    };

    self.getP3 = function () {
        return p3;
    };

    self.setP3 = function (data) {
        p3 = data;
    };

    self.getEndMission = function () {
        return endMission;
    };

    self.setEndMission = function (data) {
        endMission = data;
    };

    self.getAttachedId = function () {
        return attachedId;
    };

    self.setAttachedId = function (data) {
        attachedId = data;
    };

    self.getAttachedNumber = function () {
        return attachedNumber;
    };

    self.setAttachedNumber = function (data) {
        attachedNumber = data;
    };

    self.setMultiMissionIdx = function(data) {
        multiMissionIdx = data;
    }

    self.getMultiMissionIdx = function() {
        return multiMissionIdx;
    }

    // Ground elevation in metres, or "N/A". Comes from the terrain folder when it has
    // the file, otherwise from the online lookup (js/elevationProvider.js).
    self.getElevation = async function (globalSettings) {
        let elevation = "N/A";
        elevationSource = "none";
        elevationFile = null;
        try {
            const result = await lookUpElevation(self.getLatMap(), self.getLonMap());
            elevationSource = result.source;
            elevationFile = result.file || null;
            if (result.elevation != null) {
                elevation = result.elevation;
            }
        } catch (error) {
            console.log('Elevation lookup failed: ' + error.message);
        }
        return elevation;
    }

    // Where the last getElevation() answer came from: an ElevationSource value of
    // js/elevationProvider.js ("ter", "copernicus", "aster" or "none").
    self.getElevationSource = function () {
        return elevationSource;
    }

    // Name of the terrain file that answer was read from (N47E008.TER), or null.
    self.getElevationFile = function () {
        return elevationFile;
    }

    return self;
};

export default Waypoint;
