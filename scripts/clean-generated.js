"use strict";

const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const targets = process.argv.slice(2);

for (const target of targets) {
  const resolved = path.resolve(rootDir, target);
  if (!resolved.startsWith(rootDir)) continue;
  if (!fs.existsSync(resolved)) continue;
  fs.rmSync(resolved, { recursive: true, force: true });
}
