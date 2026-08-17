local wezterm = require("wezterm")

return {
  font = wezterm.font("DejaVu Sans Mono"),
  font_size = 14.0,
  colors = {
    background = "#0d1117",
    foreground = "#f0f6fc",
    cursor_bg = "#f0f6fc",
    cursor_fg = "#0d1117",
    selection_bg = "#264f78",
    selection_fg = "#ffffff",
  },
  enable_tab_bar = false,
  window_decorations = "NONE",
  initial_cols = 150,
  initial_rows = 44,
  window_padding = {
    left = 8,
    right = 8,
    top = 8,
    bottom = 8,
  },
  enable_wayland = false,
  animation_fps = 1,
  cursor_blink_rate = 0,
  audible_bell = "Disabled",
  check_for_updates = false,
}
