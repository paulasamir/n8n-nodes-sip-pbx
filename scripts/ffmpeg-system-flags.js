#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const FFMPEG_PKG_LIST = ["libavformat", "libavcodec", "libswresample", "libavutil"];
const VENDOR_PKG_LIST = [...FFMPEG_PKG_LIST, "libmp3lame", "opus"];

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function resolveOptionalPath(raw) {
  const value = String(raw || "").trim();
  return value ? path.resolve(value) : "";
}

function splitFlags(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeLibraryFlags(tokens) {
  const normalized = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-framework" && index + 1 < tokens.length) {
      normalized.push(`-Wl,-framework,${tokens[index + 1]}`);
      index += 1;
      continue;
    }
    normalized.push(token);
  }
  return normalized;
}

function detectRuntimeLibc() {
  if (process.platform !== "linux") {
    return "";
  }
  try {
    const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
    const glibcVersionRuntime = report && report.header && typeof report.header.glibcVersionRuntime === "string"
      ? report.header.glibcVersionRuntime.trim()
      : "";
    return glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    return "musl";
  }
}

function detectVendorBuildRoot() {
  const explicit = resolveOptionalPath(process.env.FFAUDIO_BUILD_ROOT);
  if (explicit) return explicit;
  const repoRoot = path.resolve(__dirname, "..");
  const libc =
    process.platform === "linux"
      ? (String(process.env.LIBC || "").trim().toLowerCase() || detectRuntimeLibc())
      : "";
  const tuple = `${process.platform}-${process.arch}${libc ? `-${libc}` : ""}`;
  const candidate = path.join(repoRoot, "build-ffaudio", tuple);
  return fs.existsSync(candidate) ? candidate : "";
}

function detectVendorConfig() {
  const buildRoot = detectVendorBuildRoot();
  const prefix = resolveOptionalPath(process.env.FFAUDIO_VENDOR_PREFIX || process.env.FFAUDIO_PREFIX)
    || (buildRoot ? path.join(buildRoot, "prefix") : "");
  const ffmpegInstallDir = resolveOptionalPath(process.env.FFAUDIO_FFMPEG_INSTALL_DIR)
    || (buildRoot ? path.join(buildRoot, "ffmpeg-install") : "");
  if (!prefix || !ffmpegInstallDir) return null;
  if (!fs.existsSync(prefix) || !fs.existsSync(ffmpegInstallDir)) return null;
  const pkgConfigDirs = unique([
    path.join(ffmpegInstallDir, "lib", "pkgconfig"),
    path.join(prefix, "lib", "pkgconfig"),
  ]).filter((entry) => fs.existsSync(entry));
  return {
    buildRoot,
    prefix,
    ffmpegInstallDir,
    pkgConfigDirs,
  };
}

function detectPrefix() {
  if (process.env.FFMPEG_PREFIX) return String(process.env.FFMPEG_PREFIX || "").trim();
  return "";
}

function mode() {
  return String(process.argv[2] || "json").trim().toLowerCase();
}

const includeDirs = [];
const libraryFiles = [];
const vendor = detectVendorConfig();

function runVendorPkgConfig(args) {
  if (!vendor || !vendor.pkgConfigDirs.length) return "";
  const env = {
    ...process.env,
    FFAUDIO_PKGCONFIG_DIR: vendor.pkgConfigDirs.join(path.delimiter),
  };
  return cp.execFileSync(
    process.execPath,
    [path.join(__dirname, "ffaudio-pkg-config.js"), ...args],
    {
      encoding: "utf8",
      env,
    }
  ).trim();
}

if (vendor) {
  includeDirs.push(path.join(vendor.ffmpegInstallDir, "include"));
  includeDirs.push(path.join(vendor.prefix, "include"));
  try {
    for (const flag of splitFlags(runVendorPkgConfig(["--cflags-only-I", ...VENDOR_PKG_LIST]))) {
      if (flag.startsWith("-I")) includeDirs.push(flag.slice(2));
    }
  } catch {}
  try {
    libraryFiles.push(...normalizeLibraryFlags(splitFlags(runVendorPkgConfig(["--libs", "--static", ...VENDOR_PKG_LIST]))));
  } catch {}
} else {
  const prefix = detectPrefix();
  if (prefix) {
    includeDirs.push(path.join(prefix, "include"));
    const libDir = path.join(prefix, "lib");
    const candidates = ["libavcodec", "libavformat", "libavutil", "libswresample"];
    for (const name of candidates) {
      const dylib = path.join(libDir, `${name}.dylib`);
      const so = path.join(libDir, `${name}.so`);
      const a = path.join(libDir, `${name}.a`);
      if (fs.existsSync(dylib)) {
        libraryFiles.push(dylib);
      } else if (fs.existsSync(so)) {
        libraryFiles.push(so);
      } else if (fs.existsSync(a)) {
        libraryFiles.push(a);
      }
    }
  } else {
    try {
      includeDirs.push(
        ...splitFlags(cp.execFileSync("pkg-config", ["--cflags-only-I", ...FFMPEG_PKG_LIST], { encoding: "utf8" }))
          .filter((flag) => flag.startsWith("-I"))
          .map((flag) => flag.slice(2))
      );
      libraryFiles.push(...normalizeLibraryFlags(splitFlags(cp.execFileSync("pkg-config", ["--libs", ...FFMPEG_PKG_LIST], { encoding: "utf8" }))));
    } catch {}
  }
}

if (process.platform === "linux") {
  includeDirs.push("/usr/include");
  includeDirs.push("/usr/include/x86_64-linux-gnu");
  includeDirs.push("/usr/include/aarch64-linux-gnu");
  includeDirs.push("/usr/local/include");
}

if (mode() === "include-dirs") {
  process.stdout.write(`${unique(includeDirs).join("\n")}\n`);
} else if (mode() === "library-files") {
  process.stdout.write(`${unique(libraryFiles).join("\n")}\n`);
} else if (mode() === "json") {
  process.stdout.write(`${JSON.stringify({
    vendor,
    prefix: vendor ? "" : detectPrefix(),
    includeDirs: unique(includeDirs),
    libraryFiles: unique(libraryFiles),
  }, null, 2)}\n`);
} else {
  throw new Error(`Unsupported mode: ${mode()}`);
}
