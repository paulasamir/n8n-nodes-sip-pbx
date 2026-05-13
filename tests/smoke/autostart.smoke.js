#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function createSocketPath() {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".smoke-auto-"));
  return path.join(tempDir, "daemon.sock");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { ControllerClient } = require("../../dist/control/controller-client.js");

  const socketPath = createSocketPath();
  const daemonEntrypoint = path.join(process.cwd(), "dist", "bin", "sip-pbx-daemon.js");
  const client = new ControllerClient({
    socketPath,
    daemonEntrypoint,
    autoStart: true,
  });

  const health = await client.call("health");
  assert.deepStrictEqual(health, { status: "ok" });

  const stopResult = await client.stopDaemon();
  assert.strictEqual(stopResult, undefined);
  await sleep(100);

  const restartedHealth = await client.call("health");
  assert.deepStrictEqual(restartedHealth, { status: "ok" });

  console.log(JSON.stringify({
    ok: true,
    autostart: {
      socketPath,
      health,
      restartedHealth,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
