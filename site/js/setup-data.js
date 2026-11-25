// Everything specific to this helicopter lives here. To prepare the tool for a
// different model or firmware, replace the files in /firmware and /config and
// update this object.

export const SETUP = {
  model: "OpenScale 200",
  craftName: "Bo105_Zi",

  board: {
    name: "GOOSKY_F4MINI",
    manufacturer: "GSKY",
    mcu: "STM32F405",
  },

  firmware: {
    version: "4.7.0-CI",
    commit: "2a0a8d1",
    commitUrl:
      "https://github.com/rotorflight/rotorflight-firmware/commit/2a0a8d10712499651f00a817af5559bab6582b87",
    hex: "firmware/rotorflight_4.7.0-CI-2a0a8d1_STM32F405.hex",
    // rotorflight-targets config embedded as custom defaults, exactly like the
    // Rotorflight Configurator does when flashing a board target.
    targetConfig: "firmware/GSKY-GOOSKY_F4MINI.config",
    targetConfigName: "GSKY-GOOSKY_F4MINI.config",
    targetsCommit: {
      commitHash: "1d9cb4dc6f85c7895c2b089f4b8aa776ca3d3bd3",
      date: "2026-06-30T17:50:14+02:00",
    },
  },

  // AM32 firmware flashed to both ESCs through the FC's 4-way passthrough.
  escFirmware: {
    hex: "firmware/AM32_GOOSKY_3S_F421_2.19.hex",
    tag: "GOOSKY_3S_F421",
    fwMajor: 2,
    fwMinor: 19,
    eepromVersion: 3, // EEPROM layout of AM32 2.19 (same as the .ecf files)
  },

  escs: [
    { index: 0, motor: 1, role: "Main motor ESC", file: "config/am32_zibo_main_m1.ecf" },
    { index: 1, motor: 2, role: "Tail motor ESC", file: "config/am32_zibo_tail_m2.ecf" },
  ],

  cliDump: "config/RTFL_cli_Bo105_Zi_20261125_213215.txt",
};
