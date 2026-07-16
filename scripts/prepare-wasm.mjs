import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = join(root, "wasm", "prebuilt");
const output = join(root, "public", "wasm", "piano_core_bg.wasm");
const expectedSha256 = "59e840c7ec834c339d81307c78af3307e24e0f7dd0cbb15d4db64cb272e9224c";

if (existsSync(output)) {
  console.log("Rust/WASM binary is already materialized.");
  process.exit(0);
}

const parts = readdirSync(sourceDirectory)
  .filter((name) => name.startsWith("piano_core_bg.wasm.b64."))
  .sort();
if (!parts.length) throw new Error("No prebuilt WASM base64 parts were found.");
const encoded = parts
  .map((name) => readFileSync(join(sourceDirectory, name), "utf8"))
  .join("")
  .replace(/\s+/g, "");
const binary = Buffer.from(encoded, "base64");
const actualSha256 = createHash("sha256").update(binary).digest("hex");
if (actualSha256 !== expectedSha256) {
  throw new Error(`Prebuilt WASM checksum mismatch: ${actualSha256}`);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, binary);
console.log(`Materialized Rust/WASM binary (${binary.byteLength} bytes).`);
