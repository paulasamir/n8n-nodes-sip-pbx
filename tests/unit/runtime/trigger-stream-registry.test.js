"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

async function waitForCondition(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Wait timeout: ${label}`);
}

function createStream(input) {
  let closeHandler = null;
  let eventHandler = null;
  return {
    triggerKey: input.triggerKey,
    socketId: input.socketId || `${input.triggerKey}:socket`,
    closed: false,
    onEvent(handler) {
      eventHandler = handler;
      return () => {
        if (eventHandler === handler) {
          eventHandler = null;
        }
      };
    },
    onClose(handler) {
      closeHandler = handler;
      return () => {
        if (closeHandler === handler) {
          closeHandler = null;
        }
      };
    },
    emitClose(info) {
      if (closeHandler) {
        closeHandler(info);
      }
    },
    emit(branch, payload) {
      if (eventHandler) {
        eventHandler({ branch, payload });
      }
    },
    close() {
      this.closed = true;
      this.emitClose({ expected: true, reason: "closed" });
    },
  };
}

test("TriggerStreamRegistry rejects duplicate active streams by logical key", async () => {
  const { TriggerStreamRegistry } = require("../../../build-src/runtime/trigger-stream-registry.js");
  const registry = new TriggerStreamRegistry();

  const streamA = {
    triggerKey: "extensions:sales",
    socketId: "a",
    close() {},
  };
  const streamB = {
    triggerKey: "extensions:sales",
    socketId: "b",
    close() {},
  };
  const streamC = {
    triggerKey: "queue:support",
    socketId: "c",
    close() {},
  };

  await registry.open("extensions:sales", async () => streamA);
  await assert.rejects(
    registry.open("extensions:sales", async () => streamB),
    /already active/i,
  );
  await registry.open("queue:support", async () => streamC);

  registry.close("extensions:sales");
  registry.closeAll();
});

test("TriggerStreamRegistry reconnects unexpectedly closed streams", async () => {
  const { TriggerStreamRegistry } = require("../../../build-src/runtime/trigger-stream-registry.js");
  const registry = new TriggerStreamRegistry();
  const streams = [];
  let openCount = 0;

  const managed = await registry.open("extensions:sales", async () => {
    openCount += 1;
    const stream = createStream({
      triggerKey: `extensions_sales_${openCount}`,
      socketId: `socket_${openCount}`,
    });
    streams.push(stream);
    return stream;
  });

  assert.strictEqual(openCount, 1);
  assert.strictEqual(managed.triggerKey, "extensions_sales_1");
  assert.strictEqual(managed.socketId, "socket_1");

  streams[0].emitClose({ expected: false, reason: "socket_closed" });
  await waitForCondition(() => openCount === 2, 1000, "trigger stream reconnect");
  assert.strictEqual(managed.triggerKey, "extensions_sales_2");
  assert.strictEqual(managed.socketId, "socket_2");

  await managed.close();
  streams[1].emitClose({ expected: false, reason: "socket_closed" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.strictEqual(openCount, 2);
});

test("PbxRuntime keeps trigger callbacks after stream reconnect", async () => {
  const { PbxRuntime } = require("../../../build-src/runtime/pbx-runtime.js");
  const streams = [];

  const runtime = new PbxRuntime({
    async openStream(start) {
      const stream = createStream({
        triggerKey: `extensions_sales_${streams.length + 1}`,
        socketId: `socket_${streams.length + 1}`,
      });
      streams.push({ start, stream });
      return stream;
    },
    async call() {
      throw new Error("Unexpected unary call");
    },
  });

  const events = [];
  const handle = await runtime.openExtensionsTrigger({ ref: "sales" }, (event) => events.push(event));
  streams[0].stream.emit("Call", { ref: "sales", legId: "leg-1" });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].branch, "Call");
  assert.strictEqual(events[0].payload.legId, "leg-1");

  streams[0].stream.emitClose({ expected: false, reason: "socket_closed" });
  await waitForCondition(() => streams.length === 2, 1000, "runtime trigger reconnect");
  assert.strictEqual(streams[1].start.kind, "extensions");
  assert.strictEqual(streams[1].start.config.ref, "sales");

  streams[1].stream.emit("Call", { ref: "sales", legId: "leg-2" });
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[1].payload.legId, "leg-2");

  await handle.close();
  streams[1].stream.emitClose({ expected: false, reason: "socket_closed" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.strictEqual(streams.length, 2);
});

test("PbxRuntime scopes flow-local refs while preserving public refs", async () => {
  const { PbxRuntime } = require("../../../build-src/runtime/pbx-runtime.js");
  const starts = [];
  const calls = [];
  const runtime = new PbxRuntime({
    async openStream(start) {
      starts.push(start);
      return createStream({
        triggerKey: `${start.kind}:${starts.length}`,
        socketId: `socket_${starts.length}`,
      });
    },
    async call(method, params) {
      calls.push({ method, params });
      return {};
    },
  }, "workflow:alpha");

  const trunk = await runtime.openTrunkTrigger({ ref: "sales" }, () => undefined);
  const extensions = await runtime.openExtensionsTrigger({ ref: "office" }, () => undefined);
  const queue = await runtime.openQueueTrigger({ ref: "support" }, () => undefined);
  const aiTool = await runtime.openAiToolTrigger({ ref: "helper" }, () => undefined);
  await runtime.makeDial({ callMode: "trunk", ref: "sales", destination: ["100"] });
  await runtime.makeDial({ callMode: "extension", extensionNumbers: ["100"] });
  await runtime.makeDial({ callMode: "extension", extensionNumbers: ["101"] });
  await runtime.getQueueStats({ queueStatsTarget: "ref", ref: "support" });
  await runtime.invokeAiTool({ ref: "helper", aiLegId: "leg-ai" });

  assert.equal(starts[0].config.publicRef, "sales");
  assert.equal(starts[1].config.publicRef, "office");
  assert.equal(starts[2].config.publicRef, "support");
  assert.equal(starts[3].config.publicRef, "helper");
  assert.match(starts[0].config.ref, /^flow:/);
  assert.match(starts[1].config.ref, /^flow:/);
  assert.match(starts[2].config.ref, /^flow:/);
  assert.match(starts[3].config.ref, /^flow:/);
  assert.notEqual(calls[0].params.ref, "sales");
  assert.equal(calls[0].params.publicRef, "sales");
  assert.equal(calls[1].params.workflowScopeKey, "workflow:alpha");
  assert.equal(calls[1].params.ref, undefined);
  assert.equal(calls[2].params.workflowScopeKey, "workflow:alpha");
  assert.equal(calls[2].params.ref, undefined);
  assert.notEqual(calls[3].params.ref, "support");
  assert.notEqual(calls[4].params.ref, "helper");

  await trunk.close();
  await extensions.close();
  await queue.close();
  await aiTool.close();
});
