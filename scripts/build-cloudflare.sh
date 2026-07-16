#!/usr/bin/env bash
set -Eeuo pipefail

readonly RUST_TOOLCHAIN="${RUST_TOOLCHAIN:-1.88.0}"
readonly WASM_PACK_VERSION="${WASM_PACK_VERSION:-0.13.1}"
export PATH="${HOME}/.cargo/bin:${PATH}"
export CARGO_NET_RETRY="${CARGO_NET_RETRY:-5}"
export CARGO_HTTP_TIMEOUT="${CARGO_HTTP_TIMEOUT:-120}"

retry() {
  local attempt=1
  local maximum=4
  until "$@"; do
    if (( attempt >= maximum )); then
      echo "Command failed after ${attempt} attempts: $*" >&2
      return 1
    fi
    sleep $((attempt * 3))
    attempt=$((attempt + 1))
  done
}

if ! command -v rustup >/dev/null 2>&1; then
  echo "Installing rustup for the Cloudflare build..."
  installer="$(mktemp)"
  trap 'rm -f "${installer:-}"' EXIT
  retry curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    --location --retry 5 --retry-all-errors --connect-timeout 15 --max-time 120 \
    https://sh.rustup.rs --output "${installer}"
  sh "${installer}" -y --profile minimal --default-toolchain none
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi

retry rustup toolchain install "${RUST_TOOLCHAIN}" --profile minimal --no-self-update
retry rustup target add --toolchain "${RUST_TOOLCHAIN}" wasm32-unknown-unknown
export RUSTUP_TOOLCHAIN="${RUST_TOOLCHAIN}"

installed_wasm_pack=""
if command -v wasm-pack >/dev/null 2>&1; then
  installed_wasm_pack="$(wasm-pack --version | awk '{print $2}')"
fi
if [[ "${installed_wasm_pack}" != "${WASM_PACK_VERSION}" ]]; then
  echo "Installing wasm-pack ${WASM_PACK_VERSION} for the Cloudflare build..."
  retry cargo install wasm-pack --version "${WASM_PACK_VERSION}" --locked --force
fi

rustc --version
wasm-pack --version
npm run build
