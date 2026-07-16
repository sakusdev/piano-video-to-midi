#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.cargo/bin:${PATH}"

if ! command -v rustup >/dev/null 2>&1; then
  echo "Installing the minimal Rust toolchain for the Cloudflare build..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi

rustup target add wasm32-unknown-unknown

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "Installing wasm-pack for the Cloudflare build..."
  curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi

rustc --version
wasm-pack --version
npm run build
