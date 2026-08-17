import { build } from "esbuild";

await build({
  entryPoints: ["mathjax-entry.mjs"],
  outfile: "../vendor/mathjax.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  packages: "bundle",
  sourcemap: false,
  legalComments: "inline",
  logLevel: "info",
});
