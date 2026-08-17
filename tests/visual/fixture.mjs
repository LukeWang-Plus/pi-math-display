import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import {
  Box,
  Markdown,
  ProcessTerminal,
  TuiAltScreen,
  TuiMainScreen,
  getCapabilities,
  getCellDimensions,
} from "./node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const extensionPath = join(repositoryRoot, "index.ts");
const mode = process.env.VISUAL_MODE === "regular" ? "regular" : "fullscreen";
const terminalName = process.env.VISUAL_TERMINAL || "unknown-terminal";
const title = process.env.VISUAL_TITLE || `math-visual-${terminalName}-${mode}`;
const readyFile = resolve(
  process.env.READY_FILE || join(repositoryRoot, "artifacts", `${title}.ready`),
);
const doneFile = resolve(
  process.env.DONE_FILE || join(repositoryRoot, "artifacts", `${title}.done`),
);
const metadataFile = resolve(
  process.env.METADATA_FILE ||
    join(repositoryRoot, "artifacts", `${title}.json`),
);
const artifactDirectory = dirname(metadataFile);
mkdirSync(artifactDirectory, { recursive: true });

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const identity = (text) => text;
const theme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: (text) => `\x1b[38;2;240;246;252m${text}\x1b[39m`,
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

const fixture = String.raw`# math visual verification

Terminal: ${terminalName}    Mode: ${mode}

INLINE-BEGIN  The identity \(e^{i\pi}+1=0\) keeps this suffix intact.  INLINE-END

## Multi-row matrix

\[
\begin{pmatrix}
\dfrac{a}{b} & 0 & \sqrt{x^2+y^2} \\
0 & \dfrac{c}{d} & \displaystyle\sum_{k=1}^{n} k \\
\alpha & \beta & \gamma
\end{pmatrix}
\]

## Aligned and scalable

\[
\left\{
\begin{aligned}
f(x) &= \int_{-\infty}^{x} e^{-t^2}\,dt, \\
g(x) &= \frac{\partial}{\partial x}\left(\frac{\sin x}{x}\right), \\
h(x) &= \ce{H2O + CO2 -> H2CO3}
\end{aligned}
\right.
\]

## Wide expression

\[
\operatorname*{arg\,min}_{\theta\in\mathbb R^d}
\left\{
\frac1N\sum_{i=1}^{N}\ell\bigl(f_\theta(x_i),y_i\bigr)
+\lambda\lVert\theta\rVert_2^2
\right\}
\]

BOTTOM-SENTINEL — every formula row and both inline suffixes must be visible.`;

const loadResult = await loadExtensions([extensionPath], repositoryRoot);
if (loadResult.errors.length > 0 || loadResult.extensions.length !== 1) {
  throw new Error(
    `Could not load math extension: ${JSON.stringify(loadResult.errors)}`,
  );
}

const extension = loadResult.extensions[0];
const notifications = [];
const context = {
  mode: "tui",
  ui: {
    notify(message, type) {
      notifications.push({ message, type });
    },
  },
};
for (const handler of extension.handlers.get("session_start") ?? []) {
  await handler({}, context);
}

const terminal = new ProcessTerminal();
terminal.setTitle(title);
const tui =
  mode === "fullscreen"
    ? new TuiAltScreen(terminal, false, artifactDirectory, { mouse: false })
    : new TuiMainScreen(terminal, false, artifactDirectory);
const box = new Box(2, 1);
box.addChild(new Markdown(fixture, 0, 0, theme));
tui.addChild(box);

let started = false;
try {
  tui.start();
  started = true;

  // Give the real terminal time to answer Pi's cell-size query and for the
  // external capture script to apply deterministic window geometry.
  await sleep(2200);
  tui.invalidate();
  tui.renderNow(true);
  await sleep(800);

  const metadata = {
    terminal: terminalName,
    mode,
    title,
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    columns: terminal.columns,
    rows: terminal.rows,
    cellDimensions: getCellDimensions(),
    capabilities: getCapabilities(),
    notifications,
    environment: {
      TERM: process.env.TERM,
      TERM_PROGRAM: process.env.TERM_PROGRAM,
      COLORTERM: process.env.COLORTERM,
      KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
      GHOSTTY_RESOURCES_DIR: process.env.GHOSTTY_RESOURCES_DIR,
      WEZTERM_PANE: process.env.WEZTERM_PANE,
      WARP_SESSION_ID: process.env.WARP_SESSION_ID,
      ITERM_SESSION_ID: process.env.ITERM_SESSION_ID,
    },
  };
  writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(readyFile, "ready\n");

  const deadline = Date.now() + 90_000;
  while (!existsSync(doneFile) && Date.now() < deadline) {
    await sleep(250);
  }
  if (!existsSync(doneFile)) {
    throw new Error(`Timed out waiting for screenshot completion: ${doneFile}`);
  }
} finally {
  if (started) tui.stop({ preserveScreen: true });
  for (const handler of extension.handlers.get("session_shutdown") ?? []) {
    await handler({}, context);
  }
}
