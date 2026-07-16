import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "wasm", "piano-core");
const output = join(root, "public", "wasm");
const generated = [
  join(output, "piano_core.js"),
  join(output, "piano_core_bg.wasm"),
];

const wasmPack = spawnSync("wasm-pack", ["--version"], { stdio: "ignore" });
if (wasmPack.status !== 0) {
  if (generated.every(existsSync)) {
    console.log("wasm-pack was not found; reusing the existing Rust/WASM build.");
  } else {
    console.warn(
      "wasm-pack was not found. Building the app without WASM; audio analysis will use the TypeScript Web Worker fallback.",
    );
  }
  process.exit(0);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const result = spawnSync(
  "wasm-pack",
  [
    "build",
    crate,
    "--target",
    "web",
    "--out-dir",
    output,
    "--out-name",
    "piano_core",
    "--release",
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const generatedIgnore = join(output, ".gitignore");
if (existsSync(generatedIgnore)) unlinkSync(generatedIgnore);
console.log("Rust/WASM core built in public/wasm.");
