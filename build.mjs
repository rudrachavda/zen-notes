import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["extension/src/note.js", "extension/src/popup.js", "extension/src/library.js"],
  outdir: "extension/dist",
  bundle: true,
  format: "iife",
  target: "firefox115",
  minify: process.argv.includes("--minify"),
  loader: { ".woff": "file", ".woff2": "file" },
  assetNames: "fonts/[name]",
  logLevel: "info",
});
