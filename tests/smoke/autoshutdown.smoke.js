#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { createSocketPath, forceExit, waitForCondition, waitForDaemonStopped } = require("./lib/daemon-lifecycle-smoke-lib");

if (process.platform !== "linux") {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "daemon autoshutdown smoke requires the Linux native backend",
  }, null, 2));
  process.exit(0);
}

process.once("SIGTERM", () => {
  process.exit(0);
});

async function runScenario(name, order) {
  const { ControllerClient } = require("../../dist/control/controller-client.js");
  const { PbxRuntime } = require("../../dist/runtime/pbx-runtime.js");
  const { SipPbxDaemon } = require("../../dist/daemon/sip-pbx-daemon.js");

  const socketPath = createSocketPath(`sip-pbx-autoshutdown-${name}-`);
  const daemon = new SipPbxDaemon(socketPath);
  await daemon.start();
  const runtime = new PbxRuntime(new ControllerClient({
    socketPath,
    autoStart: false,
  }));

  const triggerEvents = [];
  const triggerStream = await runtime.openExtensionsTrigger({
    ref: `autoshutdown-${name}`,
    localBindPort: 0,
    authMode: "raw",
  }, (event) => triggerEvents.push(event));

  const callLeg = daemon.legService.createLeg({
    legId: `autoshutdown-${name}-call`,
    direction: "inbound",
    transportType: "sip",
    status: "answered",
  });
  const rpcLeg = daemon.legService.createLeg({
    legId: `autoshutdown-${name}-rpc`,
    direction: "inbound",
    transportType: "sip",
    status: "answered",
  });

  const rpcTone = await runtime.playTone(rpcLeg.legId, {
    mediaExecutionMode: "background",
    repeatInfinite: true,
    tone: "ringback",
  });
  assert.strictEqual(rpcTone.status, "started");

  const rpcWaitPromise = runtime.waitMedia({
    waitMediaIds: [rpcTone.mediaId],
    waitMediaTimeoutSeconds: 10,
  });

  await waitForCondition(() => daemon.mediaService.getWorkerCount() >= 1, 10000, `${name} worker started`);

  const actions = {
    async trigger() {
      await triggerStream.close().catch(() => undefined);
    },
    async rpc() {
      await runtime.stopMedia({
        stopMediaTarget: "mediaId",
        stopMediaId: rpcTone.mediaId,
        stopMediaReason: `autoshutdown_${name}`,
      });
      const result = await rpcWaitPromise;
      assert.ok(result);
      assert.strictEqual(result.status, "interrupted");
    },
    async call() {
      await runtime.hangup(callLeg.legId);
    },
  };

  for (const step of order) {
    await actions[step]();
  }

  await waitForCondition(() => daemon.mediaService.getWorkerCount() === 0, 10000, `${name} workers terminated`);
  await waitForDaemonStopped(runtime, 10000, `${name} daemon auto-stopped`);

  await Promise.allSettled([
    triggerStream.close(),
    runtime.stopMedia({
      stopMediaTarget: "mediaId",
      stopMediaId: rpcTone.mediaId,
      stopMediaReason: `autoshutdown_${name}_cleanup`,
    }),
    runtime.hangup(callLeg.legId),
    runtime.hangup(rpcLeg.legId),
  ]);
  await daemon.stop().catch(() => undefined);

  return {
    name,
    order,
    triggerEvents: triggerEvents.length,
    workerCount: daemon.mediaService.getWorkerCount(),
  };
}

async function main() {
  const scenarios = [
    { name: "trigger-rpc-call", order: ["trigger", "rpc", "call"] },
    { name: "call-trigger-rpc", order: ["call", "trigger", "rpc"] },
    { name: "rpc-call-trigger", order: ["rpc", "call", "trigger"] },
  ];

  const results = [];
  for (const scenario of scenarios) {
    console.error(`[autoshutdown-smoke] scenario ${scenario.name}`);
    results.push(await runScenario(scenario.name, scenario.order));
  }

  console.log(JSON.stringify({
    ok: true,
    autoshutdown: results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  forceExit(1, "autoshutdown-smoke");
});
