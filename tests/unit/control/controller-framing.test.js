"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(chunk) {
    this.writes.push(String(chunk));
    return true;
  }

  end() {}
}

test("LineFramedSocket frames newline-delimited JSON messages", async () => {
  const { LineFramedSocket } = require("../../../build-src/control/controller-framing.js");
  const socket = new FakeSocket();
  const framed = new LineFramedSocket(socket);
  const seen = [];
  const unsubscribe = framed.onFrame((frame) => {
    seen.push(frame);
  });

  socket.emit("data", Buffer.from("{\"a\":1}\n{\"b\"", "utf8"));
  socket.emit("data", Buffer.from(":2}\n", "utf8"));

  assert.deepStrictEqual(seen, [{ a: 1 }, { b: 2 }]);

  framed.writeFrame({ ok: true, value: 3 });
  assert.deepStrictEqual(socket.writes, ["{\"ok\":true,\"value\":3}\n"]);

  unsubscribe();
});
