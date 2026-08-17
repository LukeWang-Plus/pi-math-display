#!/usr/bin/env bash
set -euo pipefail

terminal_name=${1:?usage: install-linux-terminal.sh <terminal> <tools-dir> <metadata-dir>}
tools_dir=$(mkdir -p "$2" && cd "$2" && pwd)
metadata_dir=$(mkdir -p "$3" && cd "$3" && pwd)
metadata_file="$metadata_dir/${terminal_name}-install.txt"
: >"$metadata_file"

record_file() {
  local file=$1
  printf 'file=%s\nsha256=%s\n' "$file" "$(sha256sum "$file" | awk '{print $1}')" >>"$metadata_file"
}

case "$terminal_name" in
  kitty)
    version=0.48.2
    archive="$tools_dir/kitty-${version}-x86_64.txz"
    url="https://github.com/kovidgoyal/kitty/releases/download/v${version}/kitty-${version}-x86_64.txz"
    printf 'source=%s\nversion=%s\n' "$url" "$version" >>"$metadata_file"
    curl --fail --location --retry 5 --retry-all-errors "$url" --output "$archive"
    record_file "$archive"
    mkdir -p "$tools_dir/kitty"
    tar -xJf "$archive" -C "$tools_dir/kitty"
    terminal_bin="$tools_dir/kitty/bin/kitty"
    ;;

  ghostty)
    version=1.3.1
    package_release=1.3.1-0-ppa2
    package_name="ghostty_1.3.1-0.ppa2_amd64_24.04.deb"
    deb="$tools_dir/$package_name"
    url="https://github.com/mkasberg/ghostty-ubuntu/releases/download/${package_release}/${package_name}"
    expected=478d440153ef544426418efc7d6d8901715359f452c46be29071901a94b8cd47
    {
      printf 'source=%s\n' "$url"
      printf 'version=%s\npackage_release=%s\n' "$version" "$package_release"
      printf 'packaging=ghostty-ubuntu community package listed by https://ghostty.org/docs/install/binary\n'
      printf 'expected_sha256=%s\n' "$expected"
    } >>"$metadata_file"
    curl --fail --location --retry 5 --retry-all-errors "$url" --output "$deb"
    printf '%s  %s\n' "$expected" "$deb" | sha256sum --check -
    record_file "$deb"
    sudo apt-get install --yes "$deb"
    terminal_bin=$(command -v ghostty)
    ;;

  wezterm)
    deb="$tools_dir/wezterm-nightly.Ubuntu24.04.deb"
    checksum="$deb.sha256"
    base="https://github.com/wez/wezterm/releases/download/nightly"
    printf 'source=%s\nchannel=nightly\n' "$base" >>"$metadata_file"
    curl --fail --location --retry 5 --retry-all-errors \
      "$base/wezterm-nightly.Ubuntu24.04.deb" --output "$deb"
    curl --fail --location --retry 5 --retry-all-errors \
      "$base/wezterm-nightly.Ubuntu24.04.deb.sha256" --output "$checksum"
    expected=$(awk 'NR == 1 { print $1 }' "$checksum")
    printf '%s  %s\n' "$expected" "$deb" | sha256sum --check -
    record_file "$deb"
    printf 'official_checksum=%s\n' "$expected" >>"$metadata_file"
    sudo apt-get install --yes "$deb"
    terminal_bin=$(command -v wezterm)
    ;;

  warp)
    deb="$tools_dir/warp-terminal.deb"
    url="https://app.warp.dev/download?package=deb"
    printf 'source=%s\nchannel=stable\n' "$url" >>"$metadata_file"
    curl --fail --location --retry 5 --retry-all-errors "$url" --output "$deb"
    dpkg-deb --info "$deb" >>"$metadata_file"
    record_file "$deb"
    sudo apt-get install --yes "$deb"
    terminal_bin=$(command -v warp-terminal || command -v warp)
    ;;

  *)
    printf 'Unsupported Linux terminal: %s\n' "$terminal_name" >&2
    exit 2
    ;;
esac

if [[ ! -x "$terminal_bin" ]]; then
  printf 'Terminal executable is unavailable: %s\n' "$terminal_bin" >&2
  exit 1
fi

{
  printf 'terminal_bin=%s\n' "$terminal_bin"
  printf 'reported_version=\n'
  case "$terminal_name" in
    ghostty) "$terminal_bin" +version 2>&1 || "$terminal_bin" --version 2>&1 || true ;;
    *) "$terminal_bin" --version 2>&1 || true ;;
  esac
} >>"$metadata_file"

if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  printf 'terminal_bin=%s\n' "$terminal_bin" >>"$GITHUB_OUTPUT"
else
  printf '%s\n' "$terminal_bin"
fi
