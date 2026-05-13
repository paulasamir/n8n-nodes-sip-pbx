#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { optimizeReleaseBuild } = require("./optimize-release-build");

const rootDir = path.join(__dirname, "..");
const releaseBuild = process.argv.includes("--release");

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
  run(process.execPath, [path.join("scripts", "clean-generated.js"), "dist"]);
  run("tsc", ["-p", "tsconfig.dist.json"]);
  run(process.execPath, [path.join("scripts", "sync-dist-assets.js")]);
  await optimizeReleaseBuild({
    rootDir,
    enabled: releaseBuild,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
