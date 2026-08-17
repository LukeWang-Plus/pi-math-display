import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import {
  Markdown,
  setCapabilities,
  setCellDimensions,
} from "./node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
process.env.TERM_PROGRAM = "kitty";
process.env.TERM = "xterm-kitty";
delete process.env.WEZTERM_PANE;
delete process.env.WEZTERM_EXECUTABLE;
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
setCellDimensions({ widthPx: 9, heightPx: 18 });

const loaded = await loadExtensions(
  [resolve(repositoryRoot, "index.ts")],
  repositoryRoot,
);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
const notifications = [];
const context = {
  mode: "tui",
  ui: { notify: (message, type) => notifications.push({ message, type }) },
};
for (const handler of extension.handlers.get("session_start") ?? []) {
  await handler({}, context);
}

const identity = (text) => text;
const theme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
};
const inline = new Markdown(String.raw`before $x^2$ after`, 0, 0, theme).render(
  80,
);
assert.match(inline.join(""), /\x1b_G/u);
assert.match(inline.join(""), /before.*after/su);
const block = new Markdown(
  String.raw`\[\begin{pmatrix}\frac{a}{b}&0\\0&\frac{c}{d}\end{pmatrix}\]`,
  0,
  0,
  theme,
).render(80);
const imageRows = block.join("").match(/\x1b_Ga=T,[^;]*r=1[^;]*;/gu) ?? [];
assert.ok(imageRows.length >= 2);
assert.deepEqual(notifications, []);

for (const handler of extension.handlers.get("session_shutdown") ?? []) {
  await handler({}, context);
}
console.log("visual harness smoke test passed");
