import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");

function fail(message) {
  console.error(`Build verification failed: ${message}`);
  process.exit(1);
}

function filesRecursively(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(path) : [path];
  });
}

function requireFile(path, minimumBytes = 1) {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    fail(`missing ${path.replace(`${root}/`, "")}`);
  }
  if (size < minimumBytes) fail(`${path.replace(`${root}/`, "")} is unexpectedly small (${size} bytes)`);
  return size;
}

const indexPath = join(dist, "index.html");
requireFile(indexPath, 100);
const indexHtml = readFileSync(indexPath, "utf8");
if (!indexHtml.includes('type="module"')) fail("index.html has no module script");
if (/https?:\/\/(localhost|127\.0\.0\.1)/i.test(indexHtml)) fail("index.html contains a localhost URL");

const referencedAssets = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((value) => value.startsWith("/") && !value.startsWith("//"));
for (const asset of referencedAssets) {
  const clean = asset.split(/[?#]/, 1)[0].replace(/^\//, "");
  requireFile(join(dist, clean));
}

const wasmLoaderPath = join(dist, "wasm", "piano_core.js");
const wasmBinaryPath = join(dist, "wasm", "piano_core_bg.wasm");
requireFile(wasmLoaderPath, 500);
requireFile(wasmBinaryPath, 1_000);

const loader = readFileSync(wasmLoaderPath, "utf8");
for (const exportName of [
  "analyze_audio_onsets",
  "analyze_color_columns",
  "measure_key_glow",
  "wasm_engine_version",
]) {
  if (!loader.includes(exportName)) fail(`WASM loader does not expose ${exportName}`);
}

const wasmBytes = readFileSync(wasmBinaryPath);
if (wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61 || wasmBytes[2] !== 0x73 || wasmBytes[3] !== 0x6d) {
  fail("WASM binary has an invalid magic header");
}
let wasmModule;
try {
  wasmModule = new WebAssembly.Module(wasmBytes);
} catch (error) {
  fail(`WASM binary cannot be compiled: ${error instanceof Error ? error.message : String(error)}`);
}
const wasmExports = new Set(WebAssembly.Module.exports(wasmModule).map((entry) => entry.name));
for (const exportName of [
  "analyze_audio_onsets",
  "analyze_color_columns",
  "measure_key_glow",
  "wasm_engine_version",
]) {
  if (!wasmExports.has(exportName)) fail(`WASM binary is missing export ${exportName}`);
}

const allFiles = filesRecursively(dist);
const javascript = allFiles.filter((path) => extname(path) === ".js");
const stylesheets = allFiles.filter((path) => extname(path) === ".css");
if (javascript.length < 3) fail(`expected main bundle and two Worker bundles, found ${javascript.length} JavaScript files`);
if (!stylesheets.length) fail("no stylesheet was emitted");
for (const path of allFiles) requireFile(path);
if (allFiles.some((path) => path.endsWith(".map"))) fail("production source maps must not be deployed");

console.log(JSON.stringify({
  ok: true,
  files: allFiles.length,
  javascriptBundles: javascript.length,
  stylesheets: stylesheets.length,
  wasmBytes: wasmBytes.byteLength,
  wasmExports: [...wasmExports].sort(),
}, null, 2));
