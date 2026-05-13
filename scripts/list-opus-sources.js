#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const rootDir = path.join(repoRoot, "vendor", "libopus");

const includeDirs = [
  path.join(rootDir, "src"),
  path.join(rootDir, "celt"),
  path.join(rootDir, "silk"),
  path.join(rootDir, "silk", "float"),
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, out);
    else if (entry.isFile() && fullPath.endsWith(".c")) out.push(fullPath);
  }
  return out;
}

const excludedPatterns = [
  `${path.sep}arm${path.sep}`,
  `${path.sep}x86${path.sep}`,
  `${path.sep}mips${path.sep}`,
  `${path.sep}fixed${path.sep}`,
  `${path.sep}tests${path.sep}`,
];

const excludedFileNames = new Set([
  "opus_compare.c",
  "opus_demo.c",
  "repacketizer_demo.c",
  "opus_custom_demo.c",
]);

const files = Array.from(new Set(includeDirs.flatMap((dir) => walk(dir))))
  .filter((filePath) => !excludedPatterns.some((pattern) => filePath.includes(pattern)))
  .filter((filePath) => !excludedFileNames.has(path.basename(filePath)))
  .map((filePath) => path.relative(repoRoot, filePath).split(path.sep).join("/"))
  .sort();

process.stdout.write(files.join("\n"));
