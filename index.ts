import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter as pathDelimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  ProcessTerminal,
  allocateImageId,
  encodeITerm2,
  encodeKitty,
  getCapabilities,
  getCellDimensions,
  renderImage,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Local vendor loading and configuration
// ---------------------------------------------------------------------------

const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const MATHJAX_VENDOR_PATH = join(EXTENSION_DIRECTORY, "vendor", "mathjax.cjs");
const RESVG_VENDOR_PATH = join(EXTENSION_DIRECTORY, "vendor", "resvg.cjs");
const RESVG_WASM_PATH = join(EXTENSION_DIRECTORY, "vendor", "resvg.wasm");
const requireVendor = createRequire(import.meta.url);

const ENABLED_TEX_PACKAGES = Object.freeze([
  "base",
  "action",
  "ams",
  "amscd",
  "bbox",
  "boldsymbol",
  "braket",
  "bussproofs",
  "cancel",
  "cases",
  "centernot",
  "color",
  "colortbl",
  "empheq",
  "enclose",
  "extpfeil",
  "gensymb",
  "mathtools",
  "mhchem",
  "newcommand",
  "upgreek",
  "unicode",
  "verb",
  "tagformat",
  "textcomp",
  "textmacros",
] as const);

interface MathJaxAdaptor {
  outerHTML(node: unknown): string;
}

interface MathJaxDynamicMap {
  map?: Map<unknown, unknown>;
}

interface MathJaxInput {
  reset(): void;
  parseOptions?: {
    handlers?: {
      retrieve(name: string): MathJaxDynamicMap | null;
    };
  };
}

interface MathJaxDocument {
  convert(latex: string, options: { display: boolean }): unknown;
}

interface MathJaxVendor {
  DEFAULT_TEX_PACKAGES: readonly string[];
  OPTIONAL_TEX_PACKAGES: readonly string[];
  mathjax: {
    document(source: string, options: Record<string, unknown>): MathJaxDocument;
  };
  liteAdaptor(options: Record<string, number>): MathJaxAdaptor;
  RegisterHTMLHandler(adaptor: MathJaxAdaptor): unknown;
  SafeHandler(handler: unknown): unknown;
  TeX: new (options: Record<string, unknown>) => MathJaxInput;
  SVG: new (options: Record<string, unknown>) => unknown;
}

interface ResvgRenderedImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  asPng(): Uint8Array;
  free(): void;
}

interface ResvgInstance {
  render(): ResvgRenderedImage;
  free(): void;
}

interface ResvgVendor {
  initWasm(input: Uint8Array): Promise<void>;
  Resvg: new (
    svg: string | Uint8Array,
    options?: {
      font?: { fontBuffers: Uint8Array[] };
      shapeRendering?: 0 | 1 | 2;
      textRendering?: 0 | 1 | 2;
    },
  ) => ResvgInstance;
}

interface ResvgInitialization {
  vendor: ResvgVendor;
  ready: Promise<void>;
}

const RESVG_REGISTRY_SYMBOL = Symbol.for(
  "pi.extension.math.resvg-wasm.initialization.2.6.2",
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertFunction(value: unknown, name: string): void {
  if (typeof value !== "function")
    throw new Error(`Invalid vendor export: ${name}`);
}

function loadMathJaxVendor(): MathJaxVendor {
  const vendor = requireVendor(MATHJAX_VENDOR_PATH) as Partial<MathJaxVendor>;
  assertFunction(vendor.liteAdaptor, "liteAdaptor");
  assertFunction(vendor.RegisterHTMLHandler, "RegisterHTMLHandler");
  assertFunction(vendor.SafeHandler, "SafeHandler");
  assertFunction(vendor.TeX, "TeX");
  assertFunction(vendor.SVG, "SVG");
  if (!vendor.mathjax || typeof vendor.mathjax.document !== "function") {
    throw new Error("Invalid vendor export: mathjax.document");
  }
  if (
    !Array.isArray(vendor.DEFAULT_TEX_PACKAGES) ||
    !Array.isArray(vendor.OPTIONAL_TEX_PACKAGES)
  ) {
    throw new Error("Invalid MathJax package metadata");
  }

  const bundled = new Set([
    ...vendor.DEFAULT_TEX_PACKAGES,
    ...vendor.OPTIONAL_TEX_PACKAGES,
  ]);
  const missing = ENABLED_TEX_PACKAGES.find((name) => !bundled.has(name));
  if (missing) throw new Error(`MathJax package was not bundled: ${missing}`);
  return vendor as MathJaxVendor;
}

function loadResvgModule(): ResvgVendor {
  const vendor = requireVendor(RESVG_VENDOR_PATH) as Partial<ResvgVendor>;
  assertFunction(vendor.initWasm, "initWasm");
  assertFunction(vendor.Resvg, "Resvg");
  return vendor as ResvgVendor;
}

function resvgInitializationRegistry(): Map<string, ResvgInitialization> {
  const scope = globalThis as unknown as Record<PropertyKey, unknown>;
  const current = scope[RESVG_REGISTRY_SYMBOL];
  if (current instanceof Map)
    return current as Map<string, ResvgInitialization>;
  const registry = new Map<string, ResvgInitialization>();
  scope[RESVG_REGISTRY_SYMBOL] = registry;
  return registry;
}

function resvgIsUsable(vendor: ResvgVendor): boolean {
  let probe: ResvgInstance | undefined;
  try {
    probe = new vendor.Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    );
    return true;
  } catch {
    return false;
  } finally {
    probe?.free();
  }
}

async function initializeResvgVendor(): Promise<ResvgVendor> {
  const vendor = loadResvgModule();
  const registry = resvgInitializationRegistry();
  const registryKey = `${RESVG_VENDOR_PATH}\0${RESVG_WASM_PATH}`;
  const existing = registry.get(registryKey);
  if (existing?.vendor === vendor) {
    await existing.ready;
    return vendor;
  }

  const wasm = readFileSync(RESVG_WASM_PATH);
  const ready = (async () => {
    try {
      await vendor.initWasm(wasm);
    } catch (error) {
      if (
        /already initialized/iu.test(errorMessage(error)) &&
        resvgIsUsable(vendor)
      )
        return;
      throw error;
    }
  })();
  const state = { vendor, ready };
  registry.set(registryKey, state);
  try {
    await ready;
  } catch (error) {
    if (registry.get(registryKey) === state) registry.delete(registryKey);
    throw error;
  }
  return vendor;
}

interface RendererConfiguration {
  fontFiles: string[];
}

function configuredFontFiles(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const files = [
    ...new Set(
      value
        .split(pathDelimiter)
        .map((path) => path.trim())
        .filter(Boolean),
    ),
  ];
  for (const path of files) {
    if (!existsSync(path))
      throw new Error(`PI_MATH_FONT_FILES does not exist: ${path}`);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch (error) {
      throw new Error(
        `PI_MATH_FONT_FILES cannot be inspected: ${path}: ${errorMessage(error)}`,
      );
    }
    if (!isFile) throw new Error(`PI_MATH_FONT_FILES is not a file: ${path}`);
  }
  return files;
}

function loadRendererConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RendererConfiguration {
  return { fontFiles: configuredFontFiles(environment.PI_MATH_FONT_FILES) };
}

// ---------------------------------------------------------------------------
// Weighted caches and raster types
// ---------------------------------------------------------------------------

interface CacheEntry<Value> {
  value: Value;
  bytes: number;
}

class WeightedLruCache<Value> {
  private readonly entries = new Map<string, CacheEntry<Value>>();
  private retainedBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): Value | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: Value, bytes: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.retainedBytes -= previous.bytes;
      this.entries.delete(key);
    }
    const normalizedBytes = Math.max(0, Math.floor(bytes));
    this.entries.set(key, { value, bytes: normalizedBytes });
    this.retainedBytes += normalizedBytes;
    while (
      this.entries.size > this.maxEntries ||
      this.retainedBytes > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey)!;
      this.retainedBytes -= oldest.bytes;
      this.entries.delete(oldestKey);
    }
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }
}

interface FormulaRasterLayout {
  maxWidthCells: number;
  maxHeightCells: number;
  cellWidthPx: number;
  cellHeightPx: number;
  fitHeight?: boolean;
  splitRows?: boolean;
}

interface FormulaInkBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface FormulaRaster {
  base64Data: string;
  rowBase64Data?: readonly string[];
  widthPx: number;
  heightPx: number;
  columns: number;
  rows: number;
  pixelsPerEx: number;
  deviceScale: number;
  inkBounds: FormulaInkBounds;
}

type FormulaRenderFailureCode =
  | "empty-input"
  | "input-too-long"
  | "tex-error"
  | "invalid-svg"
  | "invalid-dimensions"
  | "font-required"
  | "height-limit"
  | "raster-limit"
  | "raster-error"
  | "empty-raster"
  | "clipped-raster"
  | "png-limit";

interface FormulaRenderFailure {
  code: FormulaRenderFailureCode;
  message: string;
}

interface SvgFormula {
  source: string;
  widthEx: number;
  heightEx: number;
  needsExternalFonts: boolean;
}

type SvgCacheValue = SvgFormula | FormulaRenderFailure;
type RasterCacheValue = FormulaRaster | FormulaRenderFailure;

interface TerminalMathRenderer {
  render(
    latex: string,
    display: boolean,
    color: string | undefined,
    layout: FormulaRasterLayout,
  ): FormulaRaster | undefined;
  clear(): void;
}

const MAX_INPUT_LENGTH = 20_000;
const MAX_RASTER_WIDTH = 4096;
const MAX_RASTER_HEIGHT = 4096;
const MAX_PNG_BYTES = 12 * 1024 * 1024;
const MAX_SVG_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_RASTER_CACHE_BYTES = 64 * 1024 * 1024;
const BASE_EX_TO_CELL_HEIGHT = 0.4;
const PREFERRED_DEVICE_SCALE = 2;
const CONTENT_BLEED_PX = 1;
const DEFAULT_FORMULA_COLOR = "#b5bd68";

function isFailure(
  value: SvgCacheValue | RasterCacheValue,
): value is FormulaRenderFailure {
  return "code" in value;
}

function failure(
  code: FormulaRenderFailureCode,
  message: string,
): FormulaRenderFailure {
  return { code, message };
}

function cacheWeight(value: string | FormulaRenderFailure): number {
  return typeof value === "string"
    ? value.length * 2
    : value.message.length * 2 + 64;
}

function normalizeColor(color: string | undefined): string {
  return color && /^#[\da-f]{6}$/iu.test(color)
    ? color.toLowerCase()
    : DEFAULT_FORMULA_COLOR;
}

function extractSvg(container: string): string | undefined {
  const start = container.indexOf("<svg");
  const end = container.lastIndexOf("</svg>");
  if (start < 0 || end < start) return undefined;
  return container.slice(start, end + 6);
}

function parseExDimension(
  svg: string,
  name: "width" | "height",
): number | undefined {
  const match = new RegExp(`\\b${name}="([\\d.]+)ex"`, "u").exec(svg);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]!);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function paddedSvg(
  source: string,
  color: string,
  contentWidth: number,
  contentHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): string | undefined {
  const openingEnd = source.indexOf(">");
  if (openingEnd < 0) return undefined;
  const originalOpening = source.slice(0, openingEnd + 1);
  const cleanedOpening = originalOpening
    .replace(/^<svg\s*/u, "")
    .replace(/\s(?:width|height|x|y|color|style|overflow)="[^"]*"/gu, "")
    .replace(/>$/u, "")
    .trim();
  const body = source.slice(openingEnd + 1, -6);
  const x = Math.max(0, (canvasWidth - contentWidth) / 2);
  const y = Math.max(0, (canvasHeight - contentHeight) / 2);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}" color="${color}">`,
    `<svg x="${x}" y="${y}" width="${contentWidth}" height="${contentHeight}" overflow="visible" ${cleanedOpening}>`,
    body,
    "</svg>",
    "</svg>",
  ].join("");
}

function normalizedLayout(
  layout: FormulaRasterLayout,
): Required<FormulaRasterLayout> {
  const finitePositive = (value: number): number =>
    Number.isFinite(value) ? Math.max(1, value) : 1;
  return {
    maxWidthCells: Math.max(
      1,
      Math.floor(finitePositive(layout.maxWidthCells)),
    ),
    maxHeightCells: Math.max(
      1,
      Math.floor(finitePositive(layout.maxHeightCells)),
    ),
    cellWidthPx: finitePositive(layout.cellWidthPx),
    cellHeightPx: finitePositive(layout.cellHeightPx),
    fitHeight: layout.fitHeight ?? false,
    splitRows: layout.splitRows ?? false,
  };
}

function alphaBounds(
  pixels: Uint8Array,
  width: number,
  height: number,
): FormulaInkBounds | undefined {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (
    let offset = 3, pixel = 0;
    offset < pixels.length;
    offset += 4, pixel++
  ) {
    if (pixels[offset] === 0) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX < 0
    ? undefined
    : { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 };
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function pngCrc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value = PNG_CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: "IHDR" | "IDAT" | "IEND", data: Uint8Array): Buffer {
  const chunk = Buffer.allocUnsafe(data.byteLength + 12);
  chunk.writeUInt32BE(data.byteLength, 0);
  chunk.write(type, 4, 4, "ascii");
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(
    pngCrc32(chunk.subarray(4, data.byteLength + 8)),
    data.byteLength + 8,
  );
  return chunk;
}

function encodePremultipliedPngSlice(
  pixels: Uint8Array,
  width: number,
  height: number,
  startY: number,
  endY: number,
): Buffer {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(startY) ||
    !Number.isInteger(endY) ||
    width < 1 ||
    height < 1 ||
    startY < 0 ||
    endY <= startY ||
    endY > height ||
    pixels.byteLength !== width * height * 4
  ) {
    throw new Error("Invalid RGBA row-slice dimensions");
  }

  // Resvg exposes premultiplied RGBA while PNG stores straight-alpha RGBA.
  // Math.round(channel * 255 / alpha) exactly matches Resvg's asPng() output.
  const stride = width * 4;
  const sliceHeight = endY - startY;
  const scanlines = Buffer.allocUnsafe((stride + 1) * sliceHeight);
  let target = 0;
  for (let y = startY; y < endY; y++) {
    scanlines[target++] = 0;
    const rowEnd = (y + 1) * stride;
    for (let source = y * stride; source < rowEnd; source += 4) {
      const alpha = pixels[source + 3]!;
      for (let channel = 0; channel < 3; channel++) {
        const premultiplied = pixels[source + channel]!;
        scanlines[target++] =
          alpha === 0
            ? 0
            : alpha === 0xff
              ? premultiplied
              : Math.min(0xff, Math.round((premultiplied * 0xff) / alpha));
      }
      scanlines[target++] = alpha;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(sliceHeight, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const compressed = deflateSync(scanlines);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodePngRowSlices(
  pixels: Uint8Array,
  width: number,
  height: number,
  rows: number,
): Buffer[] {
  if (!Number.isInteger(rows) || rows < 1 || height < rows) {
    throw new Error("Invalid terminal-row slice count");
  }
  return Array.from({ length: rows }, (_, row) => {
    const startY = Math.floor((height * row) / rows);
    const endY = Math.floor((height * (row + 1)) / rows);
    return encodePremultipliedPngSlice(pixels, width, height, startY, endY);
  });
}

function chooseDeviceScale(
  logicalWidth: number,
  logicalHeight: number,
): number | undefined {
  if (
    logicalWidth * PREFERRED_DEVICE_SCALE <= MAX_RASTER_WIDTH &&
    logicalHeight * PREFERRED_DEVICE_SCALE <= MAX_RASTER_HEIGHT
  ) {
    return PREFERRED_DEVICE_SCALE;
  }
  if (logicalWidth <= MAX_RASTER_WIDTH && logicalHeight <= MAX_RASTER_HEIGHT)
    return 1;
  return undefined;
}

function createSvgMathRenderer(
  mathJax: MathJaxVendor,
  resvg: ResvgVendor,
  configuration: RendererConfiguration,
): TerminalMathRenderer {
  const adaptor = mathJax.liteAdaptor({
    cjkCharWidth: 1,
    unknownCharWidth: 0.6,
    unknownCharHeight: 0.8,
  });
  mathJax.SafeHandler(mathJax.RegisterHTMLHandler(adaptor));
  const input = new mathJax.TeX({
    packages: [...ENABLED_TEX_PACKAGES],
    maxBuffer: MAX_INPUT_LENGTH,
    maxMacros: 1_000,
    tags: "none",
    formatError: (_jax: unknown, error: Error) => {
      throw error;
    },
  });
  const output = new mathJax.SVG({
    fontCache: "none",
    mtextInheritFont: false,
    unknownFamily: "serif",
  });
  const document = mathJax.mathjax.document("", {
    InputJax: input,
    OutputJax: output,
    safeOptions: {
      allow: { URLs: "none", classes: "safe", cssIDs: "safe", styles: "none" },
      idPattern: /^mjx-eqn:[-A-Za-z0-9_.]+$/u,
    },
  });
  const svgCache = new WeightedLruCache<SvgCacheValue>(
    512,
    MAX_SVG_CACHE_BYTES,
  );
  const rasterCache = new WeightedLruCache<RasterCacheValue>(
    256,
    MAX_RASTER_CACHE_BYTES,
  );
  let fontBuffers: Uint8Array[] | undefined;
  let lastFailure: FormulaRenderFailure | undefined;

  const fail = (value: FormulaRenderFailure): undefined => {
    lastFailure = value;
    return undefined;
  };

  const getFontBuffers = (): Uint8Array[] | undefined => {
    if (configuration.fontFiles.length === 0) return undefined;
    if (!fontBuffers) {
      fontBuffers = configuration.fontFiles.map(
        (path) => new Uint8Array(readFileSync(path)),
      );
    }
    return fontBuffers;
  };

  const clearFormulaLocalDefinitions = (): void => {
    const handlers = input.parseOptions?.handlers;
    if (!handlers) return;
    for (const name of ["new-Command", "new-Delimiter", "new-Environment"]) {
      const symbols = handlers.retrieve(name)?.map;
      symbols?.clear();
    }
  };

  const formulaSvg = (
    latex: string,
    display: boolean,
  ): SvgFormula | undefined => {
    const key = `${display ? "display" : "inline"}\0${latex}`;
    if (svgCache.has(key)) {
      const cached = svgCache.get(key)!;
      return isFailure(cached) ? fail(cached) : cached;
    }

    try {
      input.reset();
      let node: unknown;
      try {
        node = document.convert(latex, { display });
      } finally {
        // The newcommand package stores definitions in mutable per-input maps.
        // Clearing all three maps keeps \def, \newcommand, \let, and custom
        // environments local to this independently rendered formula.
        clearFormulaLocalDefinitions();
      }
      const source = extractSvg(adaptor.outerHTML(node));
      if (!source || source.includes('data-mml-node="merror"')) {
        const invalid = failure(
          "invalid-svg",
          "MathJax did not produce a valid SVG formula",
        );
        svgCache.set(key, invalid, cacheWeight(invalid));
        return fail(invalid);
      }
      const widthEx = parseExDimension(source, "width");
      const heightEx = parseExDimension(source, "height");
      if (!widthEx || !heightEx) {
        const invalid = failure(
          "invalid-dimensions",
          "MathJax SVG has no positive ex dimensions",
        );
        svgCache.set(key, invalid, cacheWeight(invalid));
        return fail(invalid);
      }
      const formula: SvgFormula = {
        source,
        widthEx,
        heightEx,
        needsExternalFonts: /<text(?:\s|>)/u.test(source),
      };
      svgCache.set(key, formula, cacheWeight(source) + 48);
      return formula;
    } catch (error) {
      const invalid = failure("tex-error", errorMessage(error));
      svgCache.set(key, invalid, cacheWeight(invalid));
      return fail(invalid);
    }
  };

  const render = (
    source: string,
    display: boolean,
    requestedColor: string | undefined,
    requestedLayout: FormulaRasterLayout,
  ): FormulaRaster | undefined => {
    lastFailure = undefined;
    const latex = source.trim();
    if (!latex) return fail(failure("empty-input", "Formula is empty"));
    if (latex.length > MAX_INPUT_LENGTH) {
      return fail(
        failure(
          "input-too-long",
          `Formula exceeds ${MAX_INPUT_LENGTH} characters`,
        ),
      );
    }

    const color = normalizeColor(requestedColor);
    const layout = normalizedLayout(requestedLayout);
    const svg = formulaSvg(latex, display);
    if (!svg) return undefined;
    const rasterKey = [
      display ? "display" : "inline",
      color,
      layout.maxWidthCells,
      layout.maxHeightCells,
      layout.cellWidthPx,
      layout.cellHeightPx,
      layout.fitHeight ? "fit-height" : "width-only",
      layout.splitRows ? "split-rows" : "single-png",
      latex,
    ].join("\0");
    if (rasterCache.has(rasterKey)) {
      const cached = rasterCache.get(rasterKey)!;
      return isFailure(cached) ? fail(cached) : cached;
    }

    const rememberFailure = (value: FormulaRenderFailure): undefined => {
      rasterCache.set(rasterKey, value, cacheWeight(value));
      return fail(value);
    };

    if (svg.needsExternalFonts && configuration.fontFiles.length === 0) {
      return rememberFailure(
        failure(
          "font-required",
          "Formula contains text glyphs but PI_MATH_FONT_FILES is not configured",
        ),
      );
    }

    let resvgInstance: ResvgInstance | undefined;
    let rendered: ResvgRenderedImage | undefined;
    try {
      const maxLogicalWidth = layout.maxWidthCells * layout.cellWidthPx;
      const maxLogicalHeight = layout.maxHeightCells * layout.cellHeightPx;
      const innerWidth = maxLogicalWidth - CONTENT_BLEED_PX * 2;
      const innerHeight = maxLogicalHeight - CONTENT_BLEED_PX * 2;
      if (innerWidth <= 0 || innerHeight <= 0) {
        return rememberFailure(
          failure("raster-limit", "Terminal cells leave no drawable area"),
        );
      }

      const basePixelsPerEx = layout.cellHeightPx * BASE_EX_TO_CELL_HEIGHT;
      const widthPixelsPerEx = innerWidth / svg.widthEx;
      const heightPixelsPerEx = layout.fitHeight
        ? innerHeight / svg.heightEx
        : Number.POSITIVE_INFINITY;
      const pixelsPerEx = Math.min(
        basePixelsPerEx,
        widthPixelsPerEx,
        heightPixelsPerEx,
      );
      const logicalContentWidth = svg.widthEx * pixelsPerEx;
      const logicalContentHeight = svg.heightEx * pixelsPerEx;
      const columns = Math.max(
        1,
        Math.min(
          layout.maxWidthCells,
          Math.ceil(
            (logicalContentWidth + CONTENT_BLEED_PX * 2) / layout.cellWidthPx -
              1e-9,
          ),
        ),
      );
      const rows = Math.max(
        1,
        Math.ceil(
          (logicalContentHeight + CONTENT_BLEED_PX * 2) / layout.cellHeightPx -
            1e-9,
        ),
      );
      if (rows > layout.maxHeightCells) {
        return rememberFailure(
          failure("height-limit", `Formula requires ${rows} terminal rows`),
        );
      }

      const logicalCanvasWidth = columns * layout.cellWidthPx;
      const logicalCanvasHeight = rows * layout.cellHeightPx;
      const deviceScale = chooseDeviceScale(
        logicalCanvasWidth,
        logicalCanvasHeight,
      );
      if (!deviceScale) {
        return rememberFailure(
          failure(
            "raster-limit",
            "Formula exceeds the maximum raster dimensions",
          ),
        );
      }
      const contentWidth = logicalContentWidth * deviceScale;
      const contentHeight = logicalContentHeight * deviceScale;
      const canvasWidth = Math.ceil(logicalCanvasWidth * deviceScale);
      const canvasHeight = Math.ceil(logicalCanvasHeight * deviceScale);
      const padded = paddedSvg(
        svg.source,
        color,
        contentWidth,
        contentHeight,
        canvasWidth,
        canvasHeight,
      );
      if (!padded) {
        return rememberFailure(
          failure("invalid-svg", "Could not construct the padded SVG"),
        );
      }

      const fontBuffersForFormula = svg.needsExternalFonts
        ? getFontBuffers()
        : undefined;
      resvgInstance = new resvg.Resvg(padded, {
        font: fontBuffersForFormula
          ? { fontBuffers: fontBuffersForFormula }
          : undefined,
        shapeRendering: 2,
        textRendering: 2,
      });
      rendered = resvgInstance.render();
      if (
        rendered.width !== canvasWidth ||
        rendered.height !== canvasHeight ||
        rendered.width > MAX_RASTER_WIDTH ||
        rendered.height > MAX_RASTER_HEIGHT
      ) {
        return rememberFailure(
          failure(
            "raster-limit",
            "Resvg returned unexpected raster dimensions",
          ),
        );
      }

      const inkBounds = alphaBounds(
        rendered.pixels,
        rendered.width,
        rendered.height,
      );
      if (!inkBounds) {
        return rememberFailure(
          failure("empty-raster", "Formula raster contains no visible pixels"),
        );
      }
      if (
        inkBounds.left === 0 ||
        inkBounds.top === 0 ||
        inkBounds.right === rendered.width ||
        inkBounds.bottom === rendered.height
      ) {
        return rememberFailure(
          failure("clipped-raster", "Formula ink reaches the raster boundary"),
        );
      }

      const png = rendered.asPng();
      if (png.byteLength > MAX_PNG_BYTES) {
        return rememberFailure(
          failure("png-limit", `Formula PNG exceeds ${MAX_PNG_BYTES} bytes`),
        );
      }
      const base64Data = Buffer.from(png).toString("base64");
      let rowBase64Data: readonly string[] | undefined;
      let rowPngBytes = 0;
      let rowBase64Bytes = 0;
      if (layout.splitRows) {
        if (rows === 1) {
          rowBase64Data = [base64Data];
        } else {
          const rowPngs = encodePngRowSlices(
            rendered.pixels,
            rendered.width,
            rendered.height,
            rows,
          );
          rowPngBytes = rowPngs.reduce(
            (total, rowPng) => total + rowPng.byteLength,
            0,
          );
          if (rowPngBytes > MAX_PNG_BYTES) {
            return rememberFailure(
              failure(
                "png-limit",
                `Formula row PNGs exceed ${MAX_PNG_BYTES} bytes`,
              ),
            );
          }
          rowBase64Data = rowPngs.map((rowPng) => rowPng.toString("base64"));
          rowBase64Bytes = rowBase64Data.reduce(
            (total, rowBase64) => total + rowBase64.length,
            0,
          );
        }
      }
      const result: FormulaRaster = {
        base64Data,
        ...(rowBase64Data ? { rowBase64Data } : {}),
        widthPx: rendered.width,
        heightPx: rendered.height,
        columns,
        rows,
        pixelsPerEx,
        deviceScale,
        inkBounds,
      };
      rasterCache.set(
        rasterKey,
        result,
        png.byteLength +
          base64Data.length +
          rowPngBytes +
          rowBase64Bytes +
          (rowBase64Data ? rowBase64Data.length * 16 : 0) +
          128,
      );
      return result;
    } catch (error) {
      return rememberFailure(failure("raster-error", errorMessage(error)));
    } finally {
      rendered?.free();
      resvgInstance?.free();
    }
  };

  return {
    render,
    clear() {
      svgCache.clear();
      rasterCache.clear();
      fontBuffers = undefined;
      lastFailure = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Message-level LaTeX normalization
// ---------------------------------------------------------------------------

const STRIPPABLE_ENVIRONMENTS = new Set([
  "equation",
  "equation*",
  "displaymath",
  "math",
]);

function isEscapedCommand(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--)
    backslashes++;
  return backslashes % 2 === 1;
}

function findMatchingBrace(text: string, opening: number): number {
  let depth = 0;
  for (let index = opening; index < text.length; index++) {
    if (isEscapedCommand(text, index)) continue;
    if (text[index] === "{") depth++;
    if (text[index] === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function replaceBracedCommand(
  input: string,
  command: "label" | "tag",
  replacement: (body: string, starred: boolean) => string,
): string {
  let output = input;
  let searchFrom = 0;
  const marker = `\\${command}`;
  while (searchFrom < output.length) {
    const start = output.indexOf(marker, searchFrom);
    if (start < 0) break;
    let cursor = start + marker.length;
    const starred = command === "tag" && output[cursor] === "*";
    if (starred) cursor++;
    if (/[A-Za-z]/u.test(output[cursor] ?? "")) {
      searchFrom = cursor;
      continue;
    }
    while (/\s/u.test(output[cursor] ?? "")) cursor++;
    if (output[cursor] !== "{") {
      searchFrom = cursor;
      continue;
    }
    const closing = findMatchingBrace(output, cursor);
    if (closing < 0) break;
    const body = output.slice(cursor + 1, closing);
    const rendered = replacement(body, starred);
    output = output.slice(0, start) + rendered + output.slice(closing + 1);
    searchFrom = start + rendered.length;
  }
  return output;
}

function unwrapOuterEnvironment(input: string): string | undefined {
  const opening = /^\\begin\{([^}]+)\}/u.exec(input);
  if (!opening || !STRIPPABLE_ENVIRONMENTS.has(opening[1]!)) return undefined;
  const closing = `\\end{${opening[1]!}}`;
  if (!input.endsWith(closing)) return undefined;
  return input.slice(opening[0].length, -closing.length);
}

function normalizeLatex(input: string): string {
  let latex = replaceBracedCommand(input.trim(), "label", () => "");
  latex = replaceBracedCommand(latex, "tag", (body, starred) =>
    starred ? `\\qquad\\mathrm{${body}}` : `\\qquad\\mathrm{(${body})}`,
  )
    .replace(/\\(?:notag|nonumber)\b/gu, "")
    .trim();
  for (;;) {
    const body = unwrapOuterEnvironment(latex);
    if (body === undefined) break;
    latex = body.trim();
  }
  return latex;
}

async function createTerminalMathRenderer(
  configuration: RendererConfiguration,
): Promise<TerminalMathRenderer> {
  const mathJax = loadMathJaxVendor();
  const resvg = await initializeResvgVendor();
  const renderer = createSvgMathRenderer(mathJax, resvg, configuration);
  return {
    render(latex, display, color, layout) {
      if (latex.length > MAX_INPUT_LENGTH) return undefined;
      const normalized = normalizeLatex(latex);
      return normalized
        ? renderer.render(normalized, display, color, layout)
        : undefined;
    },
    clear: () => renderer.clear(),
  };
}

// ---------------------------------------------------------------------------
// Markdown and TeX-aware formula scanning
// ---------------------------------------------------------------------------

const GENERATED_MATH_LANGUAGE = "math-4f9c";
const BLOCK_ENVIRONMENT_PATTERN =
  /^\\begin\{(equation\*?|displaymath|math|align\*?|alignat\*?|flalign\*?|gather\*?|multline\*?|split|aligned|alignedat|gathered|array|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases)\}/u;

interface MathRenderResult {
  text: string;
  forceBlock?: boolean;
  rawInline?: boolean;
}

interface MathSpanContext {
  start: number;
  end: number;
  standalone: boolean;
}

type MathReplacementRender = (
  latex: string,
  display: boolean,
  context: MathSpanContext,
) => string | MathRenderResult | undefined;

function isEscapedMarkdown(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--)
    backslashes++;
  return backslashes % 2 === 1;
}

function countRun(text: string, index: number, character: string): number {
  let end = index;
  while (text[end] === character) end++;
  return end - index;
}

function isFencePrefix(prefix: string): boolean {
  return /^(?:(?:[ \t]*>[ \t]?)*[ \t]*)$/u.test(prefix);
}

function skipFencedCode(text: string, index: number): number | undefined {
  const character = text[index];
  if (character !== "`" && character !== "~") return undefined;
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  if (!isFencePrefix(text.slice(lineStart, index))) return undefined;
  const openingLength = countRun(text, index, character);
  if (openingLength < 3) return undefined;
  const openingLineEnd = text.indexOf("\n", index + openingLength);
  if (openingLineEnd < 0) return text.length;

  let nextLineStart = openingLineEnd + 1;
  while (nextLineStart <= text.length) {
    const nextLineEnd = text.indexOf("\n", nextLineStart);
    const lineEnd = nextLineEnd < 0 ? text.length : nextLineEnd;
    const line = text.slice(nextLineStart, lineEnd).replace(/\r$/u, "");
    const match = /^(?:(?:[ \t]*>[ \t]?)*[ \t]*)(`+|~+)[ \t]*$/u.exec(line);
    if (match) {
      const closingRun = match[1]!;
      if (closingRun[0] === character && closingRun.length >= openingLength) {
        return nextLineEnd < 0 ? text.length : nextLineEnd + 1;
      }
    }
    if (nextLineEnd < 0) break;
    nextLineStart = nextLineEnd + 1;
  }
  return text.length;
}

function markdownLineContent(line: string): string {
  return line.replace(/^(?: {0,3}>[ \t]?)+/u, "");
}

function isIndentedCodeLine(line: string): boolean {
  return /^(?: {4}|\t)/u.test(markdownLineContent(line));
}

function skipIndentedCode(text: string, index: number): number | undefined {
  if (index > 0 && text[index - 1] !== "\n") return undefined;
  const firstLineEnd = text.indexOf("\n", index);
  const firstEnd = firstLineEnd < 0 ? text.length : firstLineEnd;
  const firstLine = text.slice(index, firstEnd).replace(/\r$/u, "");
  if (
    !isIndentedCodeLine(firstLine) ||
    markdownLineContent(firstLine).trim() === ""
  ) {
    return undefined;
  }

  let lineStart = index;
  while (lineStart < text.length) {
    const nextLineEnd = text.indexOf("\n", lineStart);
    const lineEnd = nextLineEnd < 0 ? text.length : nextLineEnd;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/u, "");
    const content = markdownLineContent(line);
    if (content.trim() !== "" && !isIndentedCodeLine(line)) return lineStart;
    if (nextLineEnd < 0) return text.length;
    lineStart = nextLineEnd + 1;
  }
  return text.length;
}

function skipInlineCode(text: string, index: number): number {
  const runLength = countRun(text, index, "`");
  const marker = "`".repeat(runLength);
  let searchFrom = index + runLength;
  while (searchFrom < text.length) {
    const closing = text.indexOf(marker, searchFrom);
    if (closing < 0) return index + runLength;
    const hasBacktickBefore = closing > 0 && text[closing - 1] === "`";
    const hasBacktickAfter = text[closing + runLength] === "`";
    if (!hasBacktickBefore && !hasBacktickAfter) return closing + runLength;
    searchFrom = closing + 1;
  }
  return index + runLength;
}

function skipHtmlCode(
  text: string,
  lowerText: string,
  index: number,
): number | undefined {
  if (text.startsWith("<!--", index)) {
    const closing = text.indexOf("-->", index + 4);
    return closing < 0 ? text.length : closing + 3;
  }
  const opening = /^<(code|pre)(?:\s|>)/iu.exec(text.slice(index));
  if (!opening) return undefined;
  const openingEnd = text.indexOf(">", index + opening[0].length - 1);
  if (openingEnd < 0) return text.length;
  const closingTag = `</${opening[1]!.toLowerCase()}>`;
  const closing = lowerText.indexOf(closingTag, openingEnd + 1);
  return closing < 0 ? text.length : closing + closingTag.length;
}

function skipTexVerb(text: string, index: number): number | undefined {
  if (
    !text.startsWith("\\verb", index) ||
    /[A-Za-z]/u.test(text[index + 5] ?? "")
  ) {
    return undefined;
  }
  let cursor = index + 5;
  if (text[cursor] === "*") cursor++;
  const delimiter = text[cursor];
  if (!delimiter || /[A-Za-z0-9\s]/u.test(delimiter)) return undefined;
  const closing = text.indexOf(delimiter, cursor + 1);
  return closing < 0 ? text.length : closing + 1;
}

function findUnescapedSequence(
  text: string,
  sequence: string,
  from: number,
): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === "%" && !isEscapedMarkdown(text, index)) {
      const lineEnd = text.indexOf("\n", index + 1);
      if (lineEnd < 0) return -1;
      index = lineEnd + 1;
      continue;
    }
    if (text[index] === "\\" && !isEscapedMarkdown(text, index)) {
      const verbEnd = skipTexVerb(text, index);
      if (verbEnd !== undefined) {
        index = verbEnd;
        continue;
      }
    }
    if (text.startsWith(sequence, index) && !isEscapedMarkdown(text, index))
      return index;
    index++;
  }
  return -1;
}

function findEnvironmentEnd(
  text: string,
  openingEnd: number,
  openingName: string,
): number {
  const stack = [openingName];
  let index = openingEnd;
  while (index < text.length) {
    if (text[index] === "%" && !isEscapedMarkdown(text, index)) {
      const lineEnd = text.indexOf("\n", index + 1);
      if (lineEnd < 0) return -1;
      index = lineEnd + 1;
      continue;
    }
    if (text[index] !== "\\" || isEscapedMarkdown(text, index)) {
      index++;
      continue;
    }
    const verbEnd = skipTexVerb(text, index);
    if (verbEnd !== undefined) {
      index = verbEnd;
      continue;
    }
    const token = /^\\(begin|end)\{([^{}]+)\}/u.exec(text.slice(index));
    if (!token) {
      index++;
      continue;
    }
    const [, kind, name] = token;
    if (kind === "begin") {
      stack.push(name!);
    } else if (stack.at(-1) === name) {
      stack.pop();
      if (stack.length === 0) return index + token[0].length;
    }
    index += token[0].length;
  }
  return -1;
}

function isInlineDollarOpener(text: string, index: number): boolean {
  if (
    isEscapedMarkdown(text, index) ||
    text[index + 1] === "$" ||
    index + 1 >= text.length
  ) {
    return false;
  }
  return !/\s/u.test(text[index + 1]!);
}

function findInlineDollarCloser(text: string, from: number): number {
  for (let index = from; index < text.length; index++) {
    const character = text[index];
    if (character === "\n" || character === "\r") return -1;
    if (character !== "$" || isEscapedMarkdown(text, index)) continue;
    if (
      text[index + 1] === "$" ||
      text[index - 1] === "$" ||
      /\s/u.test(text[index - 1] ?? "")
    ) {
      continue;
    }
    const next = text[index + 1];
    if (next !== undefined && /\d/u.test(next)) continue;
    return index;
  }
  return -1;
}

function containsUnescapedDollar(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "$" && !isEscapedMarkdown(text, index)) return true;
  }
  return false;
}

function spanContext(
  markdown: string,
  start: number,
  end: number,
): MathSpanContext {
  const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
  const nextLineBreak = markdown.indexOf("\n", end);
  const lineEnd = nextLineBreak < 0 ? markdown.length : nextLineBreak;
  return {
    start,
    end,
    standalone:
      markdown.slice(lineStart, start).trim() === "" &&
      markdown.slice(end, lineEnd).trim() === "",
  };
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/gu))
    longest = Math.max(longest, match[0].length);
  return longest;
}

function inlineCodeSpan(text: string): string {
  const fence = "`".repeat(Math.max(1, longestBacktickRun(text) + 1));
  const needsPadding =
    text.startsWith(" ") ||
    text.endsWith(" ") ||
    text.startsWith("`") ||
    text.endsWith("`");
  const padding = needsPadding ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

function displayCodeBlock(text: string): string {
  const fence = "`".repeat(Math.max(4, longestBacktickRun(text) + 1));
  return `\n\n${fence}${GENERATED_MATH_LANGUAGE}\n${text}\n${fence}\n\n`;
}

function replacementFor(
  latex: string,
  display: boolean,
  context: MathSpanContext,
  renderMath: MathReplacementRender,
): string | undefined {
  if (!latex.trim()) return undefined;
  let rendered: string | MathRenderResult | undefined;
  try {
    rendered = renderMath(latex, display, context);
  } catch {
    return undefined;
  }
  if (!rendered) return undefined;
  const result: MathRenderResult =
    typeof rendered === "string"
      ? { text: rendered, forceBlock: false }
      : rendered;
  const normalized = result.text
    .replace(/\r\n?/gu, "\n")
    .replace(/^\n+|\n+$/gu, "");
  if (!normalized.trim()) return undefined;
  if (display || result.forceBlock || normalized.includes("\n")) {
    return displayCodeBlock(normalized);
  }
  return result.rawInline ? normalized : inlineCodeSpan(normalized);
}

function containsPotentialMath(markdown: string): boolean {
  return (
    markdown.includes("$") ||
    markdown.includes("\\(") ||
    markdown.includes("\\[") ||
    markdown.includes("\\begin{")
  );
}

function expandMathInMarkdown(
  markdown: string,
  renderMath: MathReplacementRender,
): string {
  if (!containsPotentialMath(markdown)) return markdown;
  const lowerMarkdown = markdown.toLowerCase();
  const chunks: string[] = [];
  let copiedThrough = 0;
  let index = 0;

  const replace = (start: number, end: number, replacement: string): void => {
    chunks.push(markdown.slice(copiedThrough, start), replacement);
    copiedThrough = end;
    index = end;
  };

  while (index < markdown.length) {
    const character = markdown[index]!;
    const indentedCodeEnd = skipIndentedCode(markdown, index);
    if (indentedCodeEnd !== undefined) {
      index = indentedCodeEnd;
      continue;
    }
    const fencedCodeEnd = skipFencedCode(markdown, index);
    if (fencedCodeEnd !== undefined) {
      index = fencedCodeEnd;
      continue;
    }
    if (character === "`") {
      index = skipInlineCode(markdown, index);
      continue;
    }
    if (character === "<") {
      const htmlCodeEnd = skipHtmlCode(markdown, lowerMarkdown, index);
      if (htmlCodeEnd !== undefined) {
        index = htmlCodeEnd;
        continue;
      }
    }
    if (character === "\\" && !isEscapedMarkdown(markdown, index)) {
      const verbEnd = skipTexVerb(markdown, index);
      if (verbEnd !== undefined) {
        index = verbEnd;
        continue;
      }
    }

    if (character === "$" && !isEscapedMarkdown(markdown, index)) {
      if (markdown[index + 1] === "$") {
        const closing = findUnescapedSequence(markdown, "$$", index + 2);
        if (closing >= 0) {
          const end = closing + 2;
          const replacement = replacementFor(
            markdown.slice(index + 2, closing),
            true,
            spanContext(markdown, index, end),
            renderMath,
          );
          if (replacement !== undefined) replace(index, end, replacement);
          else index = end;
          continue;
        }
        index += 2;
        continue;
      }

      if (isInlineDollarOpener(markdown, index)) {
        const closing = findInlineDollarCloser(markdown, index + 1);
        if (closing >= 0) {
          const latex = markdown.slice(index + 1, closing);
          if (containsUnescapedDollar(latex)) {
            index++;
            continue;
          }
          const end = closing + 1;
          const replacement = replacementFor(
            latex,
            false,
            spanContext(markdown, index, end),
            renderMath,
          );
          if (replacement !== undefined) replace(index, end, replacement);
          else index = end;
          continue;
        }
      }
    }

    if (character === "\\" && !isEscapedMarkdown(markdown, index)) {
      const delimiter = markdown[index + 1];
      if (delimiter === "(" || delimiter === "[") {
        const closingSequence = delimiter === "(" ? "\\)" : "\\]";
        const closing = findUnescapedSequence(
          markdown,
          closingSequence,
          index + 2,
        );
        if (closing >= 0) {
          const end = closing + 2;
          const display = delimiter === "[";
          const replacement = replacementFor(
            markdown.slice(index + 2, closing),
            display,
            spanContext(markdown, index, end),
            renderMath,
          );
          if (replacement !== undefined) replace(index, end, replacement);
          else index = end;
          continue;
        }
      }

      const environment = BLOCK_ENVIRONMENT_PATTERN.exec(markdown.slice(index));
      if (environment) {
        const environmentName = environment[1]!;
        const end = findEnvironmentEnd(
          markdown,
          index + environment[0].length,
          environmentName,
        );
        if (end >= 0) {
          const display = environmentName !== "math";
          const replacement = replacementFor(
            markdown.slice(index, end),
            display,
            spanContext(markdown, index, end),
            renderMath,
          );
          if (replacement !== undefined) replace(index, end, replacement);
          else index = end;
          continue;
        }
      }
    }
    index++;
  }

  if (copiedThrough === 0) return markdown;
  chunks.push(markdown.slice(copiedThrough));
  return chunks.join("");
}

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/gu, "");
}

function stripGeneratedMathFenceLines(lines: string[]): string[] {
  const output: string[] = [];
  let insideGeneratedMath = false;
  let suppressFollowingBlankLines = false;
  for (const line of lines) {
    const plain = stripSgr(line).trim();
    if (!insideGeneratedMath && plain === `\`\`\`${GENERATED_MATH_LANGUAGE}`) {
      while (output.length > 0 && stripSgr(output.at(-1)!).trim() === "")
        output.pop();
      insideGeneratedMath = true;
      suppressFollowingBlankLines = false;
      continue;
    }
    if (insideGeneratedMath && plain === "```") {
      insideGeneratedMath = false;
      suppressFollowingBlankLines = true;
      continue;
    }
    if (!insideGeneratedMath && suppressFollowingBlankLines && plain === "")
      continue;
    suppressFollowingBlankLines = false;
    output.push(line);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Kitty graphics and terminal image placement
// ---------------------------------------------------------------------------

const KITTY_CHUNK_SIZE = 4096;
const KITTY_PLACEHOLDER = String.fromCodePoint(0x10eeee);
const MAX_KITTY_PLACEHOLDER_DIMENSION = 297;

// Kitty's canonical row/column diacritic table (Unicode combining class 230).
const DIACRITIC_CODE_POINTS = [
  0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b,
  0x34c, 0x350, 0x351, 0x352, 0x357, 0x35b, 0x363, 0x364, 0x365, 0x366, 0x367,
  0x368, 0x369, 0x36a, 0x36b, 0x36c, 0x36d, 0x36e, 0x36f, 0x483, 0x484, 0x485,
  0x486, 0x487, 0x592, 0x593, 0x594, 0x595, 0x597, 0x598, 0x599, 0x59c, 0x59d,
  0x59e, 0x59f, 0x5a0, 0x5a1, 0x5a8, 0x5a9, 0x5ab, 0x5ac, 0x5af, 0x5c4, 0x610,
  0x611, 0x612, 0x613, 0x614, 0x615, 0x616, 0x617, 0x657, 0x658, 0x659, 0x65a,
  0x65b, 0x65d, 0x65e, 0x6d6, 0x6d7, 0x6d8, 0x6d9, 0x6da, 0x6db, 0x6dc, 0x6df,
  0x6e0, 0x6e1, 0x6e2, 0x6e4, 0x6e7, 0x6e8, 0x6eb, 0x6ec, 0x730, 0x732, 0x733,
  0x735, 0x736, 0x73a, 0x73d, 0x73f, 0x740, 0x741, 0x743, 0x745, 0x747, 0x749,
  0x74a, 0x7eb, 0x7ec, 0x7ed, 0x7ee, 0x7ef, 0x7f0, 0x7f1, 0x7f3, 0x816, 0x817,
  0x818, 0x819, 0x81b, 0x81c, 0x81d, 0x81e, 0x81f, 0x820, 0x821, 0x822, 0x823,
  0x825, 0x826, 0x827, 0x829, 0x82a, 0x82b, 0x82c, 0x82d, 0x951, 0x953, 0x954,
  0xf82, 0xf83, 0xf86, 0xf87, 0x135d, 0x135e, 0x135f, 0x17dd, 0x193a, 0x1a17,
  0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b,
  0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1,
  0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4, 0x1dc5,
  0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3,
  0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc,
  0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5,
  0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db,
  0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0, 0x2cef, 0x2cf0, 0x2cf1, 0x2de0,
  0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9,
  0x2dea, 0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2,
  0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa, 0x2dfb,
  0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1,
  0xa8e0, 0xa8e1, 0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8,
  0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1,
  0xaab0, 0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20,
  0xfe21, 0xfe22, 0xfe23, 0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185,
  0x1d186, 0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad,
  0x1d242, 0x1d243, 0x1d244,
] as const;
const DIACRITICS = DIACRITIC_CODE_POINTS.map((codePoint) =>
  String.fromCodePoint(codePoint),
);

function kittyPlaceholderSupport(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const termProgram = environment.TERM_PROGRAM?.toLowerCase() ?? "";
  const term = environment.TERM?.toLowerCase() ?? "";
  return Boolean(
    environment.KITTY_WINDOW_ID ||
    termProgram === "kitty" ||
    termProgram === "ghostty" ||
    term.includes("xterm-kitty") ||
    term.includes("ghostty") ||
    environment.GHOSTTY_RESOURCES_DIR,
  );
}

function wezTermOscImageSupport(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const termProgram = environment.TERM_PROGRAM?.toLowerCase();
  if (termProgram) return termProgram === "wezterm";
  return Boolean(
    environment.WEZTERM_PANE !== undefined || environment.WEZTERM_EXECUTABLE,
  );
}

function warpKittyImageSupport(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const termProgram = environment.TERM_PROGRAM?.toLowerCase();
  if (termProgram) return termProgram === "warpterminal";
  return Boolean(
    environment.WARP_SESSION_ID || environment.WARP_TERMINAL_SESSION_UUID,
  );
}

function rgbParameters(id: number): string {
  return `${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}`;
}

function encodeVirtualImage(
  base64Data: string,
  imageId: number,
  placementId: number,
  columns: number,
  rows: number,
): string {
  const parameters = [
    "a=T",
    "f=100",
    "q=2",
    "U=1",
    `i=${imageId}`,
    `p=${placementId}`,
    `c=${columns}`,
    `r=${rows}`,
  ];
  if (base64Data.length <= KITTY_CHUNK_SIZE) {
    return `\x1b_G${parameters.join(",")};${base64Data}\x1b\\`;
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < base64Data.length; offset += KITTY_CHUNK_SIZE) {
    const chunk = base64Data.slice(offset, offset + KITTY_CHUNK_SIZE);
    const first = offset === 0;
    const last = offset + KITTY_CHUNK_SIZE >= base64Data.length;
    if (first) chunks.push(`\x1b_G${parameters.join(",")},m=1;${chunk}\x1b\\`);
    else chunks.push(`\x1b_Gm=${last ? 0 : 1},q=2;${chunk}\x1b\\`);
  }
  return chunks.join("");
}

interface KittyVirtualImage {
  sequence: string;
  placeholders: string[];
}

function renderKittyVirtualImage(
  base64Data: string,
  requestedImageId: number,
  columns: number,
  rows: number,
): KittyVirtualImage | undefined {
  if (
    columns < 1 ||
    rows < 1 ||
    columns > MAX_KITTY_PLACEHOLDER_DIMENSION ||
    rows > MAX_KITTY_PLACEHOLDER_DIMENSION
  ) {
    return undefined;
  }
  const imageId = requestedImageId & 0xffffff || 1;
  const placementId = imageId;
  const foreground = `\x1b[38;2;${rgbParameters(imageId)}m`;
  const underline = `\x1b[58;2;${rgbParameters(placementId)}m`;
  const reset = "\x1b[39;59m";
  const placeholders = Array.from({ length: rows }, (_, row) => {
    let cells = `${foreground}${underline}`;
    for (let column = 0; column < columns; column++) {
      cells += `${KITTY_PLACEHOLDER}${DIACRITICS[row]}${DIACRITICS[column]}`;
    }
    return `${cells}${reset}`;
  });
  return {
    sequence: encodeVirtualImage(
      base64Data,
      imageId,
      placementId,
      columns,
      rows,
    ),
    placeholders,
  };
}

interface FormulaImagePlacement {
  marker: string;
  imageId: number;
  rowImageIds?: readonly number[];
  raster: FormulaRaster;
  inline: boolean;
  fallbackText: string;
}

interface FormulaImageArea {
  renderWidth: number;
  paddingX: number;
}

function renderNativeImage(placement: FormulaImagePlacement) {
  return renderImage(
    placement.raster.base64Data,
    { widthPx: placement.raster.widthPx, heightPx: placement.raster.heightPx },
    {
      maxWidthCells: placement.raster.columns,
      maxHeightCells: placement.raster.rows,
      imageId: placement.imageId,
      moveCursor: false,
    },
  );
}

function pngPixelDimensions(
  base64Data: string,
): { widthPx: number; heightPx: number } | undefined {
  try {
    const png = Buffer.from(base64Data, "base64");
    if (
      png.byteLength < 24 ||
      !png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
    ) {
      return undefined;
    }
    const widthPx = png.readUInt32BE(16);
    const heightPx = png.readUInt32BE(20);
    return widthPx > 0 && heightPx > 0 ? { widthPx, heightPx } : undefined;
  } catch {
    return undefined;
  }
}

function renderKittyBlockRows(
  placement: FormulaImagePlacement,
  prefix: string,
): string[] | undefined {
  const rowImages = placement.raster.rowBase64Data;
  const rowImageIds = placement.rowImageIds;
  if (
    !rowImages ||
    !rowImageIds ||
    rowImages.length !== placement.raster.rows ||
    rowImageIds.length !== placement.raster.rows
  ) {
    return undefined;
  }

  const lines: string[] = [];
  for (let row = 0; row < rowImages.length; row++) {
    const base64Data = rowImages[row]!;
    const dimensions = pngPixelDimensions(base64Data);
    if (!dimensions || dimensions.widthPx !== placement.raster.widthPx)
      return undefined;
    const rendered = renderImage(base64Data, dimensions, {
      maxWidthCells: placement.raster.columns,
      maxHeightCells: 1,
      imageId: rowImageIds[row],
      moveCursor: false,
    });
    if (
      !rendered ||
      rendered.columns !== placement.raster.columns ||
      rendered.rows !== 1
    ) {
      return undefined;
    }
    lines.push(`${prefix}${rendered.sequence}`);
  }
  return lines;
}

function encodeWezTermOscImage(
  base64Data: string,
  columns: number,
  rows: number,
): string | undefined {
  const encoded = encodeITerm2(base64Data, {
    inline: true,
    width: columns,
    height: rows,
    preserveAspectRatio: false,
  });
  const payloadStart = encoded.indexOf(":");
  if (payloadStart < 0) return undefined;
  return `${encoded.slice(0, payloadStart)};doNotMoveCursor=1${encoded.slice(payloadStart)}`;
}

// Raw image payloads and cursor-overlay controls can confuse Pi's width and
// compositing helpers when embedded inside a Markdown line. Keep real one-cell
// placeholders through layout, hide image data in a zero-width OSC 8 marker,
// and expand it only in the final ProcessTerminal.write() call.
const OUTPUT_CELL_PLACEHOLDER = String.fromCodePoint(0x10fffd);
const IMAGE_MARKER_NONCE_SYMBOL = Symbol.for(
  "pi.extension.math.image-marker-nonce",
);
const WEZTERM_IMAGE_MARKER_PATTERN =
  /(\u{10fffd}+)\x1b\]8;;math-image:([0-9a-f]{32}):(\d+):(\d+):([A-Za-z0-9+/=]+)\x1b\\\x1b\]8;;\x1b\\/gu;
const WARP_IMAGE_MARKER_PATTERN =
  /(\u{10fffd}+)\x1b\]8;;math-kitty-image:([0-9a-f]{32}):(\d+):(\d+):([A-Za-z0-9+/=]+)\x1b\\\x1b\]8;;\x1b\\/gu;
let terminalOutputPatchActive = false;

function imageMarkerNonce(): string {
  const scope = globalThis as unknown as Record<PropertyKey, unknown>;
  const current = scope[IMAGE_MARKER_NONCE_SYMBOL];
  if (typeof current === "string" && /^[0-9a-f]{32}$/u.test(current))
    return current;
  const nonce = randomBytes(16).toString("hex");
  scope[IMAGE_MARKER_NONCE_SYMBOL] = nonce;
  return nonce;
}

function wezTermOscImagesEnabled(): boolean {
  return terminalOutputPatchActive && wezTermOscImageSupport();
}

function warpKittyImagesEnabled(): boolean {
  return terminalOutputPatchActive && warpKittyImageSupport();
}

function wezTermImageMarker(
  base64Data: string,
  columns: number,
  rows: number,
): string {
  const payload = `\x1b]8;;math-image:${imageMarkerNonce()}:${columns}:${rows}:${base64Data}\x1b\\\x1b]8;;\x1b\\`;
  return `${OUTPUT_CELL_PLACEHOLDER.repeat(columns)}${payload}`;
}

function expandWezTermImageMarkers(output: string): string {
  return output.replace(
    WEZTERM_IMAGE_MARKER_PATTERN,
    (
      marker,
      placeholders: string,
      nonce: string,
      columnsText: string,
      rowsText: string,
      base64Data: string,
    ) => {
      const columns = Number.parseInt(columnsText, 10);
      const rows = Number.parseInt(rowsText, 10);
      if (
        nonce !== imageMarkerNonce() ||
        !Number.isSafeInteger(columns) ||
        !Number.isSafeInteger(rows) ||
        columns < 1 ||
        rows < 1 ||
        [...placeholders].length !== columns
      ) {
        return marker;
      }
      const image = encodeWezTermOscImage(base64Data, columns, rows);
      return image ? `${image}\x1b[${columns}C` : marker;
    },
  );
}

function warpKittyImageMarker(
  base64Data: string,
  imageId: number,
  columns: number,
): string {
  const payload = `\x1b]8;;math-kitty-image:${imageMarkerNonce()}:${columns}:${imageId}:${base64Data}\x1b\\\x1b]8;;\x1b\\`;
  return `${OUTPUT_CELL_PLACEHOLDER.repeat(columns)}${payload}`;
}

function expandWarpKittyImageMarkers(output: string): string {
  return output.replace(
    WARP_IMAGE_MARKER_PATTERN,
    (
      marker,
      placeholders: string,
      nonce: string,
      columnsText: string,
      imageIdText: string,
      base64Data: string,
    ) => {
      const columns = Number.parseInt(columnsText, 10);
      const imageId = Number.parseInt(imageIdText, 10);
      if (
        nonce !== imageMarkerNonce() ||
        !Number.isSafeInteger(columns) ||
        !Number.isSafeInteger(imageId) ||
        columns < 1 ||
        imageId < 1 ||
        imageId > 0xffffff ||
        [...placeholders].length !== columns
      ) {
        return marker;
      }
      const image = encodeKitty(base64Data, {
        columns,
        rows: 1,
        imageId,
        moveCursor: false,
      });
      return renderCellOverlay(image, columns);
    },
  );
}

function expandTerminalImageMarkers(output: string): string {
  return expandWarpKittyImageMarkers(expandWezTermImageMarkers(output));
}

interface OutputPatchController {
  uninstall(): void;
}

type ProcessTerminalWrite = typeof ProcessTerminal.prototype.write;

function installTerminalOutputPatch(): OutputPatchController {
  if (
    typeof ProcessTerminal !== "function" ||
    !ProcessTerminal.prototype ||
    typeof ProcessTerminal.prototype.write !== "function"
  ) {
    throw new Error(
      "Pi ProcessTerminal.write() is unavailable or incompatible",
    );
  }
  const originalWrite = ProcessTerminal.prototype.write as ProcessTerminalWrite;
  let installed = true;
  const patchedWrite: ProcessTerminalWrite = function (
    this: ProcessTerminal,
    output: string,
  ): void {
    originalWrite.call(this, expandTerminalImageMarkers(output));
  };
  ProcessTerminal.prototype.write = patchedWrite;
  terminalOutputPatchActive = true;
  return {
    uninstall() {
      if (installed && ProcessTerminal.prototype.write === patchedWrite) {
        ProcessTerminal.prototype.write = originalWrite;
      }
      installed = false;
      terminalOutputPatchActive = false;
    },
  };
}

function renderCellOverlay(sequence: string, columns: number): string {
  return `${" ".repeat(columns)}\x1b[${columns}D${sequence}\x1b[${columns}C`;
}

function renderBlockPlacement(
  placement: FormulaImagePlacement,
  area: FormulaImageArea,
): string[] | undefined {
  const capabilities = getCapabilities();
  if (!capabilities.images) return undefined;
  const contentWidth = Math.max(1, area.renderWidth - area.paddingX * 2);
  if (placement.raster.columns > contentWidth) return undefined;
  const left =
    area.paddingX +
    Math.max(0, Math.floor((contentWidth - placement.raster.columns) / 2));
  const prefix = " ".repeat(left);

  if (capabilities.images === "kitty" && wezTermOscImagesEnabled()) {
    // Each strip occupies exactly one terminal row, so a later ESC[2K for the
    // next fullscreen row cannot erase any part of an earlier strip.
    const rowImages = placement.raster.rowBase64Data;
    if (!rowImages || rowImages.length !== placement.raster.rows)
      return undefined;
    return rowImages.map((rowImage) => {
      const marker = wezTermImageMarker(rowImage, placement.raster.columns, 1);
      return `${prefix}${marker}`;
    });
  }

  if (capabilities.images === "kitty") {
    // Native Kitty-compatible terminals receive one independent placement per
    // terminal row. No placement intersects a later row-level ESC[2K, even on
    // implementations that erase graphics when text cells are cleared.
    return renderKittyBlockRows(placement, prefix);
  }

  const rendered = renderNativeImage(placement);
  if (!rendered) return undefined;
  const rowOffset = Math.max(0, rendered.rows - 1);
  const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
  return [
    ...Array.from({ length: rowOffset }, () => ""),
    `${prefix}${moveUp}${rendered.sequence}`,
  ];
}

function renderInlinePlacement(
  placement: FormulaImagePlacement,
): string | undefined {
  if (getCapabilities().images !== "kitty" || placement.raster.rows !== 1)
    return undefined;
  if (wezTermOscImagesEnabled()) {
    const marker = wezTermImageMarker(
      placement.raster.base64Data,
      placement.raster.columns,
      1,
    );
    return marker;
  }
  if (warpKittyImagesEnabled()) {
    return warpKittyImageMarker(
      placement.raster.base64Data,
      placement.imageId,
      placement.raster.columns,
    );
  }
  if (kittyPlaceholderSupport()) {
    const virtual = renderKittyVirtualImage(
      placement.raster.base64Data,
      placement.imageId,
      placement.raster.columns,
      1,
    );
    if (virtual) return `${virtual.sequence}${virtual.placeholders[0]}`;
  }
  const rendered = renderNativeImage(placement);
  if (!rendered || rendered.rows !== 1) return undefined;
  return renderCellOverlay(rendered.sequence, placement.raster.columns);
}

function insertFormulaImages(
  lines: string[],
  placements: FormulaImagePlacement[],
  area: FormulaImageArea,
): string[] {
  if (placements.length === 0) return lines;
  const output: string[] = [];
  const blockPlacements = placements.filter(({ inline }) => !inline);
  const inlinePlacements = placements.filter(({ inline }) => inline);
  for (const line of lines) {
    const block = blockPlacements.find(({ marker }) => line.includes(marker));
    if (block) {
      const imageLines = renderBlockPlacement(block, area);
      output.push(
        ...(imageLines ?? [
          line.replace(block.marker, () => block.fallbackText),
        ]),
      );
      continue;
    }
    let renderedLine = line;
    for (const placement of inlinePlacements) {
      if (!renderedLine.includes(placement.marker)) continue;
      const image = renderInlinePlacement(placement) ?? placement.fallbackText;
      renderedLine = renderedLine.replace(placement.marker, () => image);
    }
    output.push(renderedLine);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Reversible Pi Markdown integration
// ---------------------------------------------------------------------------

const MAX_RASTER_HEIGHT_PX = 4096;

type MarkdownInternals = {
  text: string;
  paddingX?: number;
  theme?: { codeBlock?: (text: string) => string };
  options?: Record<string, unknown> & { renderLatex?: boolean };
  invalidate?: () => void;
};

type MarkdownRender = (this: Markdown, width: number) => string[];

interface CachedTransform {
  source: string;
  layoutKey: string;
  transformed: string;
  placements: FormulaImagePlacement[];
}

interface MathPatchController {
  uninstall(): void;
}

function formulaColor(markdown: MarkdownInternals): string {
  const styled = markdown.theme?.codeBlock?.("x") ?? "";
  const trueColor = /\x1b\[38;2;(\d+);(\d+);(\d+)m/u.exec(styled);
  if (!trueColor) return DEFAULT_FORMULA_COLOR;
  return `#${trueColor
    .slice(1, 4)
    .map((component) => Number(component).toString(16).padStart(2, "0"))
    .join("")}`;
}

function imageMarker(index: number, columns: number, inline: boolean): string {
  // A one-cell block marker survives Markdown wrapping even at extremely
  // narrow widths. Inline markers still reserve the raster's exact columns.
  if (!inline) return String.fromCodePoint(0xf0000 + (index % 0xfffe));
  const privateUseCharacter = String.fromCodePoint(0xe000 + (index % 0x1900));
  return privateUseCharacter.repeat(columns);
}

function allocateMathImageId(): number {
  return allocateImageId() & 0xffffff || 1;
}

function installMarkdownMathPatch(
  renderer: TerminalMathRenderer | undefined,
): MathPatchController {
  if (
    typeof Markdown !== "function" ||
    !Markdown.prototype ||
    typeof Markdown.prototype.render !== "function"
  ) {
    throw new Error("Pi Markdown.render() is unavailable or incompatible");
  }

  const originalRender = Markdown.prototype.render as MarkdownRender;
  let installed = true;
  let transformCache = new WeakMap<Markdown, CachedTransform>();
  const preparedForRawLatex = new WeakSet<Markdown>();

  const renderWithRawLatex = (
    component: Markdown,
    markdown: MarkdownInternals,
    width: number,
    temporaryText: string,
  ): string[] => {
    if (!preparedForRawLatex.has(component)) {
      markdown.invalidate?.call(component);
      preparedForRawLatex.add(component);
    }
    const originalText = markdown.text;
    const originalOptions = markdown.options;
    markdown.text = temporaryText;
    markdown.options = { ...(originalOptions ?? {}), renderLatex: false };
    try {
      return originalRender.call(component, width);
    } finally {
      markdown.text = originalText;
      markdown.options = originalOptions;
    }
  };

  const patchedRender: MarkdownRender = function (width: number): string[] {
    const markdown = this as unknown as MarkdownInternals;
    const source = markdown.text;
    if (typeof source !== "string" || !containsPotentialMath(source)) {
      return originalRender.call(this, width);
    }

    try {
      const protocol = getCapabilities().images;
      if (!renderer || !protocol) {
        return renderWithRawLatex(this, markdown, width, source);
      }
      const protectedOutputRequired =
        protocol === "kitty" &&
        (wezTermOscImageSupport() || warpKittyImageSupport());
      if (protectedOutputRequired && !terminalOutputPatchActive) {
        return renderWithRawLatex(this, markdown, width, source);
      }
      const wezTermOsc = protocol === "kitty" && wezTermOscImagesEnabled();
      const warpKitty = protocol === "kitty" && warpKittyImagesEnabled();

      const paddingX =
        typeof markdown.paddingX === "number" &&
        Number.isFinite(markdown.paddingX)
          ? Math.max(0, markdown.paddingX)
          : 0;
      const color = formulaColor(markdown);
      const reportedCells = getCellDimensions();
      const cellWidthPx = Number.isFinite(reportedCells.widthPx)
        ? Math.max(1, reportedCells.widthPx)
        : 9;
      const cellHeightPx = Number.isFinite(reportedCells.heightPx)
        ? Math.max(1, reportedCells.heightPx)
        : 18;
      const contentWidth = Math.max(1, width - paddingX * 2);
      const imageStrategy = wezTermOsc
        ? "wezterm-row-osc"
        : warpKitty
          ? "warp-protected-kitty"
          : protocol === "kitty"
            ? "kitty-row-images"
            : "native-image";
      const layoutKey = [
        width,
        paddingX,
        color,
        protocol,
        imageStrategy,
        cellWidthPx,
        cellHeightPx,
      ].join(":");
      const maxBlockRows = Math.max(
        1,
        Math.floor(MAX_RASTER_HEIGHT_PX / cellHeightPx),
      );

      let transformed: string;
      let placements: FormulaImagePlacement[];
      const cached = transformCache.get(this);
      if (cached?.source === source && cached.layoutKey === layoutKey) {
        ({ transformed, placements } = cached);
      } else {
        placements = [];
        transformed = expandMathInMarkdown(
          source,
          (latex, display, context) => {
            const inline = !display && !context.standalone;
            if (inline && protocol !== "kitty") return undefined;
            const splitRows = protocol === "kitty" && !inline;
            const raster = renderer.render(latex, display, color, {
              maxWidthCells: contentWidth,
              maxHeightCells: inline ? 1 : maxBlockRows,
              cellWidthPx,
              cellHeightPx,
              fitHeight: inline,
              splitRows,
            });
            if (!raster) return undefined;
            const imageId = allocateMathImageId();
            const rowImageIds =
              splitRows && !wezTermOsc
                ? Array.from({ length: raster.rows }, (_, row) =>
                    row === 0 ? imageId : allocateMathImageId(),
                  )
                : undefined;
            const marker = imageMarker(
              placements.length,
              raster.columns,
              inline,
            );
            placements.push({
              marker,
              imageId,
              ...(rowImageIds ? { rowImageIds } : {}),
              raster,
              inline,
              fallbackText: source.slice(context.start, context.end),
            });
            return { text: marker, forceBlock: !inline, rawInline: inline };
          },
        );
        transformCache.set(this, {
          source,
          layoutKey,
          transformed,
          placements,
        });
      }

      if (transformed === source || placements.length === 0) {
        return renderWithRawLatex(this, markdown, width, source);
      }
      const textLines = stripGeneratedMathFenceLines(
        renderWithRawLatex(this, markdown, width, transformed),
      );
      return insertFormulaImages(textLines, placements, {
        renderWidth: width,
        paddingX,
      });
    } catch {
      return renderWithRawLatex(this, markdown, width, source);
    }
  };

  Markdown.prototype.render = patchedRender;
  return {
    uninstall() {
      transformCache = new WeakMap();
      if (installed && Markdown.prototype.render === patchedRender) {
        Markdown.prototype.render = originalRender;
      }
      installed = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

export default async function mathExtension(pi: ExtensionAPI): Promise<void> {
  let renderer: TerminalMathRenderer | undefined;
  let loadFailure: string | undefined;
  try {
    renderer = await createTerminalMathRenderer(loadRendererConfiguration());
  } catch (error) {
    loadFailure = errorMessage(error);
  }

  let patch: MathPatchController | undefined;
  let outputPatch: OutputPatchController | undefined;
  let failureNotified = false;

  pi.on("session_start", (_event, context) => {
    if (context.mode !== "tui") return;
    let patchFailure: string | undefined;
    const needsOutputPatch =
      getCapabilities().images === "kitty" &&
      (wezTermOscImageSupport() || warpKittyImageSupport());
    if (needsOutputPatch && !outputPatch) {
      try {
        outputPatch = installTerminalOutputPatch();
      } catch (error) {
        patchFailure = `terminal image output integration: ${errorMessage(error)}`;
      }
    }
    if (!patch && !patchFailure) {
      try {
        // Even when renderer initialization failed, install the fallback-only
        // wrapper so Pi's built-in Unicode renderer does not alter raw LaTeX.
        patch = installMarkdownMathPatch(renderer);
      } catch (error) {
        patchFailure = `Markdown integration: ${errorMessage(error)}`;
      }
    }
    if (failureNotified) return;
    if (patchFailure) {
      context.ui.notify(`math failed to install ${patchFailure}`, "error");
      failureNotified = true;
      return;
    }
    if (loadFailure) {
      context.ui.notify(
        `math renderer is unavailable; using raw LaTeX: ${loadFailure}`,
        "warning",
      );
      failureNotified = true;
    }
  });

  pi.on("session_shutdown", () => {
    patch?.uninstall();
    patch = undefined;
    outputPatch?.uninstall();
    outputPatch = undefined;
    renderer?.clear();
  });
}
