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
    // MSP API version the ESC forward-programming path needs (MSP_SET_4WIF_ESC_FWD_PROG).
    minEscApi: [12, 9],
  },

  escs: [
    { index: 0, motor: 1, role: "Main motor ESC", file: "config/am32_zibo_main_m1.ecf" },
    { index: 1, motor: 2, role: "Tail motor ESC", file: "config/am32_zibo_tail_m2.ecf" },
  ],

  cliDump: "config/RTFL_cli_Bo105_Zi_20261125_213215.txt",
};
