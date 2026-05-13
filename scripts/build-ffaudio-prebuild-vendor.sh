#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

read_arg() {
  local name="$1"
  local fallback="${2:-}"
  local prefix="--${name}="
  for arg in "$@"; do
    if [[ "$arg" == "$prefix"* ]]; then
      printf '%s' "${arg#"$prefix"}"
      return 0
    fi
  done
  printf '%s' "$fallback"
}

PLATFORM="$(read_arg platform "${OSTYPE:-unknown}" "$@")"
ARCH="$(read_arg arch "$(uname -m)" "$@")"
LIBC="$(read_arg libc "" "$@")"
BUILD_ROOT="$(read_arg build-root "${REPO_ROOT}/build-ffaudio/${PLATFORM}-${ARCH}${LIBC:+-${LIBC}}" "$@")"
SKIP_VENDOR="$(read_arg skip-vendor false "$@")"
JOBS="$(read_arg jobs "" "$@")"
RELEASE="$(read_arg release true "$@")"

if [[ "${PLATFORM}" != "linux" ]]; then
  echo "[ffaudio] unsupported prebuild platform ${PLATFORM}; published native prebuilds are Linux-only" >&2
  exit 1
fi

if [[ "${LIBC}" != "glibc" && "${LIBC}" != "musl" ]]; then
  echo "[ffaudio] unsupported Linux libc ${LIBC}; expected glibc or musl" >&2
  exit 1
fi

FFMPEG_INSTALL_DIR="${BUILD_ROOT}/ffmpeg-install"
FFMPEG_PKGCONFIG_DIR="${FFMPEG_INSTALL_DIR}/lib/pkgconfig"
PREFIX_DIR="${BUILD_ROOT}/prefix"
STAGING_DIR="${BUILD_ROOT}/addon-staging"

if [[ -z "$JOBS" ]]; then
  if command -v nproc >/dev/null 2>&1; then
    JOBS="$(nproc)"
  else
    JOBS="$(sysctl -n hw.ncpu 2>/dev/null || printf '4')"
  fi
fi

prepare_staging_workspace() {
  rm -rf "${STAGING_DIR}"
  mkdir -p "${STAGING_DIR}"
  ln -s "${REPO_ROOT}/binding.gyp" "${STAGING_DIR}/binding.gyp"
  ln -s "${REPO_ROOT}/native" "${STAGING_DIR}/native"
  ln -s "${REPO_ROOT}/vendor" "${STAGING_DIR}/vendor"
  ln -s "${REPO_ROOT}/scripts" "${STAGING_DIR}/scripts"
  ln -s "${REPO_ROOT}/node_modules" "${STAGING_DIR}/node_modules"
}

PREBUILD_ARGS=(
  "--source-file=${STAGING_DIR}/build/Release/native.node"
  "--platform=${PLATFORM}"
  "--arch=${ARCH}"
)
if [[ -n "${LIBC}" ]]; then
  PREBUILD_ARGS+=("--libc=${LIBC}")
fi

echo "[ffaudio] building vendored FFmpeg stack and native prebuild for ${PLATFORM}-${ARCH}${LIBC:+-${LIBC}}"

if [[ "${SKIP_VENDOR}" == "true" ]]; then
  if [[ ! -d "${FFMPEG_PKGCONFIG_DIR}" ]]; then
    echo "[ffaudio] existing vendor root not found at ${FFMPEG_PKGCONFIG_DIR}" >&2
    exit 1
  fi
  if [[ ! -d "${PREFIX_DIR}" ]]; then
    echo "[ffaudio] existing prefix root not found at ${PREFIX_DIR}" >&2
    exit 1
  fi
  echo "[ffaudio] reusing existing vendor build root ${BUILD_ROOT}"
else
  bash "${REPO_ROOT}/scripts/build-ffaudio-vendor.sh" "$@"
fi

prepare_staging_workspace

(
  cd "${STAGING_DIR}"
  FFAUDIO_BUILD_ROOT="${BUILD_ROOT}" "${REPO_ROOT}/node_modules/.bin/node-gyp" configure
  make -C build BUILDTYPE=Release -j"${JOBS}" native
  node "${REPO_ROOT}/scripts/write-prebuild.js" "--release=${RELEASE}" "${PREBUILD_ARGS[@]}"
)

echo "{\"ok\":true,\"buildRoot\":\"${BUILD_ROOT}\",\"platform\":\"${PLATFORM}\",\"arch\":\"${ARCH}\",\"libc\":\"${LIBC}\",\"release\":\"${RELEASE}\"}"
