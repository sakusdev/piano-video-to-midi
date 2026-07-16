import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "wasm", "prebuilt", "piano_core_bg.wasm.b64");
const output = join(root, "public", "wasm", "piano_core_bg.wasm");
const expectedSha256 = "59e840c7ec834c339d81307c78af3307e24e0f7dd0cbb15d4db64cb272e9224c";

if (existsSync(output)) {
  console.log("Rust/WASM binary is already materialized.");
  process.exit(0);
}

const encoded = readFileSync(source, "utf8").replace(/\s+/g, "");
const binary = Buffer.from(encoded, "base64");
const actualSha256 = createHash("sha256").update(binary).digest("hex");
if (actualSha256 !== expectedSha256) {
  throw new Error(`Prebuilt WASM checksum mismatch: ${actualSha256}`);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, binary);
console.log(`Materialized Rust/WASM binary (${binary.byteLength} bytes).`);
