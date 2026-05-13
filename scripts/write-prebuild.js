#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function readArg(name, fallbackValue = "") {
  const prefix = `--${name}=`;
  const raw = process.argv.find((value) => String(value || "").startsWith(prefix));
  if (!raw) return fallbackValue;
  return String(raw.slice(prefix.length) || "").trim() || fallbackValue;
}

function readBooleanArg(name, fallbackValue = false) {
  const raw = String(readArg(name, fallbackValue ? "true" : "false")).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function stripNativeBinary(filePath) {
  const result = spawnSync("strip", ["--strip-unneeded", filePath], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to strip native prebuild ${filePath}`);
  }
}

const repoRoot = path.resolve(__dirname, "..");
const platform = readArg("platform", process.platform);
const arch = readArg("arch", process.arch);
const libc = readArg("libc", platform === "linux" ? "glibc" : "");
const releaseBuild = readBooleanArg("release", process.env.SIP_PBX_RELEASE_BUILD === "1");
if (platform !== "linux") {
  throw new Error(`Unsupported prebuild platform ${platform}. Published prebuilds are Linux-only.`);
}
if (libc !== "glibc" && libc !== "musl") {
  throw new Error(`Unsupported Linux libc ${libc}. Expected glibc or musl.`);
}

const sourceFile = path.resolve(
  readArg("source-file", path.join(repoRoot, "build", "Release", "native.node")),
);
if (!fs.existsSync(sourceFile)) {
  throw new Error(`Native build not found: ${sourceFile}`);
}

let sourceModule;
try {
  sourceModule = require(sourceFile);
} catch (error) {
  throw new Error(`Failed to load native addon before writing prebuild: ${error && error.message ? error.message : String(error)}`);
}
if (Number(sourceModule && sourceModule.ffaudioAbiVersion || 0) !== 3) {
  throw new Error("Native addon ABI mismatch: expected ffaudioAbiVersion=3");
}
for (const constructorName of ["MediaStream", "G722Encoder", "G722Decoder", "G729Encoder", "G729Decoder", "OpusEncoder", "OpusDecoder"]) {
  if (typeof sourceModule?.[constructorName] !== "function") {
    throw new Error(`Native addon is missing export ${constructorName}`);
  }
}

const tupleDir = path.join(repoRoot, "prebuilds", `${platform}-${arch}`);
fs.mkdirSync(tupleDir, { recursive: true });

const targetFile = path.join(
  tupleDir,
  `native.${libc}.node`,
);

fs.copyFileSync(sourceFile, targetFile);
if (releaseBuild) {
  stripNativeBinary(targetFile);
}
console.log(JSON.stringify({ ok: true, sourceFile, targetFile, release: releaseBuild }));
