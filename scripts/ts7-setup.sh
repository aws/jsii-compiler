#!/usr/bin/env bash
#
# ts7-setup.sh — provision the experimental TypeScript 7 (tsgo) toolchain used by
# the JSII_COMPILER_BACKEND=ts7 backend.
#
# It produces two artifacts under .ts7/ (gitignored):
#   .ts7/tsgo                     — the tsgo native binary
#   .ts7/native-preview/          — the built @typescript/native-preview client
#                                   (exposes dist/api/sync/api.js, dist/ast/index.js)
#
# The toolchain is built from microsoft/typescript-go by default, pinned to the
# final commit of that staging repo (it was closed in August 2026 when the
# TypeScript 7 native port moved back into microsoft/TypeScript; the pin
# contains every API the backend requires, including
# checker.getFullyQualifiedName and the whole-project emit). A fork ref with a
# not-yet-upstreamed batched symbol-documentation API can be used instead as a
# faster option.
#
# When S3_CACHE is set, a previously built toolchain tarball is downloaded from
# there instead of building, and fresh builds are uploaded for reuse.
#
# Requirements to BUILD from source (not needed when the S3 cache hits):
#   - go >= 1.24
#   - node/npm (already present for jsii-compiler itself)
#   - git
#
# Environment overrides:
#   TSGO_REPO    git URL of the typescript-go repository to build. Defaults to
#                upstream microsoft/typescript-go, which the backend fully
#                supports. A fork carrying the (not yet upstreamed) batched
#                symbol-documentation API can be used instead as an optional
#                fast path; without it the backend transparently falls back to
#                per-symbol documentation requests (same output, more RPCs).
#   TSGO_REF     branch/commit to build
#   S3_CACHE     optional. When set, the script downloads a previously built
#                toolchain tarball from this s3:// prefix instead of building,
#                and uploads fresh builds there for reuse. Requires the aws CLI.
#   FORCE_BUILD  set to 1 to ignore the S3 cache and rebuild
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS7_DIR="${REPO_ROOT}/.ts7"

TSGO_REPO="${TSGO_REPO:-https://github.com/microsoft/typescript-go.git}"
# Last real commit of the typescript-go staging repo (see header note).
TSGO_REF="${TSGO_REF:-16c25522e1230b69b11210cfad066d779e6319ba}"
# Optional S3 prefix for the toolchain build cache (e.g. s3://my-bucket/prefix).
# When unset, the toolchain is always built from source and never uploaded.
S3_CACHE="${S3_CACHE:-}"
FORCE_BUILD="${FORCE_BUILD:-0}"

log() { printf '\033[36m[ts7-setup]\033[0m %s\n' "$*" >&2; }

# Resolve the exact commit so the cache key is content-addressed.
log "resolving ${TSGO_REPO} @ ${TSGO_REF} ..."
COMMIT="$(git ls-remote "${TSGO_REPO}" "${TSGO_REF}" | awk '{print $1}' | head -n1)"
if [ -z "${COMMIT}" ]; then
  # TSGO_REF may already be a full commit sha
  COMMIT="${TSGO_REF}"
fi
SHORT="${COMMIT:0:12}"
CACHE_KEY="${S3_CACHE}/ts7-toolchain-${SHORT}.tar.gz"
log "toolchain commit=${SHORT}"
if [ -n "${S3_CACHE}" ]; then log "cache key=${CACHE_KEY}"; fi

# Fast path: already provisioned locally for this commit (skipped when FORCE_BUILD=1).
STAMP="${TS7_DIR}/.commit"
if [ "${FORCE_BUILD}" != "1" ] && [ -f "${TS7_DIR}/tsgo" ] && [ -f "${TS7_DIR}/native-preview/dist/api/sync/api.js" ] \
   && [ "$(cat "${STAMP}" 2>/dev/null || true)" = "${COMMIT}" ]; then
  log "toolchain already present for ${SHORT}; nothing to do"
  echo "${TS7_DIR}"
  exit 0
fi

rm -rf "${TS7_DIR}"
mkdir -p "${TS7_DIR}"

# Try the S3 cache unless a rebuild was explicitly requested.
if [ -n "${S3_CACHE}" ] && [ "${FORCE_BUILD}" != "1" ] && aws s3 ls "${CACHE_KEY}" >/dev/null 2>&1; then
  log "cache hit — downloading prebuilt toolchain"
  aws s3 cp "${CACHE_KEY}" "${TS7_DIR}/toolchain.tar.gz"
  tar -xzf "${TS7_DIR}/toolchain.tar.gz" -C "${TS7_DIR}"
  rm -f "${TS7_DIR}/toolchain.tar.gz"
  echo "${COMMIT}" > "${STAMP}"
  log "toolchain ready (from cache): ${TS7_DIR}"
  echo "${TS7_DIR}"
  exit 0
fi

log "cache miss — building toolchain from source (this takes a few minutes)"
command -v go >/dev/null 2>&1 || { log "ERROR: go is required to build tsgo"; exit 1; }
log "go version: $(go version)"

BUILD_DIR="${TS7_DIR}/src-typescript-go"
# TSGO_REF may be a branch/tag (fast shallow path) or a commit sha (full clone
# + detached checkout). The checkout fails hard when the ref cannot be
# materialized: silently building a different ref would produce a toolchain
# whose API surface does not match what this backend expects.
if git clone --depth 1 --branch "${TSGO_REF}" "${TSGO_REPO}" "${BUILD_DIR}" 2>/dev/null; then
  :
else
  rm -rf "${BUILD_DIR}"
  git clone "${TSGO_REPO}" "${BUILD_DIR}"
  ( cd "${BUILD_DIR}" && git checkout --detach "${COMMIT}" )
fi
ACTUAL="$(cd "${BUILD_DIR}" && git rev-parse HEAD)"
if [ "${ACTUAL}" != "${COMMIT}" ]; then
  log "ERROR: checked-out commit ${ACTUAL} != requested ${COMMIT}"
  exit 1
fi

# 1) build the patched tsgo binary
log "building tsgo (go build) ..."
( cd "${BUILD_DIR}" && go build -o built/local/tsgo ./cmd/tsgo )
cp "${BUILD_DIR}/built/local/tsgo" "${TS7_DIR}/tsgo"
chmod +x "${TS7_DIR}/tsgo"

# 2) build the native-preview client package
log "building @typescript/native-preview client (npm ci && npm run build) ..."
( cd "${BUILD_DIR}" && npm ci )
( cd "${BUILD_DIR}/_packages/native-preview" && npm run build )
mkdir -p "${TS7_DIR}/native-preview"
# Copy the built package as the package.json "files" field declares (bin/lib/dist/vendor),
# plus package.json itself. dist/api/options.js imports ../../lib/getExePath.js at runtime,
# so lib/ (generated during build) must be included alongside dist/.
NP_SRC="${BUILD_DIR}/_packages/native-preview"
cp "${NP_SRC}/package.json" "${TS7_DIR}/native-preview/package.json"
for d in dist lib bin vendor; do
  if [ -e "${NP_SRC}/${d}" ]; then
    cp -R "${NP_SRC}/${d}" "${TS7_DIR}/native-preview/${d}"
  fi
done

# Sanity check: the built client must expose the APIs the backend requires
# (checker.getFullyQualifiedName is present on upstream main and any usable
# fork ref); a build from a too-old ref is useless for jsii.
if ! grep -q 'getFullyQualifiedName' "${TS7_DIR}/native-preview/dist/api/sync/api.js"; then
  log "ERROR: built native-preview client lacks checker.getFullyQualifiedName — ref too old?"
  exit 1
fi

echo "${COMMIT}" > "${STAMP}"

# 3) upload to the S3 cache for the next run
if [ -n "${S3_CACHE}" ]; then
  log "packaging toolchain for cache upload ..."
  tar -czf "${TS7_DIR}/toolchain.tar.gz" -C "${TS7_DIR}" tsgo native-preview .commit
  if aws s3 cp "${TS7_DIR}/toolchain.tar.gz" "${CACHE_KEY}"; then
    log "uploaded toolchain cache to ${CACHE_KEY}"
  else
    log "WARN: failed to upload cache (continuing anyway)"
  fi
  rm -f "${TS7_DIR}/toolchain.tar.gz"
fi
rm -rf "${BUILD_DIR}"

log "toolchain ready (built): ${TS7_DIR}"
echo "${TS7_DIR}"
