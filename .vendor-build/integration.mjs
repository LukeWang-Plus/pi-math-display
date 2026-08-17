import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { loadExtensions } from "../tests/visual/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import {
  Box,
  Markdown,
  ProcessTerminal,
  TuiAltScreen,
  TuiMainScreen,
  setCapabilities,
  setCellDimensions,
  stripTerminalSequences,
  visibleWidth,
} from "../tests/visual/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";

const buildDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(buildDirectory, "..");
const extensionPath = join(repositoryRoot, "index.ts");
const testFontFile = [
  process.env.MATH_TEST_FONT_FILE,
  "C:\\Windows\\Fonts\\MiSans-Regular.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf",
].find((candidate) => candidate && existsSync(candidate));
const identity = (text) => text;
const theme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: (text) => `\x1b[38;2;181;189;104m${text}\x1b[39m`,
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

const MULTIROW_BLOCK_SOURCE = String.raw`\[
\begin{pmatrix}
\frac{a}{b} & 0 \\
0 & \frac{c}{d}
\end{pmatrix}
\]`;

const originalEnvironment = Object.fromEntries(
  [
    "TERM_PROGRAM",
    "TERM",
    "KITTY_WINDOW_ID",
    "GHOSTTY_RESOURCES_DIR",
    "WEZTERM_PANE",
    "WEZTERM_EXECUTABLE",
    "WARP_SESSION_ID",
    "WARP_TERMINAL_SESSION_UUID",
    "PI_MATH_FONT_FILES",
    "PI_MATH_MACROS",
    "PI_MATH_ENVIRONMENTS",
    "PI_MATH_SYSTEM_FONTS",
  ].map((name) => [name, process.env[name]]),
);

function restoreEnvironment() {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function loadExtension() {
  const result = await loadExtensions([extensionPath], repositoryRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  const notifications = [];
  const context = {
    mode: "tui",
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  };
  for (const handler of extension.handlers.get("session_start") ?? []) {
    await handler({}, context);
  }
  return {
    extension,
    notifications,
    context,
    async startAgain() {
      for (const handler of extension.handlers.get("session_start") ?? []) {
        await handler({}, context);
      }
    },
    async shutdown() {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) {
        await handler({}, context);
      }
    },
  };
}

function render(source, width = 80) {
  return new Markdown(source, 0, 0, theme).render(width);
}

function kittyImages(lines) {
  const images = [];
  let current;
  for (const match of lines
    .join("")
    .matchAll(/\x1b_G([^;]*);([A-Za-z0-9+/=]*)\x1b\\/gu)) {
    const controls = Object.fromEntries(
      match[1].split(",").map((entry) => {
        const separator = entry.indexOf("=");
        return separator < 0
          ? [entry, ""]
          : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    if (controls.a === "T") {
      assert.equal(current, undefined, "nested Kitty image transmission");
      current = { controls, chunks: [] };
    }
    if (!current) continue;
    current.chunks.push(match[2]);
    if (controls.m !== "1") {
      const png = Buffer.from(current.chunks.join(""), "base64");
      images.push({ controls: current.controls, png });
      current = undefined;
    }
  }
  assert.equal(current, undefined, "unterminated Kitty image transmission");
  return images;
}

function imageCount(lines) {
  return kittyImages(lines).length;
}

function kittyPng(lines) {
  const images = kittyImages(lines);
  assert.equal(images.length, 1);
  assertPng(images[0].png);
  return images[0].png;
}

function assertKittyRowImages(lines, expectedCount) {
  const images = kittyImages(lines);
  if (expectedCount === undefined) assert.ok(images.length > 0);
  else assert.equal(images.length, expectedCount);
  const imageIds = new Set();
  for (const image of images) {
    assert.equal(image.controls.a, "T");
    assert.equal(image.controls.C, "1");
    assert.equal(image.controls.r, "1");
    assert.ok(Number.parseInt(image.controls.c, 10) > 0);
    assert.ok(Number.parseInt(image.controls.i, 10) > 0);
    assert.ok(!imageIds.has(image.controls.i));
    imageIds.add(image.controls.i);
    assertPng(image.png);
  }
  return images;
}

function itermPng(lines) {
  const matches = [
    ...lines.join("").matchAll(/\x1b\]1337;File=[^:]*:([A-Za-z0-9+/=]+)\x07/gu),
  ];
  assert.equal(matches.length, 1);
  const png = Buffer.from(matches[0][1], "base64");
  assertPng(png);
  return png;
}

function wezTermMarkers(lines) {
  return [
    ...lines
      .join("\n")
      .matchAll(/math-image:[0-9a-f]{32}:(\d+):(\d+):([A-Za-z0-9+/=]+)/gu),
  ].map((match) => ({
    columns: Number.parseInt(match[1], 10),
    rows: Number.parseInt(match[2], 10),
    png: Buffer.from(match[3], "base64"),
  }));
}

function warpMarkers(lines) {
  return [
    ...lines
      .join("\n")
      .matchAll(
        /math-kitty-image:[0-9a-f]{32}:(\d+):(\d+):([A-Za-z0-9+/=]+)/gu,
      ),
  ].map((match) => ({
    columns: Number.parseInt(match[1], 10),
    imageId: Number.parseInt(match[2], 10),
    png: Buffer.from(match[3], "base64"),
  }));
}

function assertPng(png) {
  assert.ok(
    png
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  );
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function decodeRgbaPng(png) {
  const { width, height } = assertPng(png);
  const idat = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      assert.equal(data[8], 8);
      assert.equal(data[9], 6);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += length + 12;
  }

  const compressed = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
      ? left
      : aboveDistance <= upperLeftDistance
        ? above
        : upperLeft;
  };

  let source = 0;
  for (let row = 0; row < height; row++) {
    const filter = compressed[source++];
    for (let columnByte = 0; columnByte < stride; columnByte++) {
      const left = columnByte >= 4 ? pixels[row * stride + columnByte - 4] : 0;
      const above = row > 0 ? pixels[(row - 1) * stride + columnByte] : 0;
      const upperLeft =
        row > 0 && columnByte >= 4
          ? pixels[(row - 1) * stride + columnByte - 4]
          : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft);
      pixels[row * stride + columnByte] =
        (compressed[source++] + predictor) & 0xff;
    }
  }
  assert.equal(source, compressed.length);
  return { width, height, pixels };
}

function expandThroughProcessTerminal(output) {
  const originalStdoutWrite = process.stdout.write;
  let captured = "";
  process.stdout.write = (chunk, encoding, callback) => {
    const resolvedEncoding = typeof encoding === "string" ? encoding : "utf8";
    captured +=
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(resolvedEncoding);
    const resolvedCallback =
      typeof encoding === "function" ? encoding : callback;
    resolvedCallback?.();
    return true;
  };
  try {
    ProcessTerminal.prototype.write.call({}, output);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  return captured;
}

class RecordingTerminal {
  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
    this.writes = [];
    this.kittyProtocolActive = false;
  }

  start(onInput, onResize) {
    this.onInput = onInput;
    this.onResize = onResize;
  }

  stop() {}
  async drainInput() {}
  write(data) {
    this.writes.push(data);
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

function fullscreenFrame(source, height = 24) {
  const terminal = new RecordingTerminal(80, height);
  const fullscreen = new TuiAltScreen(terminal, false);
  fullscreen.addChild(new Markdown(source, 0, 0, theme));
  fullscreen.start();
  terminal.writes.length = 0;
  fullscreen.renderNow(true);
  const frame = terminal.writes.join("");
  fullscreen.stop({ preserveScreen: true });
  return frame;
}

function regularFrame(source, height = 24) {
  const terminal = new RecordingTerminal(80, height);
  const regular = new TuiMainScreen(terminal, false);
  regular.addChild(new Markdown(source, 0, 0, theme));
  regular.start();
  terminal.writes.length = 0;
  regular.renderNow(true);
  const frame = terminal.writes.join("");
  regular.stop({ preserveScreen: true });
  return frame;
}

function assertKittyFullscreenRows(frame, expectedCount) {
  const images = assertKittyRowImages([frame], expectedCount);
  let previousImage = -1;
  for (const match of frame.matchAll(/\x1b_Ga=T,[^;]*;/gu)) {
    const clear = frame.lastIndexOf("\x1b[2K", match.index);
    assert.ok(
      clear > previousImage,
      "each Kitty row must be cleared before drawing",
    );
    previousImage = match.index;
  }
  assert.match(frame, /\x1b\[2K/u);
  return images;
}

test("math end-to-end behavior and reload", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  process.env.TERM_PROGRAM = "kitty";
  process.env.TERM = "xterm-kitty";
  delete process.env.PI_MATH_FONT_FILES;
  process.env.PI_MATH_MACROS = "not-json";
  process.env.PI_MATH_ENVIRONMENTS = "[]";
  process.env.PI_MATH_SYSTEM_FONTS = "true";

  const originalRender = Markdown.prototype.render;
  const originalTerminalWrite = ProcessTerminal.prototype.write;
  let referenceKittyBlockPngs;
  let referenceFullBlockPng;
  const first = await loadExtension();
  try {
    assert.notEqual(Markdown.prototype.render, originalRender);
    assert.equal(first.extension.commands.size, 0);
    assert.deepEqual(first.notifications, []);

    const inlineSource = String.raw`Einstein wrote $E=mc^2$ and \(x_1\).`;
    const inline = new Markdown(inlineSource, 0, 0, theme);
    const inlineLines = inline.render(80);
    assert.equal(imageCount(inlineLines), 2);
    assert.equal(inline.text, inlineSource);
    assert.ok(inlineLines.every((line) => visibleWidth(line) <= 80));
    assert.deepEqual(inline.render(80), inlineLines);

    for (const formula of [
      String.raw`$$\frac{1}{2}$$`,
      String.raw`\[\begin{matrix}a&b\\c&d\end{matrix}\]`,
      String.raw`\begin{align}a&=b\\c&=d\end{align}`,
      String.raw`$$f(x)=\begin{cases}x^2,&x>0\\0,&x\le 0\end{cases}$$`,
      String.raw`$$a=b\label{ignored}\tag{1}\notag$$`,
      String.raw`$$\ce{H2O + CO2 -> H2CO3}$$`,
      String.raw`$$\braket{\phi|\psi}+\cancel{x}$$`,
      String.raw`$$\begin{CD}A @>f>> B\end{CD}$$`,
    ]) {
      const lines = render(formula);
      assertKittyRowImages(lines);
      assert.doesNotMatch(lines.join("\n"), /math-4f9c|```/u);
    }

    assertKittyRowImages(render(String.raw`$$\newcommand{\foo}{x^2}\foo+1$$`));
    const absentMacro = render(String.raw`$$\foo+1$$`).join("\n");
    assert.doesNotMatch(absentMacro, /\x1b_G/u);
    assert.match(absentMacro, /\\foo/u);
    assertKittyRowImages(
      render(
        String.raw`$$\newenvironment{localenv}{\langle}{\rangle}\begin{localenv}x\end{localenv}$$`,
      ),
    );
    const absentEnvironment = render(
      String.raw`$$\begin{localenv}x\end{localenv}$$`,
    ).join("\n");
    assert.doesNotMatch(absentEnvironment, /\x1b_G/u);
    assert.match(absentEnvironment, /localenv/u);

    for (const source of [
      String.raw`$$\qty{x}$$`,
      String.raw`$$\definitelyUnknown{x}$$`,
    ]) {
      const output = render(source).join("\n");
      assert.doesNotMatch(output, /\x1b_G/u);
      assert.match(output, /\\/u);
    }

    const chineseWithoutFont = render(String.raw`\(x\text{ 是正数}\)`).join(
      "\n",
    );
    assert.doesNotMatch(chineseWithoutFont, /\x1b_G/u);
    assert.match(chineseWithoutFont, /\\text\{ 是正数\}/u);

    const protectedSource = [
      "```tex",
      "$not_math$",
      "```",
      "`$also_not_math$`",
      "<code>\\(still_not_math\\)</code>",
      String.raw`\verb|$not_math$|`,
      "    $indented$",
      "and $yes$",
    ].join("\n");
    const protectedLines = render(protectedSource);
    assert.equal(imageCount(protectedLines), 1);
    assert.match(protectedLines.join("\n"), /not_math/u);

    const currency = render(
      String.raw`Pay \$5 or $10 today; incomplete $x.`,
    ).join("\n");
    assert.doesNotMatch(currency, /\x1b_G/u);
    assert.match(currency, /\$10/u);

    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const unsupported = render(String.raw`Result: $x^2+1$`).join("\n");
    assert.match(unsupported, /\$x\^2\+1\$/u);
    assert.doesNotMatch(unsupported, /x²/u);
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

    const resizeFormula = String.raw`$$x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}$$`;
    const resized = new Markdown(resizeFormula, 0, 0, theme);
    assertKittyRowImages(resized.render(100));
    assertKittyRowImages(resized.render(20));
    assertKittyRowImages(resized.render(12));

    const oversizedInput = `$$${"x".repeat(20_001)}$$`;
    assert.equal(imageCount(render(oversizedInput)), 0);

    const regression = readFileSync(
      join(buildDirectory, "fixtures", "field-theory.tex"),
      "utf8",
    );
    assertKittyRowImages(render(`$$${regression}$$`, 120));
    const tallRows = Array.from(
      { length: 40 },
      (_, index) => `x_{${index}}`,
    ).join(String.raw`\\`);
    assertKittyRowImages(
      render(`$$\\begin{matrix}${tallRows}\\end{matrix}$$`, 120),
    );

    // A 300-cell canvas cannot use 2x density under the 4096px limit,
    // so it must fall back to a 1x, 2700px-wide PNG.
    const veryWideFormula = `$$${Array.from({ length: 700 }, (_, index) => `x_{${index}}`).join("+")}$$`;
    const veryWide = render(veryWideFormula, 300);
    assertKittyRowImages(veryWide, 1);
    assert.equal(kittyPng(veryWide).readUInt32BE(16), 2700);

    for (const profile of [
      { name: "Kitty", program: "kitty", term: "xterm-kitty" },
      { name: "Ghostty", program: "ghostty", term: "xterm-ghostty" },
    ]) {
      setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
      process.env.TERM_PROGRAM = profile.program;
      process.env.TERM = profile.term;
      delete process.env.KITTY_WINDOW_ID;
      delete process.env.GHOSTTY_RESOURCES_DIR;

      const inlineLines = render(String.raw`left $x$ right`);
      const inlineOutput = inlineLines.join("\n");
      assert.equal(imageCount(inlineLines), 1, profile.name);
      assert.match(stripTerminalSequences(inlineOutput), /left .* right/u);
      assert.ok(inlineLines.every((line) => visibleWidth(line) <= 80));
      assert.match(inlineOutput, /U=1/u);

      const blockLines = render(MULTIROW_BLOCK_SOURCE);
      const blockImages = assertKittyRowImages(blockLines, blockLines.length);
      assert.ok(blockImages.length >= 2, profile.name);
      const frame = fullscreenFrame(
        MULTIROW_BLOCK_SOURCE,
        Math.max(12, blockLines.length + 4),
      );
      const fullscreenImages = assertKittyFullscreenRows(
        frame,
        blockImages.length,
      );
      assert.deepEqual(
        fullscreenImages.map(({ png }) => png),
        blockImages.map(({ png }) => png),
        profile.name,
      );
      if (profile.name === "Kitty") {
        referenceKittyBlockPngs = blockImages.map(({ png }) => png);
      }
    }

    setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
    process.env.TERM_PROGRAM = "iTerm.app";
    process.env.TERM = "xterm-256color";
    const itermInline = render(String.raw`left $x$ right`).join("\n");
    assert.doesNotMatch(itermInline, /\x1b\]1337;File=/u);
    assert.match(itermInline, /\$x\$/u);
    const itermBlock = render(MULTIROW_BLOCK_SOURCE);
    assert.match(itermBlock.join("\n"), /\x1b\]1337;File=/u);
    referenceFullBlockPng = itermPng(itermBlock);
    const itermRegular = regularFrame(MULTIROW_BLOCK_SOURCE, 16);
    const itermImageOffset = itermRegular.indexOf("\x1b]1337;File=");
    assert.ok(itermImageOffset >= 0);
    assert.equal(itermRegular.indexOf("\x1b[2K", itermImageOffset), -1);

    const itermFullscreen = fullscreenFrame(MULTIROW_BLOCK_SOURCE, 16);
    assert.doesNotMatch(itermFullscreen, /\x1b\]1337;File=|\x1b_G/u);
    assert.match(stripTerminalSequences(itermFullscreen), /pmatrix/u);

    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    process.env.TERM_PROGRAM = "kitty";
    process.env.TERM = "xterm-kitty";
  } finally {
    await first.shutdown();
  }
  assert.equal(Markdown.prototype.render, originalRender);

  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  process.env.TERM_PROGRAM = "WarpTerminal";
  process.env.TERM = "xterm-256color";
  delete process.env.KITTY_WINDOW_ID;
  delete process.env.GHOSTTY_RESOURCES_DIR;
  const warp = await loadExtension();
  try {
    assert.deepEqual(warp.notifications, []);
    assert.notEqual(ProcessTerminal.prototype.write, originalTerminalWrite);

    const inlineSource = String.raw`left $x$ right`;
    const inlineLines = render(inlineSource);
    const markers = warpMarkers(inlineLines);
    assert.equal(markers.length, 1);
    assert.ok(markers[0].columns > 0);
    assert.ok(markers[0].imageId > 0);
    assertPng(markers[0].png);
    assert.match(
      stripTerminalSequences(inlineLines.join("\n")),
      /left .* right/u,
    );
    assert.ok(inlineLines.every((line) => visibleWidth(line) <= 80));
    assert.doesNotMatch(inlineLines.join("\n"), /\x1b_G/u);

    const inlineBox = new Box(1, 0);
    inlineBox.addChild(new Markdown(inlineSource, 0, 0, theme));
    const boxedInline = inlineBox.render(82);
    assert.ok(boxedInline.every((line) => visibleWidth(line) === 82));
    const expandedInline = expandThroughProcessTerminal(boxedInline.join("\n"));
    assertKittyRowImages([expandedInline], 1);
    assert.match(expandedInline, /\x1b\[\d+D/u);
    assert.match(expandedInline, /\x1b\[\d+C/u);
    assert.doesNotMatch(expandedInline, /math-kitty-image|\u{10fffd}/u);

    const inlineFullscreen = fullscreenFrame(inlineSource, 12);
    assert.equal(warpMarkers([inlineFullscreen]).length, 1);
    assert.match(inlineFullscreen, /\x1b\[2K/u);
    const expandedInlineFullscreen =
      expandThroughProcessTerminal(inlineFullscreen);
    assertKittyRowImages([expandedInlineFullscreen], 1);
    assert.match(expandedInlineFullscreen, /left.*right/su);
    assert.doesNotMatch(
      expandedInlineFullscreen,
      /math-kitty-image|\u{10fffd}/u,
    );

    const forgedMarker = boxedInline
      .join("\n")
      .replace(
        /math-kitty-image:[0-9a-f]{32}:/u,
        `math-kitty-image:${"0".repeat(32)}:`,
      );
    const rejectedMarker = expandThroughProcessTerminal(forgedMarker);
    assert.doesNotMatch(rejectedMarker, /\x1b_Ga=T/u);
    assert.match(
      rejectedMarker,
      new RegExp(`math-kitty-image:${"0".repeat(32)}`),
    );

    const blockLines = render(MULTIROW_BLOCK_SOURCE);
    const blockImages = assertKittyRowImages(blockLines, blockLines.length);
    assert.ok(blockImages.length >= 2);
    assert.deepEqual(
      blockImages.map(({ png }) => png),
      referenceKittyBlockPngs,
    );
    const frame = fullscreenFrame(
      MULTIROW_BLOCK_SOURCE,
      Math.max(12, blockLines.length + 4),
    );
    const fullscreenImages = assertKittyFullscreenRows(
      frame,
      blockImages.length,
    );
    assert.deepEqual(
      fullscreenImages.map(({ png }) => png),
      blockImages.map(({ png }) => png),
    );
  } finally {
    await warp.shutdown();
  }
  assert.equal(Markdown.prototype.render, originalRender);
  assert.equal(ProcessTerminal.prototype.write, originalTerminalWrite);

  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  process.env.TERM_PROGRAM = "wezterm";
  process.env.TERM = "xterm-256color";
  delete process.env.KITTY_WINDOW_ID;
  delete process.env.GHOSTTY_RESOURCES_DIR;
  const wezTerm = await loadExtension();
  try {
    assert.deepEqual(wezTerm.notifications, []);
    assert.notEqual(ProcessTerminal.prototype.write, originalTerminalWrite);

    const delimiterQuestion = String.raw`使用\(...\)包裹了吗`;
    const questionLines = render(delimiterQuestion);
    const questionMarkers = wezTermMarkers(questionLines);
    assert.equal(questionMarkers.length, 1);
    assert.equal(questionMarkers[0].rows, 1);
    assert.match(
      stripTerminalSequences(questionLines.join("\n")),
      /使用.*包裹了吗/u,
    );
    assert.ok(questionLines.every((line) => visibleWidth(line) <= 80));
    assert.doesNotMatch(questionLines.join("\n"), /\x1b_G|\x1b\]1337;File=/u);

    const questionBox = new Box(1, 0);
    questionBox.addChild(new Markdown(delimiterQuestion, 0, 0, theme));
    const boxedQuestion = questionBox.render(82);
    assert.ok(boxedQuestion.every((line) => visibleWidth(line) === 82));
    assert.match(
      stripTerminalSequences(boxedQuestion.join("\n")),
      /使用.*包裹了吗/u,
    );

    const expandedQuestion = expandThroughProcessTerminal(
      boxedQuestion.join("\n"),
    );
    assert.match(expandedQuestion, /\x1b\]1337;File=/u);
    assert.match(expandedQuestion, /doNotMoveCursor=1/u);
    assert.match(expandedQuestion, /width=3;height=1/u);
    assert.doesNotMatch(expandedQuestion, /math-image|\u{10fffd}/u);

    const forgedMarker = boxedQuestion
      .join("\n")
      .replace(/math-image:[0-9a-f]{32}:/u, `math-image:${"0".repeat(32)}:`);
    const rejectedMarker = expandThroughProcessTerminal(forgedMarker);
    assert.doesNotMatch(rejectedMarker, /\x1b\]1337;File=/u);
    assert.match(rejectedMarker, new RegExp(`math-image:${"0".repeat(32)}`));

    const blockLines = render(MULTIROW_BLOCK_SOURCE);
    const blockMarkers = wezTermMarkers(blockLines);
    assert.ok(blockMarkers.length >= 2);
    assert.equal(blockLines.length, blockMarkers.length);
    assert.ok(blockLines.every((line) => visibleWidth(line) <= 80));
    const rowDimensions = blockMarkers.map((marker) => {
      assert.equal(marker.rows, 1);
      return assertPng(marker.png);
    });
    assert.ok(
      rowDimensions.every(({ width }) => width === rowDimensions[0].width),
    );
    assert.ok(rowDimensions.every(({ height }) => height > 0));

    assert.ok(referenceKittyBlockPngs);
    assert.deepEqual(
      blockMarkers.map(({ png }) => png),
      referenceKittyBlockPngs,
    );
    assert.ok(referenceFullBlockPng);
    const decodedRows = blockMarkers.map(({ png }) => decodeRgbaPng(png));
    const fullBlock = decodeRgbaPng(referenceFullBlockPng);
    assert.equal(
      decodedRows.reduce((height, row) => height + row.height, 0),
      fullBlock.height,
    );
    assert.ok(decodedRows.every((row) => row.width === fullBlock.width));
    assert.deepEqual(
      Buffer.concat(decodedRows.map(({ pixels }) => pixels)),
      fullBlock.pixels,
    );

    const wezFullscreenFrame = fullscreenFrame(
      MULTIROW_BLOCK_SOURCE,
      Math.max(12, blockLines.length + 4),
    );
    const fullscreenMarkers = wezTermMarkers([wezFullscreenFrame]);
    assert.equal(fullscreenMarkers.length, blockMarkers.length);
    assert.ok(fullscreenMarkers.every(({ rows }) => rows === 1));
    assert.match(wezFullscreenFrame, /\x1b\[2K/u);
    const expandedFullscreen = expandThroughProcessTerminal(wezFullscreenFrame);
    assert.equal(
      (expandedFullscreen.match(/\x1b\]1337;File=/gu) ?? []).length,
      blockMarkers.length,
    );
    assert.ok(
      [...expandedFullscreen.matchAll(/\x1b\]1337;File=([^:]+):/gu)].every(
        (match) =>
          match[1].includes("height=1") &&
          match[1].includes("doNotMoveCursor=1"),
      ),
    );
    assert.doesNotMatch(expandedFullscreen, /math-image|\u{10fffd}/u);
  } finally {
    await wezTerm.shutdown();
  }
  assert.equal(Markdown.prototype.render, originalRender);
  assert.equal(ProcessTerminal.prototype.write, originalTerminalWrite);

  process.env.TERM_PROGRAM = "kitty";
  process.env.TERM = "xterm-kitty";
  const second = await loadExtension();
  try {
    assertKittyRowImages(render(String.raw`$$x+1$$`));
    assert.deepEqual(second.notifications, []);
  } finally {
    await second.shutdown();
  }
  assert.equal(Markdown.prototype.render, originalRender);

  if (testFontFile) {
    process.env.PI_MATH_FONT_FILES = testFontFile;
    delete process.env.PI_MATH_MACROS;
    delete process.env.PI_MATH_ENVIRONMENTS;
    delete process.env.PI_MATH_SYSTEM_FONTS;
    const withFont = await loadExtension();
    try {
      assertKittyRowImages(render(String.raw`\(x\text{ 是正数}\)`));
      assert.deepEqual(withFont.notifications, []);
    } finally {
      await withFont.shutdown();
    }
    assert.equal(Markdown.prototype.render, originalRender);
  }

  process.env.PI_MATH_FONT_FILES = join(buildDirectory, "missing-font.ttf");
  const invalidFont = await loadExtension();
  try {
    assert.equal(invalidFont.notifications.length, 1);
    assert.equal(invalidFont.notifications[0].type, "warning");
    assert.match(
      invalidFont.notifications[0].message,
      /PI_MATH_FONT_FILES does not exist/u,
    );
    const fallback = render(String.raw`$$x^2+1$$`).join("\n");
    assert.doesNotMatch(fallback, /\x1b_G/u);
    assert.match(fallback, /\$\$x\^2\+1\$\$/u);
    await invalidFont.startAgain();
    assert.equal(invalidFont.notifications.length, 1);
  } finally {
    await invalidFont.shutdown();
  }
  assert.equal(Markdown.prototype.render, originalRender);

  restoreEnvironment();
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
});
