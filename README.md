# OpenScale 200 Setup Assistant

A browser-based guide that sets up the electronics of the OpenScale 200 helicopter
(GOOSKY F4 Mini flight controller, two AM32 ESCs). It runs entirely in the browser via
WebSerial and WebUSB, so it needs **Chrome or Edge on a desktop computer**.

## What it does

1. **Power up**: asks the user to remove the blades, connect USB and the flight battery.
2. **ESCs**: writes `site/config/am32_zibo_main_m1.ecf` to motor 1 (main) and
   `am32_zibo_tail_m2.ecf` to motor 2 (tail). This goes through Rotorflight's MSP ESC
   forward-programming bridge (`MSP_SET_4WIF_ESC_FWD_PROG`, needs MSP API 12.9 or newer).
   The ESC's own identity bytes (EEPROM start byte, layout version, bootloader and
   firmware version) are kept, the settings come from the file, and every write is
   read back to verify it. The write is refused if the ESC's EEPROM layout version
   differs from the file's.
3. **Firmware**: reboots the FC into its DFU bootloader and flashes Rotorflight
   `4.7.0-CI` from master
   [`2a0a8d1`](https://github.com/rotorflight/rotorflight-firmware/commit/2a0a8d10712499651f00a817af5559bab6582b87)
   (the official CI build, `site/firmware/*.hex`). The `GSKY-GOOSKY_F4MINI` target
   config is embedded as custom defaults, the same way the Rotorflight Configurator does
   it. The whole chip is erased, then written, then read back to verify.
4. **Settings**: replays `RTFL_cli_Bo105_Zi_20261125_213215.txt` in the CLI, starting with
   `defaults nosave`, then saves. If the FC rejects any line, nothing is saved until the
   user chooses **Save anyway** or **Discard**. Before sending anything, the board name
   is checked over MSP, because a mismatching `board_name` halts the FC.

If the FC firmware is too old for ESC programming, the ESC step is moved to after the
firmware and settings steps.

## Layout

```
site/                 static site served by GitHub Pages
  js/setup-data.js    all model-specific constants (files, commit, board)
  js/msp.js cli.js    MSP v1 client and CLI driver
  js/dfu.js hex.js    WebUSB DfuSe flasher, Intel HEX + custom defaults
  js/esc.js           AM32 programming via the FC
  js/app.js           the wizard
  firmware/ config/   files that get flashed / applied
test/
  unit.test.mjs       offline tests (simulated DFU bootloader + simulated FC/ESCs)
  sitl-*.test.mjs     replays MSP/CLI against Rotorflight SITL of the same commit
```

## Develop / test

```sh
python -m http.server -d site 8000        # WebSerial/WebUSB work on http://localhost
node test/unit.test.mjs                   # CONFIGURATOR_DIR=../rotorflight-configurator also compares the HEX output byte for byte
SITL_DIR=/path/to/sitl bash test/with-sitl.sh node test/sitl-cli.test.mjs --save
```

## Updating to other files

Replace the files in `site/firmware` and `site/config`, then update `site/js/setup-data.js`.

## Deploy

Pushing to `main` runs the tests and deploys `site/` with GitHub Pages
(Settings → Pages → Source: *GitHub Actions*).

Rotorflight firmware and logo © the Rotorflight project, GPL-3.0. Firmware source:
https://github.com/rotorflight/rotorflight-firmware
