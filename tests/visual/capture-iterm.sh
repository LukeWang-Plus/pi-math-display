#!/usr/bin/env bash
set -euo pipefail

mode=${1:?usage: capture-iterm.sh <mode> <artifact-dir>}
artifact_dir=$(mkdir -p "$2" && cd "$2" && pwd)
repository_root=$(cd "$(dirname "$0")/../.." && pwd)
fixture="$repository_root/tests/visual/fixture.mjs"
profile_source="$repository_root/tests/visual/config/iterm2.json"
title="math-visual-iterm2-${mode}"
ready_file="$artifact_dir/${mode}.ready"
done_file="$artifact_dir/${mode}.done"
metadata_file="$artifact_dir/${mode}.json"
screenshot="$artifact_dir/${mode}.png"
wrapper="$artifact_dir/run-${mode}.sh"
launcher_log="$artifact_dir/${mode}-launcher.log"
iterm_bin=/Applications/iTerm.app/Contents/MacOS/iTerm2
profile_guid=math-visual-iterm2-profile
session_root=$(mktemp -d "/tmp/math-visual-iterm2-${mode}.XXXXXX")
iterm_pid=

# Isolate preferences, application support, session restoration, and first-run
# state from both the runner and the other capture mode.
export HOME="$session_root/home"
export CFFIXED_USER_HOME="$HOME"
preferences_dir="$HOME/Library/Preferences"
dynamic_profiles_dir="$HOME/Library/Application Support/iTerm2/DynamicProfiles"
mkdir -p "$preferences_dir" "$dynamic_profiles_dir"
cp "$profile_source" "$dynamic_profiles_dir/math-visual.json"
cp "$profile_source" "$artifact_dir/${mode}-iterm-profile.json"
rm -f "$ready_file" "$done_file" "$metadata_file" "$screenshot" "$launcher_log"

configure_iterm() {
  local domain=com.googlecode.iterm2

  # Sparkle and launch-experience prompts.
  defaults write "$domain" SUEnableAutomaticChecks -bool false
  defaults write "$domain" SUAutomaticallyUpdate -bool false
  defaults write "$domain" SUSendProfileInfo -bool false
  defaults write "$domain" SUHasLaunchedBefore -bool true
  defaults write "$domain" CheckTestRelease -bool false
  defaults write "$domain" NoSyncTipsDisabled -bool true
  defaults write "$domain" NoSyncOnboardingWindowHasBeenShown34 -bool true
  defaults write "$domain" NoSyncHaveWarnedAboutPasteConfirmationChange -bool true
  defaults write "$domain" NoSyncLaunchExperienceControllerRunCount -int 100
  defaults write "$domain" NoSyncLastSystemPythonVersionRequirement -string "1.17"

  # Allow the OSC 1337 image under test without an interactive security sheet.
  # Selection 0 is the first action ("Yes") in iTerm2's warning model.
  defaults write "$domain" NoSyncSuppressDownloadConfirmation -bool true
  defaults write "$domain" NoSyncSuppressDownloadConfirmation_selection -int 0

  # Use only the deterministic dynamic profile and never restore another mode's
  # window, shell, daemon, or saved terminal contents.
  defaults write "$domain" "Default Bookmark Guid" -string "$profile_guid"
  defaults write "$domain" OpenBookmark -bool false
  defaults write "$domain" OpenArrangementAtStartup -bool false
  defaults write "$domain" AlwaysOpenWindowAtStartup -bool false
  defaults write "$domain" OpenNoWindowsAtStartup -bool true
  defaults write "$domain" OpenUntitledFile -bool false
  defaults write "$domain" OpenNewWindowAtStartup -bool false
  defaults write "$domain" QuitWhenAllWindowsClosed -bool true
  defaults write "$domain" OnlyWhenMoreTabs -bool false
  defaults write "$domain" PromptOnQuit -bool false
  defaults write "$domain" PromptOnQuitEvenIfThereAreNoWindows -bool false
  defaults write "$domain" NSQuitAlwaysKeepsWindows -bool false
  defaults write "$domain" ApplePersistenceIgnoreState -bool true
  defaults write "$domain" NoSyncIgnoreSystemWindowRestoration -bool true
  defaults write "$domain" RunJobsInServers -bool false
  defaults write "$domain" RestoreWindowContents -bool false
  defaults write "$domain" UseRestorableStateController -bool false
  defaults write "$domain" SuppressRestartAnnouncement -bool true
  defaults write "$domain" MinRunningTime -float 0

  defaults read "$domain" >"$artifact_dir/${mode}-iterm-preferences.txt"
}

record_session_diagnostics() {
  {
    printf 'session_root=%s\n' "$session_root"
    find "$session_root" -print 2>/dev/null || true
  } >"$artifact_dir/${mode}-session-files.txt"
}

stop_iterm() {
  [[ -n ${iterm_pid:-} ]] || return 0

  # Give the fixture time to observe DONE_FILE and let the close-on-exit profile
  # terminate iTerm2 normally before falling back to signals.
  for _ in $(seq 1 30); do
    kill -0 "$iterm_pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill "$iterm_pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$iterm_pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL "$iterm_pid" 2>/dev/null || true
  wait "$iterm_pid" 2>/dev/null || true
}

cleanup() {
  touch "$done_file" 2>/dev/null || true
  stop_iterm
  record_session_diagnostics
  rm -rf "$session_root"
}
trap cleanup EXIT

configure_iterm

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
  cat "$launcher_log" >&2 || true
  exit 1
fi

# The dedicated profile opens at 150×44 cells. A full-display capture avoids
# Apple Events, Accessibility automation, and window-enumeration permissions.
sleep 2
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
