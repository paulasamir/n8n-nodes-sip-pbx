#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.platform !== "linux") {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "bridge migration smoke requires the Linux native backend",
  }, null, 2));
  process.exit(0);
}

function forceExit(code) {
  const handles = (process._getActiveHandles?.() || []).map((handle) => handle?.constructor?.name || typeof handle);
  const requests = (process._getActiveRequests?.() || []).map((request) => request?.constructor?.name || typeof request);
  console.error(`[bridge-migration-smoke] forceExit code=${code}; handles=${JSON.stringify(handles)}; requests=${JSON.stringify(requests)}`);
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

process.once("SIGTERM", () => {
  process.exit(0);
});

function createSocketPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sip-pbx-bridge-migration-"));
  return path.join(tempDir, "daemon.sock");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitForCondition(predicate, timeoutMs = 1000, label = "condition") {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Wait timeout: ${label}`);
}

async function startInfiniteTone(runtime, legId, tone = "ringback") {
  const result = await runtime.playTone(legId, {
    mediaExecutionMode: "background",
    repeatInfinite: true,
    tone,
  });
  assert.strictEqual(result.status, "started");
  return result;
}

async function main() {
  const step = (label) => {
    console.error(`[bridge-migration-smoke] ${label}`);
  };
  const { ControllerClient } = require("../../dist/control/controller-client.js");
  const { PbxRuntime } = require("../../dist/runtime/pbx-runtime.js");
  const { SipPbxDaemon } = require("../../dist/daemon/sip-pbx-daemon.js");
  const {
    INTERRUPT_REASON_CALL_BRIDGE_REMOVED_PEER_ENDED,
  } = require("../../dist/shared/interrupt-reasons.js");

  const socketPath = createSocketPath();
  const daemon = new SipPbxDaemon(socketPath);
  await daemon.start();
  let completed = false;

  try {
    const runtime = new PbxRuntime(new ControllerClient(socketPath));
    const health = await runtime.health();
    assert.strictEqual(health.status, "ok");

    const legs = [];
    for (let index = 1; index <= 16; index += 1) {
      step(`create leg ${index}`);
      const leg = daemon.legService.createLeg({
        legId: `bridge-migration-leg-${index}`,
        direction: "inbound",
        transportType: "sip",
        status: "answered",
      });
      const tone = await startInfiniteTone(runtime, leg.legId);
      legs.push({ leg, tone });
    }

    step("create leg 17");
    const bridgeLeg = daemon.legService.createLeg({
      legId: "bridge-migration-leg-17",
      direction: "outbound",
      transportType: "sip",
      status: "answered",
    });
    const bridgeTone = await startInfiniteTone(runtime, bridgeLeg.legId);

    await waitForCondition(() => daemon.mediaService.getWorkerCount() >= 2, 5000, "at least two media workers");
    assert.ok(daemon.mediaService.getWorkerCount() >= 2);

    step("stop tones on bridge legs");
    await Promise.all([
      runtime.stopMedia({
        stopMediaTarget: "mediaId",
        mediaId: legs[0].tone.mediaId,
      }),
      runtime.stopMedia({
        stopMediaTarget: "mediaId",
        mediaId: bridgeTone.mediaId,
      }),
    ]);

    step("bridge first and seventeenth");
    const bridgeInterruptPromise = runtime.waitForLegEvent(bridgeLeg.legId, {
      timeoutSeconds: 2,
      interruptReasons: [INTERRUPT_REASON_CALL_BRIDGE_REMOVED_PEER_ENDED],
    });
    const bridgeResult = await runtime.bridge(legs[0].leg.legId, bridgeLeg.legId, {
      emitDtmfEvents: true,
      relayDtmf: "auto",
    });
    assert.strictEqual(bridgeResult.legAId, legs[0].leg.legId);
    assert.strictEqual(bridgeResult.legBId, bridgeLeg.legId);

    step("hangup first");
    await runtime.hangup(legs[0].leg.legId);
    const bridgeInterruptEvent = await bridgeInterruptPromise;
    assert.strictEqual(bridgeInterruptEvent.output, "interrupt");
    assert.strictEqual(bridgeInterruptEvent.reason, INTERRUPT_REASON_CALL_BRIDGE_REMOVED_PEER_ENDED);

    const survivingLeg = daemon.legService.getLeg(bridgeLeg.legId);
    assert.ok(survivingLeg);
    assert.strictEqual(survivingLeg.bridgePeerLegId, undefined);

    for (const entry of legs.slice(1).reverse()) {
      step(`cleanup filler ${entry.leg.legId}`);
      await runtime.hangup(entry.leg.legId);
    }

    step("cleanup seventeenth");
    await runtime.hangup(bridgeLeg.legId);

    step("done");
    console.log(JSON.stringify({
      ok: true,
      workerCount: daemon.mediaService.getWorkerCount(),
      bridge: {
        first: legs[0].leg.legId,
        seventeenth: bridgeLeg.legId,
        migrated: true,
      },
    }, null, 2));
    completed = true;
  } finally {
    step("cleanup daemon.stop");
    const daemonStop = daemon.stop();
    const stopResult = await Promise.race([
      daemonStop.then(() => "done", () => "failed"),
      sleep(5000).then(() => "timeout"),
    ]);
    if (stopResult !== "done") {
      console.error(`[bridge-migration-smoke] daemon.stop ${stopResult}`);
    }
    if (completed) {
      step("cleanup done");
      forceExit(0);
    } else if (stopResult !== "done") {
      forceExit(1);
    }
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  forceExit(1);
});
