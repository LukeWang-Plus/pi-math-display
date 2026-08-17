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
window_id=
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
  if [[ -n ${window_id:-} ]]; then
    osascript - "$window_id" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  set targetWindowId to (item 1 of argv) as integer
  tell application "/Applications/iTerm.app"
    repeat with candidateWindow in windows
      if id of candidateWindow is targetWindowId then
        close candidateWindow
        exit repeat
      end if
    end repeat
  end tell
end run
APPLESCRIPT
  fi
}
trap cleanup EXIT

if ! window_id=$(osascript - "$wrapper" <<'APPLESCRIPT' 2>"$launcher_log"
on run argv
  set launchCommand to quoted form of (item 1 of argv)
  tell application "/Applications/iTerm.app"
    set testWindow to (create window with default profile command launchCommand)
    try
      set bounds of testWindow to {20, 40, 1620, 940}
    end try
    select testWindow
    activate
    return id of testWindow
  end tell
end run
APPLESCRIPT
); then
  screencapture -x "$artifact_dir/${mode}-diagnostic-screen.png" || true
  cat "$launcher_log" >&2 || true
  exit 1
fi
printf 'native_window_id=%s\n' "$window_id" >>"$launcher_log"

for _ in $(seq 1 900); do
  [[ ! -f $ready_file ]] || break
  sleep 0.1
done
if [[ ! -f $ready_file ]]; then
  screencapture -x "$artifact_dir/${mode}-diagnostic-screen.png" || true
  printf 'iTerm2 fixture did not become ready: %s\n' "$title" >&2
  exit 1
fi

sleep 1
bounds=$(osascript - "$window_id" <<'APPLESCRIPT' 2>/dev/null || true
on run argv
  set targetWindowId to (item 1 of argv) as integer
  tell application "/Applications/iTerm.app"
    repeat with candidateWindow in windows
      if id of candidateWindow is targetWindowId then
        return bounds of candidateWindow
      end if
    end repeat
  end tell
end run
APPLESCRIPT
)
printf 'bounds=%s\n' "$bounds" >"$artifact_dir/${mode}-window.txt"

# Prefer the exact native window surface. The fixed rectangle remains a
# fallback for hosted macOS runners that reject native-window capture.
if ! screencapture -x -l "$window_id" "$screenshot" 2>>"$launcher_log"; then
  screencapture -x -R20,40,1600,900 "$screenshot"
fi
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
