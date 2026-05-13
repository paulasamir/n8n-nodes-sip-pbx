#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { minify } = require("terser");

const defaultRootDir = path.join(__dirname, "..");

function collectJsFiles(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
}

async function minifyJsFiles(rootDir, relativeDir) {
  const targetDir = path.join(rootDir, relativeDir);
  if (!fs.existsSync(targetDir)) {
    return;
  }

  const files = [];
  collectJsFiles(targetDir, files);

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const result = await minify(source, {
      ecma: 2020,
      compress: {
        passes: 2,
      },
      mangle: true,
      format: {
        comments: false,
      },
    });

    if (result.error) {
      throw result.error;
    }
    if (typeof result.code !== "string" || result.code.length === 0) {
      throw new Error(`Minification produced empty output for ${path.relative(rootDir, filePath)}`);
    }

    fs.writeFileSync(filePath, `${result.code}\n`);
  }
}

async function optimizeReleaseBuild(options = {}) {
  const rootDir = options.rootDir || defaultRootDir;
  if (!options.enabled) {
    return;
  }

  await minifyJsFiles(rootDir, "dist");
}

async function main() {
  await optimizeReleaseBuild({
    enabled: process.argv.includes("--release") || process.env.SIP_PBX_RELEASE_BUILD === "1",
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  minifyJsFiles,
  optimizeReleaseBuild,
};
