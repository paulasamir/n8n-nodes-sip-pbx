"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const net = require("node:net");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
    this.closed = false;
  }

  write(chunk) {
    this.writes.push(String(chunk));
    if (!this.closed) {
      this.closed = true;
      setTimeout(() => {
        this.destroyed = true;
        this.emit("close");
      }, 20);
    }
    return true;
  }

  end() {
    this.destroyed = true;
    this.emit("close");
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

test("ControllerClient rejects pending requests when the daemon socket closes", async () => {
  const originalCreateConnection = net.createConnection;
  try {
    net.createConnection = (path, connectListener) => {
      const socket = new FakeSocket();
      if (typeof connectListener === "function") {
        setImmediate(() => connectListener());
      }
      return socket;
    };

    const { ControllerClient } = require("../../../build-src/control/controller-client.js");
    const client = new ControllerClient({ socketPath: "/tmp/fake-controller.sock", autoStart: false });

    await assert.rejects(
      client.call("health"),
      (error) => {
        assert.strictEqual(error && error.code, "daemon_disconnected");
        assert.match(String(error && error.message ? error.message : ""), /socket closed/i);
        return true;
      },
    );
  } finally {
    net.createConnection = originalCreateConnection;
  }
});
