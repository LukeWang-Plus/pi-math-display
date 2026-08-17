#!/usr/bin/env bash
set -euo pipefail

terminal_name=${1:?usage: capture-linux.sh <terminal> <terminal-bin> <mode> <artifact-dir>}
terminal_bin=${2:?missing terminal executable}
mode=${3:?missing mode}
artifact_dir=$(mkdir -p "$4" && cd "$4" && pwd)
repository_root=$(cd "$(dirname "$0")/../.." && pwd)
fixture="$repository_root/tests/visual/fixture.mjs"
config_dir="$repository_root/tests/visual/config"

case "$mode" in
  regular | fullscreen) ;;
  *)
    printf 'Unsupported capture mode: %s\n' "$mode" >&2
    exit 2
    ;;
esac

# Keep runtime sockets short enough for UNIX-domain socket limits and isolate
# every terminal/mode from state left by another capture on the same runner.
session_root=$(mktemp -d "/tmp/math-visual-${terminal_name}-${mode}.XXXXXX")
export XDG_RUNTIME_DIR="$session_root/runtime"
export XDG_CONFIG_HOME="$session_root/config"
export XDG_CACHE_HOME="$session_root/cache"
export XDG_DATA_HOME="$session_root/data"
export XDG_STATE_HOME="$session_root/state"
mkdir -p \
  "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" \
  "$XDG_DATA_HOME" "$XDG_STATE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"

if [[ $mode == regular ]]; then
  export DISPLAY=:99
else
  export DISPLAY=:100
fi
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export GDK_BACKEND=x11
export GTK_A11Y=none
export WINIT_UNIX_BACKEND=x11
unset WAYLAND_DISPLAY || true

title="math-visual-${terminal_name}-${mode}"
ready_file="$artifact_dir/${mode}.ready"
done_file="$artifact_dir/${mode}.done"
metadata_file="$artifact_dir/${mode}.json"
screenshot="$artifact_dir/${mode}.png"
launcher_log="$artifact_dir/${mode}-launcher.log"
rm -f "$ready_file" "$done_file" "$metadata_file" "$screenshot"

xvfb_pid=
openbox_pid=
dbus_pid=
terminal_pid=
terminal_pgid=
window_id=

record_session_diagnostics() {
  {
    printf 'session_root=%s\n' "$session_root"
    find "$session_root" -maxdepth 5 -printf '%y %p\n' 2>/dev/null || true
  } >"$artifact_dir/${mode}-session-files.txt"

  if [[ $terminal_name == wezterm ]]; then
    while IFS= read -r -d '' log_file; do
      cp "$log_file" "$artifact_dir/${mode}-$(basename "$log_file")" || true
    done < <(find "$session_root" -type f -name 'wezterm-gui-log-*.txt' -print0 2>/dev/null)
  fi
}

stop_terminal_group() {
  if [[ -n ${terminal_pgid:-} ]]; then
    kill -TERM -- "-$terminal_pgid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 -- "-$terminal_pgid" 2>/dev/null || return 0
      sleep 0.1
    done
    kill -KILL -- "-$terminal_pgid" 2>/dev/null || true
  elif [[ -n ${terminal_pid:-} ]]; then
    kill "$terminal_pid" 2>/dev/null || true
  fi
}

cleanup() {
  touch "$done_file" 2>/dev/null || true
  stop_terminal_group
  record_session_diagnostics
  [[ -z ${openbox_pid:-} ]] || kill "$openbox_pid" 2>/dev/null || true
  [[ -z ${xvfb_pid:-} ]] || kill "$xvfb_pid" 2>/dev/null || true
  [[ -z ${dbus_pid:-} ]] || kill "$dbus_pid" 2>/dev/null || true
  rm -rf "$session_root"
}
trap cleanup EXIT

capture_root_diagnostics() {
  import -display "$DISPLAY" -window root \
    "$artifact_dir/${mode}-diagnostic-root.png" || true
  xwininfo -root -tree >"$artifact_dir/${mode}-windows.txt" 2>&1 || true
  wmctrl -lx >"$artifact_dir/${mode}-wmctrl.txt" 2>&1 || true
}

Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset \
  >"$artifact_dir/xvfb-$mode.log" 2>&1 &
xvfb_pid=$!
for _ in $(seq 1 100); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null

eval "$(dbus-launch --sh-syntax)"
dbus_pid=${DBUS_SESSION_BUS_PID:-}
openbox >"$artifact_dir/openbox-$mode.log" 2>&1 &
openbox_pid=$!
sleep 1

export VISUAL_TERMINAL="$terminal_name"
export VISUAL_MODE="$mode"
export VISUAL_TITLE="$title"
export READY_FILE="$ready_file"
export DONE_FILE="$done_file"
export METADATA_FILE="$metadata_file"
export NODE_NO_WARNINGS=1

launch_in_session() {
  setsid "$@" >"$launcher_log" 2>&1 &
  terminal_pid=$!
  terminal_pgid=$terminal_pid
}

launch_direct() {
  case "$terminal_name" in
    kitty)
      launch_in_session "$terminal_bin" \
        --config "$config_dir/kitty.conf" \
        --class math-visual \
        --name math-visual \
        --title "$title" \
        node "$fixture"
      ;;
    ghostty)
      launch_in_session "$terminal_bin" \
        --config-file="$config_dir/ghostty.conf" \
        -e node "$fixture"
      ;;
    wezterm)
      launch_in_session "$terminal_bin" \
        --config-file "$config_dir/wezterm.lua" \
        start --always-new-process --cwd "$repository_root" -- \
        node "$fixture"
      ;;
    *) return 2 ;;
  esac
}

search_window_once() {
  if [[ $terminal_name == warp ]]; then
    window_id=$(xdotool search --onlyvisible --class 'warp|Warp' 2>/dev/null | tail -n 1 || true)
  else
    window_id=$(xdotool search --onlyvisible --name "$title" 2>/dev/null | tail -n 1 || true)
  fi
  [[ -n $window_id ]]
}

find_terminal_window() {
  local attempts=${1:-450}
  for _ in $(seq 1 "$attempts"); do
    if search_window_once; then return 0; fi
    sleep 0.1
  done
  return 1
}

prepare_warp_state() {
  local preferences_dir="$XDG_CONFIG_HOME/warp-terminal"
  local preferences_file="$preferences_dir/user_preferences.json"
  mkdir -p "$preferences_dir"
  cat >"$preferences_file" <<'JSON'
{
  "prefs": {
    "HasCompletedOnboarding": "true",
    "HasCompletedHOAOnboarding": "true",
    "SettingsFileMigrationComplete": "true"
  }
}
JSON
  chmod 600 "$preferences_file"
  cp "$preferences_file" "$artifact_dir/${mode}-warp-user-preferences.json"
}

if [[ $terminal_name == warp ]]; then
  # This suite verifies terminal rendering, not Warp's first-run wizard. Seed
  # only Warp's documented local completion markers in this isolated XDG tree.
  prepare_warp_state
  launch_in_session "$terminal_bin"
  if ! find_terminal_window; then
    capture_root_diagnostics
    printf 'Warp window did not appear.\n' >&2
    exit 1
  fi
  wmctrl -i -r "$window_id" -e 0,20,20,1600,900 || true
  xdotool windowactivate --sync "$window_id" || true
  sleep 4
  xdotool key --clearmodifiers --window "$window_id" Escape || true
  xdotool mousemove --window "$window_id" 800 700 click 1 || true
  sleep 1
  printf -v command_line \
    'cd %q && env VISUAL_TERMINAL=%q VISUAL_MODE=%q VISUAL_TITLE=%q READY_FILE=%q DONE_FILE=%q METADATA_FILE=%q NODE_NO_WARNINGS=1 node %q' \
    "$repository_root" "$terminal_name" "$mode" "$title" "$ready_file" \
    "$done_file" "$metadata_file" "$fixture"
  xdotool type --clearmodifiers --window "$window_id" --delay 1 "$command_line"
  xdotool key --clearmodifiers --window "$window_id" Return
else
  launch_direct
  if ! find_terminal_window; then
    capture_root_diagnostics
    printf 'Terminal window with title %s did not appear.\n' "$title" >&2
    exit 1
  fi
  wmctrl -i -r "$window_id" -e 0,20,20,1600,900 || true
fi

for _ in $(seq 1 900); do
  [[ ! -f $ready_file ]] || break
  sleep 0.1
done
if [[ ! -f $ready_file ]]; then
  capture_root_diagnostics
  printf 'Fixture did not become ready: %s\n' "$title" >&2
  exit 1
fi

if ! find_terminal_window; then
  capture_root_diagnostics
  printf 'Fixture became ready but its window disappeared: %s\n' "$title" >&2
  exit 1
fi
wmctrl -i -r "$window_id" -e 0,20,20,1600,900 || true
xdotool windowactivate --sync "$window_id" || true
sleep 1
xprop -id "$window_id" >"$artifact_dir/${mode}-window.txt" 2>&1 || true
import -display "$DISPLAY" -window "$window_id" "$screenshot"
identify "$screenshot" >"$artifact_dir/${mode}-identify.txt"

read -r width height < <(identify -format '%w %h' "$screenshot")
standard_deviation=$(convert "$screenshot" -colorspace Gray -format '%[fx:standard_deviation]' info:)
python3 - "$width" "$height" "$standard_deviation" <<'PY'
import sys
width, height = map(int, sys.argv[1:3])
standard_deviation = float(sys.argv[3])
if width < 500 or height < 300:
    raise SystemExit(f"screenshot is unexpectedly small: {width}x{height}")
if standard_deviation < 0.01:
    raise SystemExit(f"screenshot appears blank: standard deviation={standard_deviation}")
PY
printf 'width=%s\nheight=%s\nstandard_deviation=%s\n' \
  "$width" "$height" "$standard_deviation" \
  >"$artifact_dir/${mode}-validation.txt"

touch "$done_file"
for _ in $(seq 1 100); do
  kill -0 "$terminal_pid" 2>/dev/null || break
  sleep 0.1
done
