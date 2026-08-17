#!/usr/bin/env bash
set -euo pipefail

mode=${1:?usage: capture-iterm.sh <mode> <artifact-dir>}
artifact_dir=$(mkdir -p "$2" && cd "$2" && pwd)
repository_root=$(cd "$(dirname "$0")/../.." && pwd)
fixture="$repository_root/tests/visual/fixture.mjs"
title="math-visual-iterm2-${mode}"
ready_file="$artifact_dir/${mode}.ready"
done_file="$artifact_dir/${mode}.done"
metadata_file="$artifact_dir/${mode}.json"
screenshot="$artifact_dir/${mode}.png"
wrapper="$artifact_dir/run-${mode}.sh"
launcher_log="$artifact_dir/${mode}-launcher.log"
iterm_bin=/Applications/iTerm.app/Contents/MacOS/iTerm2
iterm_pid=
rm -f "$ready_file" "$done_file" "$metadata_file" "$screenshot" "$launcher_log"

cat >"$wrapper" <<EOF
#!/usr/bin/env bash
cd $(printf '%q' "$repository_root")
export VISUAL_TERMINAL=iterm2
export VISUAL_MODE=$(printf '%q' "$mode")
export VISUAL_TITLE=$(printf '%q' "$title")
export READY_FILE=$(printf '%q' "$ready_file")
export DONE_FILE=$(printf '%q' "$done_file")
export METADATA_FILE=$(printf '%q' "$metadata_file")
export NODE_NO_WARNINGS=1
exec node $(printf '%q' "$fixture")
EOF
chmod +x "$wrapper"

cleanup() {
  touch "$done_file" 2>/dev/null || true
  if [[ -n ${iterm_pid:-} ]]; then
    kill "$iterm_pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$iterm_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$iterm_pid" 2>/dev/null || true
    wait "$iterm_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

printf 'launch=%q %q\n' "$iterm_bin" "--command=$wrapper" >"$launcher_log"
"$iterm_bin" "--command=$wrapper" >>"$launcher_log" 2>&1 &
iterm_pid=$!

for _ in $(seq 1 900); do
  [[ ! -f $ready_file ]] || break
  sleep 0.1
done
if [[ ! -f $ready_file ]]; then
  screencapture -x "$artifact_dir/${mode}-diagnostic-screen.png" || true
  printf 'iTerm2 fixture did not become ready: %s\n' "$title" >&2
  exit 1
fi

# LaunchServices can activate the already-running app without Apple Events,
# avoiding the hosted runner's interactive Automation permission dialog.
open -a iTerm >>"$launcher_log" 2>&1 || true
sleep 1
printf 'capture=full-display\n' >"$artifact_dir/${mode}-window.txt"
screencapture -x "$screenshot"
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
sleep 1
