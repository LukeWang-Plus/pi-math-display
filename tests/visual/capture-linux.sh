#!/usr/bin/env bash
set -euo pipefail

terminal_name=${1:?usage: capture-linux.sh <terminal> <terminal-bin> <mode> <artifact-dir>}
terminal_bin=${2:?missing terminal executable}
mode=${3:?missing mode}
artifact_dir=$(mkdir -p "$4" && cd "$4" && pwd)
repository_root=$(cd "$(dirname "$0")/../.." && pwd)
fixture="$repository_root/tests/visual/fixture.mjs"
config_dir="$repository_root/tests/visual/config"
run_dir="$artifact_dir/runtime-$mode"
mkdir -p "$run_dir"
chmod 700 "$run_dir"

if [[ $mode == regular ]]; then
  export DISPLAY=:99
else
  export DISPLAY=:100
fi
export XDG_RUNTIME_DIR="$run_dir"
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export GDK_BACKEND=x11
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
terminal_pid=
window_id=
cleanup() {
  touch "$done_file" 2>/dev/null || true
  if [[ -n ${terminal_pid:-} ]]; then
    kill "$terminal_pid" 2>/dev/null || true
  fi
  if [[ $terminal_name == warp ]]; then
    pkill -f 'warp-terminal|/warp ' 2>/dev/null || true
  fi
  [[ -z ${openbox_pid:-} ]] || kill "$openbox_pid" 2>/dev/null || true
  [[ -z ${xvfb_pid:-} ]] || kill "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT

Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset \
  >"$artifact_dir/xvfb-$mode.log" 2>&1 &
xvfb_pid=$!
for _ in $(seq 1 100); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null

eval "$(dbus-launch --sh-syntax)"
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

launch_direct() {
  case "$terminal_name" in
    kitty)
      "$terminal_bin" \
        --config "$config_dir/kitty.conf" \
        --class math-visual \
        --name math-visual \
        --title "$title" \
        node "$fixture" >"$launcher_log" 2>&1 &
      ;;
    ghostty)
      "$terminal_bin" \
        --config-file="$config_dir/ghostty.conf" \
        -e node "$fixture" >"$launcher_log" 2>&1 &
      ;;
    wezterm)
      "$terminal_bin" \
        --config-file "$config_dir/wezterm.lua" \
        start --always-new-process --cwd "$repository_root" -- \
        node "$fixture" >"$launcher_log" 2>&1 &
      ;;
    *) return 2 ;;
  esac
  terminal_pid=$!
}

find_window_by_title() {
  for _ in $(seq 1 450); do
    window_id=$(xdotool search --onlyvisible --name "$title" 2>/dev/null | tail -n 1 || true)
    [[ -z $window_id ]] || return 0
    sleep 0.1
  done
  return 1
}

if [[ $terminal_name == warp ]]; then
  "$terminal_bin" >"$launcher_log" 2>&1 &
  terminal_pid=$!
  for _ in $(seq 1 450); do
    window_id=$(xdotool search --onlyvisible --class 'warp|Warp' 2>/dev/null | tail -n 1 || true)
    [[ -z $window_id ]] || break
    sleep 0.1
  done
  if [[ -z $window_id ]]; then
    import -display "$DISPLAY" -window root "$artifact_dir/${mode}-diagnostic-root.png" || true
    printf 'Warp window did not appear.\n' >&2
    exit 1
  fi
  wmctrl -i -r "$window_id" -e 0,20,20,1600,900 || true
  xdotool windowactivate --sync "$window_id" || true
  xdotool mousemove --window "$window_id" 500 500 click 1 || true
  sleep 2
  printf -v command_line \
    'cd %q && env VISUAL_TERMINAL=%q VISUAL_MODE=%q VISUAL_TITLE=%q READY_FILE=%q DONE_FILE=%q METADATA_FILE=%q NODE_NO_WARNINGS=1 node %q' \
    "$repository_root" "$terminal_name" "$mode" "$title" "$ready_file" \
    "$done_file" "$metadata_file" "$fixture"
  xdotool type --window "$window_id" --delay 1 "$command_line"
  xdotool key --window "$window_id" Return
else
  launch_direct
  if ! find_window_by_title; then
    import -display "$DISPLAY" -window root "$artifact_dir/${mode}-diagnostic-root.png" || true
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
  import -display "$DISPLAY" -window root "$artifact_dir/${mode}-diagnostic-root.png" || true
  xwininfo -root -tree >"$artifact_dir/${mode}-windows.txt" 2>&1 || true
  printf 'Fixture did not become ready: %s\n' "$title" >&2
  exit 1
fi

if ! find_window_by_title; then
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
