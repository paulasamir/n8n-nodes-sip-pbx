#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { minifyJsFiles } = require("./optimize-release-build");

const rootDir = path.join(__dirname, "..");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
  }
}

async function main() {
  run(process.execPath, [path.join("scripts", "clean-generated.js"), "build-src"]);
  run("tsc", ["-p", "tsconfig.build.json"]);
  await minifyJsFiles(rootDir, "build-src");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
