#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function createSocketPath(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "sip-pbx-lifecycle-"));
  return path.join(tempDir, "daemon.sock");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitForCondition(predicate, timeoutMs = 1000, label = "condition") {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Wait timeout: ${label}`);
}

async function waitForDaemonStopped(runtime, timeoutMs = 5000, label = "daemon stopped") {
  await waitForCondition(async () => {
    try {
      await runtime.health();
      return false;
    } catch {
      return true;
    }
  }, timeoutMs, label);
}

function forceExit(code, label) {
  const handles = (process._getActiveHandles?.() || []).map((handle) => handle?.constructor?.name || typeof handle);
  const requests = (process._getActiveRequests?.() || []).map((request) => request?.constructor?.name || typeof request);
  console.error(`[${label}] forceExit code=${code}; handles=${JSON.stringify(handles)}; requests=${JSON.stringify(requests)}`);
  try {
    process.exitCode = code;
  } catch {}
  try {
    process.kill(process.pid, "SIGKILL");
  } catch {
    try {
      process.exit(code);
    } catch {}
  }
}

module.exports = {
  createSocketPath,
  forceExit,
  sleep,
  waitForCondition,
  waitForDaemonStopped,
};
