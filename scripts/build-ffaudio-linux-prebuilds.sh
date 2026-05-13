#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_tuple() {
  local platform="$1"
  local arch="$2"
  local libc="$3"
  local image="$4"
  local install_cmd="$5"
  local tuple="${platform}-${arch}-${libc}"
  local build_root="/work/build-ffaudio/${tuple}"
  local docker_arch="${arch}"
  local host_build_root="${REPO_ROOT}/build-ffaudio/${tuple}"
  local reuse_vendor="false"

  if [[ "${arch}" == "x64" ]]; then
    docker_arch="amd64"
  fi

  if [[ -f "${host_build_root}/ffaudio-profile.json" ]] \
    && [[ -d "${host_build_root}/prefix/lib/pkgconfig" ]] \
    && [[ -d "${host_build_root}/ffmpeg-install/lib/pkgconfig" ]]; then
    reuse_vendor="true"
  fi

  if [[ "${reuse_vendor}" != "true" ]]; then
    echo "[ffaudio-matrix] vendor ${tuple}"
    docker run --rm --platform "${platform}/${docker_arch}" \
      -v "${REPO_ROOT}":/work \
      -w /work \
      "${image}" \
      sh -lc "${install_cmd} >/dev/null && npm run ffaudio:build:vendor -- --platform=${platform} --arch=${arch} --libc=${libc} --build-root=${build_root}"
  else
    echo "[ffaudio-matrix] vendor ${tuple} (reuse)"
  fi

  echo "[ffaudio-matrix] prebuild ${tuple}"
  docker run --rm --platform "${platform}/${docker_arch}" \
    -v "${REPO_ROOT}":/work \
    -w /work \
    "${image}" \
    sh -lc "${install_cmd} >/dev/null && npm run ffaudio:build:prebuild:vendor -- --platform=${platform} --arch=${arch} --libc=${libc} --build-root=${build_root} --skip-vendor=true"
}

run_tuple "linux" "x64" "glibc" "node:22-bookworm" "apt-get update && apt-get install -y bash build-essential cmake perl pkg-config autoconf automake libtool nasm python3"
run_tuple "linux" "x64" "musl" "node:22-alpine" "apk add --no-cache bash build-base cmake perl pkgconf autoconf automake libtool nasm python3"
run_tuple "linux" "arm64" "glibc" "node:22-bookworm" "apt-get update && apt-get install -y bash build-essential cmake perl pkg-config autoconf automake libtool nasm python3"
run_tuple "linux" "arm64" "musl" "node:22-alpine" "apk add --no-cache bash build-base cmake perl pkgconf autoconf automake libtool nasm python3"
