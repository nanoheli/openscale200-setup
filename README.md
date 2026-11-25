# OpenScale 200 Setup Assistant

A browser-based guide that sets up the electronics of the OpenScale 200 helicopter
(GOOSKY F4 Mini flight controller, two AM32 ESCs). It runs entirely in the browser via
WebSerial and WebUSB, so it needs **Chrome or Edge on a desktop computer**.

## What it does

1. **Power up**: asks the user to remove the blades, connect USB and the flight battery.
2. **Firmware**: reboots the FC into its DFU bootloader and flashes Rotorflight
   `4.7.0-CI` from master
   [`2a0a8d1`](https://github.com/rotorflight/rotorflight-firmware/commit/2a0a8d10712499651f00a817af5559bab6582b87)
   (the official CI build, `site/firmware/*.hex`). The `GSKY-GOOSKY_F4MINI` target
   config is embedded as custom defaults, the same way the Rotorflight Configurator does
   it. The whole chip is erased, then written, then read back to verify.
3. **Settings**: replays `RTFL_cli_Bo105_Zi_20261125_213215.txt` in the CLI, starting with
   `defaults nosave`, then saves. Lines for features the F405 build doesn't have
   (`cliSkip` in `setup-data.js`) are left out. If the FC rejects any line, nothing is saved until the
   user chooses **Save anyway** or **Discard**. Before sending anything, the board name
   is checked over MSP, because a mismatching `board_name` halts the FC.
4. **ESCs**: switches the FC into 4-way passthrough (`MSP_SET_PASSTHROUGH`) and, for
   motor 1 (main) and motor 2 (tail):
   1. checks that the ESC reports an AM32 ARM bootloader with the 32 KB layout and
      that the firmware tag it carries (0x7BE0) is `GOOSKY_3S_F421` or GOOSKY's factory
      `GSK_3S_F421`. It first waits for the ESCs to reset into their bootloaders, which
      AM32 does 0.5-2 s after the signal stops;
   2. blanks the EEPROM (so an interrupted update leaves the ESC in its bootloader);
   3. flashes `AM32_GOOSKY_3S_F421_2.19.hex` (0x1000-0x7BFF, page by page) and reads it back;
   4. initialises the EEPROM: boot byte 0x01, layout v3, firmware 2.19, tune and CAN area blank;
   5. writes the `.ecf` settings and reads the whole EEPROM back.

   If writing the settings fails, the EEPROM is blanked again so the ESC never starts
   with half-written settings.

## Layout

```
site/                 static site served by GitHub Pages
  js/setup-data.js    all model-specific constants (files, commit, board)
  js/msp.js cli.js    MSP v1 client and CLI driver
  js/dfu.js hex.js    WebUSB DfuSe flasher, Intel HEX + custom defaults
  js/fourway.js       4-way interface client (passthrough protocol)
  js/esc.js           AM32 flash / EEPROM init / settings
  js/app.js           the wizard
  firmware/ config/   files that get flashed / applied
test/
  unit.test.mjs       offline tests (simulated DFU bootloader, simulated 4-way FC + AM32 bootloaders)
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
