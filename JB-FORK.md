# INAV Configurator JB: what is different

This is a test fork of [iNavFlight/inav-configurator](https://github.com/iNavFlight/inav-configurator),
built to go with [JB's INAV 10 firmware fork](https://github.com/joshuabardwell/inav). It is not
an official release and the INAV team does not support it. The app is called
**INAV Configurator JB** and shows its build label.

The branch `jb/build` is the one to use: upstream plus the changes below. Each change also
lives on its own topic branch (`jb/wpterrain`, `jb/terrainfolder`, `jb/vtxtable`, and others)
if you want to read one alone.

`jb/build` is rebuilt when upstream releases, so its history is rewritten and a plain
`git pull` will fail. To update a clone, run `git fetch` and then
`git reset --hard origin/jb/build` (this discards any local changes on that branch).

No installers are published. Build it yourself (see
[Running and building](#running-and-building)); the commit history on `jb/build` shows what
changed and when.

## What the fork adds

### Mission planner (Mission Control)

- **Terrain options per waypoint.** Each waypoint can carry a terrain mode (off, floor,
  follow) and its own minimum height above ground. Mission files keep them. What the options
  do in flight is in the firmware's
  [Waypoint missions](https://github.com/joshuabardwell/inav/blob/jb/build/docs/Navigation%20Terrain%20Following.md#waypoint-missions).
- **Predicted altitude and ground check.** The planner draws the altitude the firmware's
  terrain legs will fly, using the same rules (the line over the ground ahead, the lead of
  the altitude target, the descent limit), and checks the ground under each turn.
  Warning marks on the route have hover text saying what they mean.
- **Elevation source and terrain files.** Choose where elevation data comes from; the planner
  keeps the tiles it fetches. The planner and the Map Generator share one terrain folder, with
  `.TER` as the only saved elevation format. A block in both tabs shows the folder, the status
  of the terrain file at the selected waypoint, and lets you copy terrain to a drive (an SD
  card, including the drive root) with a reason when a copy fails.

### Map Generator

- Offline terrain and imagery data, with a live download-size estimate.
- Terrain mode hides the imagery tile cache box. "Download for Offline Use" is in the bottom
  bar.

### VTX

- A VTX table editor in the Configuration tab (loads a Betaflight VTX table JSON file) and a
  readout of whether the VTX is ready. The OSD preview shows the table's power label. The
  firmware side is [VTx.md](https://github.com/joshuabardwell/inav/blob/jb/build/docs/VTx.md#vtx-table-vtxtable).

### Branding

- Named "INAV Configurator JB", with the build label shown in the app. It keeps the official
  app's settings folder (`%APPDATA%\INAV Configurator` on Windows), so **the two apps share
  settings**. Changing a setting in one changes it in the other.

## Use it with the fork's firmware

Several features here need the matching firmware on the flight controller: new MSP commands
were added on both sides, in the `0x2F00` range. Use `jb/build` of both repositories.

## Running and building

Build as upstream's [README](README.md#building-and-running-inav-configurator-locally-for-development)
describes: install Node.js and Yarn, then in a clone of this repository on `jb/build` run
`yarn install` and `yarn start`, or `yarn run make` to package the app for your platform.
Packages from a fork build are not signed, so macOS may need the `xattr -cr` step in that README.

A build is named `jb-<build date>-<commit>`. If you report a problem, give that label.

## Reporting results

Open an issue on this repository with the build label, your OS, and the steps that led to the
problem. A screenshot or the mission file helps. Problems that exist in upstream's Configurator
are better reported to [iNavFlight/inav-configurator](https://github.com/iNavFlight/inav-configurator/issues).
