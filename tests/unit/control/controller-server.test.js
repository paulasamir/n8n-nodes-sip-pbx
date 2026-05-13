"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("ControllerServer accepts aiTool trigger stream kind", async () => {
  const { ControllerServer } = require("../../../build-src/daemon/controller-server.js");
  const server = new ControllerServer({
    socketPath: "/tmp/fake-controller-server.sock",
    handleUnary: async () => ({}),
    handleStreamStart: async () => ({}),
  });

  assert.doesNotThrow(() => {
    server.assertValidFrame({
      kind: "aiTool",
      config: {
        ref: "assistant_tools",
      },
    });
  });
});
