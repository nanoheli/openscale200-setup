// Intel HEX parsing and custom-defaults insertion.
// Ported from rotorflight-configurator (src/js/workers/hex_parser.js,
// src/js/ConfigInserter.js and src/tabs/firmware_flasher/util.js) so the
// flashed image is byte-identical to what the Configurator would produce.

export function parseHex(text) {
  const lines = text.split("\n");
  if (lines[lines.length - 1].trim() === "") lines.pop();

  const result = { data: [], end_of_file: false, bytes_total: 0, start_linear_address: 0 };
  let extendedLinearAddress = 0;
  let nextAddress = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith(":")) throw new Error("Invalid HEX file: line without ':'");
    const byteCount = parseInt(line.substr(1, 2), 16);
    const address = parseInt(line.substr(3, 4), 16);
    const recordType = parseInt(line.substr(7, 2), 16);
    const content = line.substr(9, byteCount * 2);
    const checksum = parseInt(line.substr(9 + byteCount * 2, 2), 16);

    let crc = byteCount + parseInt(line.substr(3, 2), 16) + parseInt(line.substr(5, 2), 16) + recordType;

    switch (recordType) {
      case 0x00: {
        if (address !== nextAddress || nextAddress === 0) {
          result.data.push({ address: extendedLinearAddress + address, bytes: 0, data: [] });
        }
        nextAddress = address + byteCount;
        const block = result.data[result.data.length - 1];
        for (let i = 0; i < byteCount * 2; i += 2) {
          const num = parseInt(content.substr(i, 2), 16);
          block.data.push(num);
          block.bytes++;
          crc += num;
          result.bytes_total++;
        }
        if (((~crc + 1) & 0xff) !== checksum) throw new Error("Invalid HEX file: checksum error");
        break;
      }
      case 0x01:
        result.end_of_file = true;
        break;
      case 0x04:
        extendedLinearAddress =
          ((parseInt(content.substr(0, 2), 16) << 24) | (parseInt(content.substr(2, 2), 16) << 16)) >>> 0;
        break;
      case 0x05:
        result.start_linear_address = parseInt(content, 16);
        break;
      default:
        break;
    }
  }

  if (!result.end_of_file) throw new Error("Invalid HEX file: missing end-of-file record");
  return result;
}

// ---- custom defaults (rotorflight-targets config) -------------------------

const CUSTOM_DEFAULTS_POINTER_ADDRESS = 0x08002800;
const BLOCK_SIZE = 16384;

function seek(firmware, address) {
  let index = 0;
  for (; index < firmware.data.length && address >= firmware.data[index].address + firmware.data[index].bytes; index++);
  const result = { lineIndex: index };
  if (firmware.data[index] && address >= firmware.data[index].address) {
    result.byteIndex = address - firmware.data[index].address;
  }
  return result;
}

function readUint32(firmware, index) {
  let result = 0;
  for (let position = 0; position < 4; position++) {
    result += firmware.data[index.lineIndex].data[index.byteIndex++] << (8 * position);
    if (index.byteIndex >= firmware.data[index.lineIndex].bytes) {
      index.lineIndex++;
      index.byteIndex = 0;
    }
  }
  return result >>> 0;
}

function getCustomDefaultsArea(firmware) {
  const index = seek(firmware, CUSTOM_DEFAULTS_POINTER_ADDRESS);
  if (index.byteIndex === undefined) return undefined;
  return { startAddress: readUint32(firmware, index), endAddress: readUint32(firmware, index) };
}

export function insertConfig(firmware, input) {
  const area = getCustomDefaultsArea(firmware);
  if (!area || area.endAddress - area.startAddress === 0) {
    throw new Error("This firmware has no custom defaults area.");
  }
  if (input.length >= area.endAddress - area.startAddress) {
    throw new Error(`Custom defaults area too small (${area.endAddress - area.startAddress} bytes).`);
  }

  let address = area.startAddress;
  const index = seek(firmware, address);
  if (index.byteIndex !== undefined) throw new Error("Configuration area in firmware not free.");

  input += "\0";
  let inputIndex = 0;
  while (inputIndex < input.length) {
    const remaining = input.length - inputIndex;
    const line = { address, bytes: Math.min(BLOCK_SIZE, remaining), data: [] };
    if (firmware.data[index.lineIndex] && line.address + line.bytes > firmware.data[index.lineIndex].address) {
      throw new Error("Custom defaults area too small.");
    }
    for (let i = 0; i < line.bytes; i++) line.data.push(input.charCodeAt(inputIndex++));
    address += line.bytes;
    firmware.data.splice(index.lineIndex++, 0, line);
  }
  firmware.bytes_total += input.length;
  firmware.configInserted = true;
  return firmware;
}

export function cleanUnifiedConfigFile(input) {
  let output = "";
  input.split(/[\r\n]+/).forEach((rawLine, index) => {
    let line = rawLine;
    if (!(index === 0 && line.match(/^# [A-Za-z]*flight/))) {
      line = line.replace(/#.*$/, "").replace(/[ \t]+$/, "").replace(/[ \t]+/, " ").replace(/^[ ]*$/, "");
      if (line.length === 0) return;
    }
    output += line + "\n";
  });
  return output;
}

export function buildCustomDefaults(rawConfig, { configName, boardName, manufacturerId, commitInfo }) {
  let cfg = cleanUnifiedConfigFile(rawConfig);
  if (!/board_design [A-Za-z0-9_+-]+\n/m.test(cfg)) {
    cfg = cfg.replace(/board_name [A-Za-z0-9_+-]+\n/m, (m) => m + "board_design BTFL\n");
  }
  cfg = cfg.replace(/# config: manufacturer_id: .*\n/gm, "");
  return (
    "## Rotorflight Custom Defaults\n" +
    `# config: ${configName}\n` +
    `# board: ${boardName}\n` +
    `# make: ${manufacturerId}\n` +
    `# hash: ${commitInfo.commitHash}\n` +
    `# date: ${commitInfo.date}\n` +
    "##\n" +
    cfg
  );
}
