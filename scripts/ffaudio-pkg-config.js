#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function fail(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(1);
}

function versionParts(value) {
  return String(value || "")
    .trim()
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = index < a.length ? a[index] : 0;
    const bv = index < b.length ? b[index] : 0;
    if (typeof av === "number" && typeof bv === "number") {
      if (av < bv) return -1;
      if (av > bv) return 1;
      continue;
    }
    const as = String(av);
    const bs = String(bv);
    if (as < bs) return -1;
    if (as > bs) return 1;
  }
  return 0;
}

function parsePackageRequirement(raw) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { pkg: "", op: "", version: "" };
  return {
    pkg: tokens[0] || "",
    op: tokens[1] || "",
    version: tokens[2] || "",
  };
}

function readPcFile(pkgConfigDirs, pkg) {
  const dirs = Array.isArray(pkgConfigDirs) ? pkgConfigDirs : [pkgConfigDirs];
  const filePath = dirs
    .map((dir) => path.join(dir, `${pkg}.pc`))
    .find((candidate) => fs.existsSync(candidate));
  if (!filePath) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const vars = Object.create(null);
  const fields = Object.create(null);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
      const equalsIndex = trimmed.indexOf("=");
      vars[trimmed.slice(0, equalsIndex)] = trimmed.slice(equalsIndex + 1);
      continue;
    }
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      fields[trimmed.slice(0, colonIndex)] = trimmed.slice(colonIndex + 1).trim();
    }
  }
  const resolveValue = (input) => {
    let output = String(input || "");
    let changed = true;
    while (changed) {
      changed = false;
      output = output.replace(/\$\{([^}]+)\}/g, (_, key) => {
        if (Object.prototype.hasOwnProperty.call(vars, key)) {
          changed = true;
          return String(vars[key] || "");
        }
        return "";
      });
    }
    return output.trim();
  };
  for (const key of Object.keys(vars)) vars[key] = resolveValue(vars[key]);
  for (const key of Object.keys(fields)) fields[key] = resolveValue(fields[key]);
  return { filePath, vars, fields };
}

function checkRequirement(pc, requirement) {
  if (!requirement.version || !requirement.op) return true;
  const actual = String(pc.fields.Version || "");
  const cmp = compareVersions(actual, requirement.version);
  switch (requirement.op) {
    case "=":
    case "==":
      return cmp === 0;
    case "!=":
      return cmp !== 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    default:
      return true;
  }
}

const args = process.argv.slice(2);
const pkgConfigDirs = String(process.env.FFAUDIO_PKGCONFIG_DIR || "")
  .split(path.delimiter)
  .map((entry) => String(entry || "").trim())
  .filter(Boolean);
if (!pkgConfigDirs.length) fail("FFAUDIO_PKGCONFIG_DIR is required");

let mode = "";
let wantStatic = false;
let variableName = "";
const rawPackages = [];

for (const arg of args) {
  if (!arg) continue;
  if (arg === "--version") {
    mode = "version";
    continue;
  }
  if (arg === "--print-errors") continue;
  if (arg === "--exists") {
    mode = "exists";
    continue;
  }
  if (arg === "--modversion") {
    mode = "modversion";
    continue;
  }
  if (arg === "--cflags") {
    mode = "cflags";
    continue;
  }
  if (arg === "--cflags-only-I") {
    mode = "cflags-only-I";
    continue;
  }
  if (arg === "--libs") {
    mode = "libs";
    continue;
  }
  if (arg === "--static") {
    wantStatic = true;
    continue;
  }
  if (arg.startsWith("--variable=")) {
    mode = "variable";
    variableName = arg.slice("--variable=".length);
    continue;
  }
  if (arg.startsWith("-")) continue;
  rawPackages.push(arg);
}

if (mode === "version") {
  process.stdout.write("0.29.2\n");
  process.exit(0);
}

if (!rawPackages.length) fail("No pkg-config package specified");

const packages = rawPackages.map(parsePackageRequirement);
const pcs = packages.map((requirement) => {
  const pc = readPcFile(pkgConfigDirs, requirement.pkg);
  if (!pc) fail(`Package ${requirement.pkg} was not found in the pkg-config search path.`);
  if (!checkRequirement(pc, requirement)) {
    fail(`Package requirement not met: ${requirement.pkg} ${requirement.op} ${requirement.version} (found ${pc.fields.Version || "0"})`);
  }
  return pc;
});

if (mode === "exists") process.exit(0);

if (mode === "modversion") {
  process.stdout.write(`${String(pcs[0].fields.Version || "")}\n`);
  process.exit(0);
}

if (mode === "variable") {
  process.stdout.write(`${String(pcs[0].vars[variableName] || pcs[0].fields[variableName] || "")}\n`);
  process.exit(0);
}

if (mode === "cflags" || mode === "cflags-only-I") {
  const flags = pcs
    .map((pc) => String(pc.fields.Cflags || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const filtered = mode === "cflags-only-I" ? flags.filter((flag) => flag.startsWith("-I")) : flags;
  process.stdout.write(`${filtered.join(" ")}\n`);
  process.exit(0);
}

if (mode === "libs") {
  const tokens = [];
  for (const pc of pcs) {
    const libs = String(pc.fields.Libs || "").trim();
    const privateLibs = wantStatic ? String(pc.fields["Libs.private"] || "").trim() : "";
    for (const flag of `${libs} ${privateLibs}`.trim().split(/\s+/).filter(Boolean)) {
      tokens.push(flag);
    }
  }
  process.stdout.write(`${tokens.join(" ")}\n`);
  process.exit(0);
}

fail(`Unsupported pkg-config mode: ${args.join(" ")}`);
