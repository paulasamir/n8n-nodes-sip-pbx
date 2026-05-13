"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

class FakeSocket extends EventEmitter {
  end() {}
}

test("trigger lifecycle is socket-owned", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../../build-src/control/controller-protocol.js");
  const daemon = new SipPbxDaemon(".unused-trigger-lifecycle.sock");
  const socket = new FakeSocket();

  try {
    daemon.registerTriggerStream({
      kind: "extensions",
      config: { ref: "sales" },
      socket,
      write() {},
    });

    const started = await daemon.dispatchUnary(new RequestContext(), {
      method: ControllerMethod.health,
    });
    assert.deepEqual(started, { status: "ok" });
    assert.equal(daemon.countTriggerStreams(), 1);

    socket.emit("close");

    const stopped = await daemon.dispatchUnary(new RequestContext(), {
      method: ControllerMethod.health,
    });
    assert.deepEqual(stopped, { status: "ok" });
    assert.equal(daemon.countTriggerStreams(), 0);
  } finally {
    await daemon.stop();
  }
});

test("duplicate active extensions trigger stream for the same public ref is rejected globally across flows", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-trigger-duplicate.sock");
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();

  try {
    daemon.registerTriggerStream({
      kind: "extensions",
      config: { ref: "flow:workflow%3Aalpha:extensions:sales", publicRef: "sales" },
      socket: firstSocket,
      write() {},
    });

    assert.throws(() => {
      daemon.registerTriggerStream({
        kind: "extensions",
        config: { ref: "flow:workflow%3Abeta:extensions:sales", publicRef: "sales" },
        socket: secondSocket,
        write() {},
      });
    }, /already exists/i);

    assert.equal(daemon.countTriggerStreams(), 1);
  } finally {
    await daemon.stop();
  }
});

test("flow-scoped trunk trigger streams may reuse the same public ref", async () => {
  const { SipPbxDaemon } = require("../../../build-src/daemon/sip-pbx-daemon.js");
  const daemon = new SipPbxDaemon(".unused-trigger-flow-scope.sock");
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();

  try {
    daemon.registerTriggerStream({
      kind: "trunk",
      config: { ref: "flow:workflow%3Aalpha:trunk:sales", publicRef: "sales" },
      socket: firstSocket,
      write() {},
    });

    daemon.registerTriggerStream({
      kind: "trunk",
      config: { ref: "flow:workflow%3Abeta:trunk:sales", publicRef: "sales" },
      socket: secondSocket,
      write() {},
    });

    assert.equal(daemon.countTriggerStreams(), 2);
  } finally {
    await daemon.stop();
  }
});
