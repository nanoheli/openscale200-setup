#!/usr/bin/env bash
# Runs a command against a fresh Rotorflight SITL instance (Windows build).
#   SITL_DIR=/path/to/dir/with/rotorflight_SITL.exe test/with-sitl.sh node test/sitl-cli.test.mjs
# SITL keeps its config in eeprom.bin inside SITL_DIR between runs.
set -u
: "${SITL_DIR:?set SITL_DIR to the folder containing rotorflight_SITL.exe}"

kill_sitl() { taskkill //F //IM rotorflight_SITL.exe >/dev/null 2>&1 || pkill -f rotorflight_SITL >/dev/null 2>&1 || true; }

start_sitl() {
  kill_sitl
  sleep 0.5
  (cd "$SITL_DIR" && rm -f sitl.log && (./rotorflight_SITL.exe > sitl.log 2>&1 &))
  for _ in $(seq 1 60); do
    grep -q 'bind port 5761' "$SITL_DIR/sitl.log" 2>/dev/null && return 0
    sleep 0.5
  done
  echo "SITL did not start" >&2
  return 1
}

start_sitl || exit 1
"$@"
status=$?
kill_sitl
exit $status
