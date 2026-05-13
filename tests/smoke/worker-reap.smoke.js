#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { createSocketPath, forceExit, waitForCondition, waitForDaemonStopped } = require("./lib/daemon-lifecycle-smoke-lib");

if (process.platform !== "linux") {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "worker reap smoke requires the Linux native backend",
  }, null, 2));
  process.exit(0);
}

process.once("SIGTERM", () => {
  process.exit(0);
});

async function main() {
  const { ControllerClient } = require("../../dist/control/controller-client.js");
  const { PbxRuntime } = require("../../dist/runtime/pbx-runtime.js");
  const { SipPbxDaemon } = require("../../dist/daemon/sip-pbx-daemon.js");

  const socketPath = createSocketPath("sip-pbx-worker-reap-");
  const daemon = new SipPbxDaemon(socketPath);
  await daemon.start();
  const runtime = new PbxRuntime(new ControllerClient({
    socketPath,
    autoStart: false,
  }));
  let completed = false;

  try {
    const health = await runtime.health();
    assert.deepStrictEqual(health, { status: "ok" });

    const firstLeg = daemon.legService.createLeg({
      legId: "worker-reap-leg-a",
      direction: "inbound",
      transportType: "sip",
      status: "answered",
    });
    const secondLeg = daemon.legService.createLeg({
      legId: "worker-reap-leg-b",
      direction: "inbound",
      transportType: "sip",
      status: "answered",
    });

    const firstTone = await runtime.playTone(firstLeg.legId, {
      mediaExecutionMode: "background",
      repeatInfinite: true,
      tone: "ringback",
    });
    const secondTone = await runtime.playTone(secondLeg.legId, {
      mediaExecutionMode: "background",
      repeatInfinite: true,
      tone: "ringback",
    });
    assert.strictEqual(firstTone.status, "started");
    assert.strictEqual(secondTone.status, "started");

    await waitForCondition(() => daemon.mediaService.getWorkerCount() >= 2, 10000, "media workers started");

    await runtime.hangup(firstLeg.legId);
    await runtime.hangup(secondLeg.legId);

    await waitForCondition(() => daemon.mediaService.getWorkerCount() === 0, 10000, "media workers terminated");
    await waitForDaemonStopped(runtime, 10000, "daemon auto-stopped after worker release");

    console.log(JSON.stringify({
      ok: true,
      workerReap: {
        workerCount: daemon.mediaService.getWorkerCount(),
        firstLeg: firstLeg.legId,
        secondLeg: secondLeg.legId,
      },
    }, null, 2));
    completed = true;
  } finally {
    await daemon.stop().catch(() => undefined);
    forceExit(completed ? 0 : 1, "worker-reap-smoke");
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  forceExit(1, "worker-reap-smoke");
});
