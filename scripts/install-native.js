#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const packageRoot = path.join(__dirname, "..");
const expectedExports = ["MediaStream", "G722Encoder", "G722Decoder", "G729Encoder", "G729Decoder", "OpusEncoder", "OpusDecoder"];

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

function resolveBundledNativeAddonPath(dir) {
  const previousLibc = process.env.LIBC;
  if (!previousLibc) {
    const detectedLibc = detectRuntimeLibc();
    if (detectedLibc) {
      process.env.LIBC = detectedLibc;
    }
  }
  try {
    const loadNativeAddon = require("node-gyp-build");
    const resolvedPath = loadNativeAddon.path(dir);
    const relativePath = path.relative(dir, resolvedPath);
    const firstSegment = relativePath.split(path.sep, 1)[0] || "";
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      firstSegment !== "prebuilds"
    ) {
      throw new Error(`Native addon must resolve to a bundled prebuild, got ${resolvedPath}`);
    }
    return resolvedPath;
  } finally {
    if (!previousLibc) {
      delete process.env.LIBC;
    }
  }
}

function loadBundledNativeAddon(dir) {
  cleanupLocalBuildArtifacts(dir);
  return require(resolveBundledNativeAddonPath(dir));
}

function cleanupLocalBuildArtifacts(dir = packageRoot) {
  for (const target of ["build/Release", "build/Debug"]) {
    try {
      fs.rmSync(path.join(dir, target), { recursive: true, force: true });
    } catch {}
  }
}

function verifyBundledNativeAddon(dir = packageRoot) {
  const addon = loadBundledNativeAddon(dir);
  if (Number(addon && addon.ffaudioAbiVersion || 0) !== 3) {
    throw new Error("Native addon ABI mismatch: expected ffaudioAbiVersion=3");
  }
  for (const exportName of expectedExports) {
    if (typeof addon[exportName] !== "function") {
      throw new Error(`Native addon is missing export ${exportName}`);
    }
  }
  return addon;
}

function main() {
  cleanupLocalBuildArtifacts(packageRoot);

  try {
    verifyBundledNativeAddon(packageRoot);
    cleanupLocalBuildArtifacts(packageRoot);
    process.exit(0);
  } catch (error) {
    cleanupLocalBuildArtifacts(packageRoot);
    console.error(`[n8n-nodes-sip-pbx] Native installation failed for ${process.platform}-${process.arch}. Missing bundled native prebuild.`);
    if (error && error.message) {
      console.error(`[n8n-nodes-sip-pbx] ${error.message}`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadBundledNativeAddon,
};
