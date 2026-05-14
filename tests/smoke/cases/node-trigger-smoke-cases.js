#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { OPTION_DEFAULTS } = require("../../../build-src/shared/option-defaults.js");
const {
  sipPbxTriggerModulePath,
  createTriggerContext,
  withPatchedRuntime,
} = require("../lib/node-smoke-lib");

function createFakeStream() {
  return {
    closed: false,
    handler: null,
    onEvent(handler) {
      this.handler = handler;
      return () => {
        this.handler = null;
      };
    },
    emit(branch, payload) {
      if (this.handler) {
        this.handler({ kind: "test", branch, payload });
      }
    },
    close() {
      this.closed = true;
    },
  };
}

async function testTrunkTriggerNode() {
  const emitted = [];
  const seen = {};
  const stream = createFakeStream();
  const fakeRuntime = {
    async openTrunkTrigger(config, onEvent) {
      seen.config = config;
      stream.onEvent(onEvent);
      stream.emit("Call", {
        eventType: "invite",
        ref: config.ref,
        legId: "leg-trunk-1",
        callId: "call-trunk-1",
        from: "sip:100@example.test",
        callerName: "Alice",
        to: "\"Sales\" <sip:200@example.test>",
        headers: {
          "call-id": "call-trunk-1",
          "x-test-header": "yes",
        },
        raw: {
          startLine: "INVITE sip:200@example.test SIP/2.0",
          method: "INVITE",
          requestUri: "sip:200@example.test",
          headers: {
            "call-id": "call-trunk-1",
            "x-test-header": "yes",
          },
          body: "",
        },
      });
      stream.emit("Recording", {
        eventType: "record",
        recordRequestId: "record-trunk-1",
        kind: "trunk",
        ref: config.ref,
        legId: "leg-trunk-1",
        callId: "call-trunk-1",
        direction: "inbound",
        from: "sip:100@example.test",
        callerName: "Alice",
        to: "\"Sales\" <sip:200@example.test>",
        extension: "",
      });
      return stream;
    },
    async closeTriggerStream(kind, input) {
      assert.strictEqual(kind, "trunk");
      assert.deepStrictEqual(input, { ref: "carrier-a" });
      stream.close();
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxTriggerModulePath, async ({ SipPbxTrigger }) => {
    const node = new SipPbxTrigger();
    const [operationProperty] = node.description.properties;
    assert.strictEqual(operationProperty.displayName, "Trigger On");
    assert.strictEqual(operationProperty.name, "triggerOn");
    assert.deepStrictEqual(
      operationProperty.options.map((option) => option.value),
      ["trunk", "extensions", "queue", "aiTool"],
    );
    const refProperties = node.description.properties.filter((property) => property.name === "ref");
    assert.deepStrictEqual(
      refProperties.map((property) => property.displayOptions.show.triggerOn[0]),
      ["aiTool", "trunk", "extensions", "queue"],
    );
    Object.assign(node, createTriggerContext({
      triggerOn: "trunk",
      ref: "carrier-a",
      trunkRegisterMode: "register",
      enableCallRecording: true,
      trunkOptions: {
        registrationExpires: 900,
        registerHeaders: { item: [{ name: "X-Test", value: "1" }] },
        recordResponseTimeoutSeconds: 2.5,
      },
    }, {
      emitted,
      workflowId: "wf-trunk",
      nodeName: "Trunk Trigger",
      nodePosition: [120, 260],
      credentials: {
        sipPbxExternal: {
          sipServer: "sip.carrier.test",
          port: 5061,
          transport: "tls",
          username: "carrier-user",
        },
      },
    }));
    const activation = await node.trigger();
    await activation.closeFunction();
  });

  assert.strictEqual(seen.config.ref, "carrier-a");
  assert.strictEqual(seen.config.sipCredentials.username, "carrier-user");
  assert.deepStrictEqual(seen.config.registerHeaders, [{ name: "X-Test", value: "1" }]);
  assert.strictEqual(seen.config.trunkRegisterMode, "register");
  assert.strictEqual(seen.config.enableCallRecording, true);
  assert.strictEqual(seen.config.recordResponseTimeoutSeconds, 2.5);
  assert.strictEqual(seen.config.recordingFilePathTemplate, undefined);
  assert.strictEqual(seen.config.recordingSplitChannels, undefined);
  assert.strictEqual(stream.closed, true);
  assert.strictEqual(emitted.length, 2);
  assert.strictEqual(emitted[0][0][0].json.eventType, "invite");
  assert.strictEqual(emitted[0][0][0].json.ref, "carrier-a");
  assert.strictEqual(emitted[0][0][0].json.callerNumber, "100");
  assert.strictEqual(emitted[0][0][0].json.calledNumber, "200");
  assert.strictEqual(emitted[0][0][0].json.calledName, "Sales");
  assert.strictEqual(emitted[0][0][0].json.sipPbx.legId, "leg-trunk-1");
  assert.deepStrictEqual(emitted[0][1], []);
  assert.strictEqual(emitted[1][1][0].json.eventType, "record");
  assert.strictEqual(emitted[1][1][0].json.recordRequestId, "record-trunk-1");
  assert.strictEqual(emitted[1][1][0].json.direction, "inbound");
  assert.strictEqual(emitted[1][1][0].json.from, "sip:100@example.test");
  assert.strictEqual(emitted[1][1][0].json.callerNumber, "100");
  assert.strictEqual(emitted[1][1][0].json.to, "\"Sales\" <sip:200@example.test>");
  assert.strictEqual(emitted[1][1][0].json.calledNumber, "200");
  assert.strictEqual(emitted[1][1][0].json.calledName, "Sales");
  assert.strictEqual(emitted[1][1][0].json.timestamp, undefined);
  assert.strictEqual(emitted[1][1][0].json.date, undefined);
  assert.strictEqual(emitted[1][1][0].json.time, undefined);
  assert.strictEqual(emitted[1][1][0].json.yyyy, undefined);
  assert.strictEqual(emitted[1][1][0].json.mm, undefined);
  assert.strictEqual(emitted[1][1][0].json.dd, undefined);
  assert.strictEqual(emitted[1][1][0].json.hh, undefined);
  assert.strictEqual(emitted[1][1][0].json.min, undefined);
  assert.strictEqual(emitted[1][1][0].json.ss, undefined);
  assert.deepStrictEqual(emitted[1][1][0]._sipPbxResponseHandle, { kind: "record", handle: "record-trunk-1" });
  assert.deepStrictEqual(emitted[1][0], []);
  return { emitted: emitted.length };
}

async function testTrunkAuthTriggerNode() {
  const emitted = [];
  const seen = {};
  const stream = createFakeStream();
  const fakeRuntime = {
    async openTrunkTrigger(config, onEvent) {
      seen.config = config;
      stream.onEvent(onEvent);
      stream.emit("Auth", {
        authRequestId: "auth-trunk-1",
        ref: config.ref,
        requestType: "register",
        auth: { username: "carrier-user", realm: "carrier.local", nonce: "nonce-1" },
        remoteIp: "203.0.113.20",
        remotePort: 5060,
        transport: "udp",
        localIp: "0.0.0.0",
        localPort: 5060,
        raw: {
          startLine: "REGISTER sip:carrier.local SIP/2.0",
          method: "REGISTER",
          requestUri: "sip:carrier.local",
          headers: {
            callId: "auth-trunk-call-1",
          },
          body: "",
        },
      });
      return stream;
    },
    async closeTriggerStream(kind, input) {
      assert.strictEqual(kind, "trunk");
      assert.deepStrictEqual(input, { ref: "carrier-auth" });
      stream.close();
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxTriggerModulePath, async ({ SipPbxTrigger }) => {
    const node = new SipPbxTrigger();
    Object.assign(node, createTriggerContext({
      triggerOn: "trunk",
      ref: "carrier-auth",
      trunkRegisterMode: "auth",
      trunkOptions: {
        authTimeoutSeconds: 7.5,
        continueTraversalOnAuthReject: true,
        transport: "udp",
        localBindIp: "0.0.0.0",
        localBindPort: 5060,
        advertisedIp: "203.0.113.21",
        realm: "carrier.local",
      },
    }, {
      emitted,
      workflowId: "wf-trunk-auth",
      nodeName: "Trunk Auth Trigger",
      nodePosition: [140, 280],
    }));
    const activation = await node.trigger();
    await activation.closeFunction();
  });

  assert.strictEqual(seen.config.ref, "carrier-auth");
  assert.strictEqual(seen.config.trunkRegisterMode, "auth");
  assert.strictEqual(seen.config.authTimeoutSeconds, 7.5);
  assert.strictEqual(seen.config.continueTraversalOnAuthReject, true);
  assert.strictEqual(seen.config.realm, "carrier.local");
  assert.strictEqual("sipCredentials" in seen.config, false);
  assert.strictEqual(stream.closed, true);
  assert.strictEqual(emitted.length, 1);
  assert.deepStrictEqual(emitted[0][0], []);
  assert.strictEqual(emitted[0][1][0].json.authRequestId, "auth-trunk-1");
  assert.strictEqual(emitted[0][1][0].json.auth.username, "carrier-user");
  assert.strictEqual(emitted[0][1][0].json.auth.realm, "carrier.local");
  assert.deepStrictEqual(emitted[0][1][0]._sipPbxResponseHandle, { kind: "auth", handle: "auth-trunk-1" });
  return { emitted: emitted.length };
}

async function testExtensionsTriggerNode() {
  const emitted = [];
  const stream = createFakeStream();
  const seen = {};
  const fakeRuntime = {
    async openExtensionsTrigger(config, onEvent) {
      seen.config = config;
      stream.onEvent(onEvent);
      stream.emit("Call", {
        eventType: "invite",
        ref: config.ref,
        legId: "leg-ext-1",
        callId: "call-ext-1",
        extension: "100",
        from: "sip:caller@example.test",
        callerName: "Caller",
        to: "\"Front Desk\" <sip:100@example.test>",
        headers: {
          "call-id": "call-ext-1",
          "x-ext-header": "ok",
        },
        raw: {
          startLine: "INVITE sip:100@example.test SIP/2.0",
          method: "INVITE",
          requestUri: "sip:100@example.test",
          headers: {
            "call-id": "call-ext-1",
            "x-ext-header": "ok",
          },
          body: "",
        },
      });
      stream.emit("Auth", {
        authRequestId: "auth-1",
        ref: config.ref,
        requestType: "register",
        auth: { username: "100", realm: "office.local", nonce: "nonce" },
        remoteIp: "203.0.113.9",
        remotePort: 5062,
        transport: "udp",
        localIp: "0.0.0.0",
        localPort: 5060,
        raw: {
          startLine: "REGISTER sip:office.local SIP/2.0",
          method: "REGISTER",
          requestUri: "sip:office.local",
          headers: {
            callId: "auth-call-1",
            xAuthHeader: "yes",
          },
          body: "",
        },
      });
      stream.emit("Recording", {
        eventType: "record",
        recordRequestId: "record-1",
        kind: "extensions",
        ref: config.ref,
        legId: "leg-ext-1",
        callId: "call-ext-1",
        direction: "inbound",
        extension: "100",
        from: "sip:caller@example.test",
        callerName: "Caller",
        to: "\"Front Desk\" <sip:100@example.test>",
      });
      return stream;
    },
    async closeTriggerStream(kind, input) {
      assert.strictEqual(kind, "extensions");
      assert.deepStrictEqual(input, { ref: "office-ext" });
      stream.close();
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxTriggerModulePath, async ({ SipPbxTrigger }) => {
    const node = new SipPbxTrigger();
    Object.assign(node, createTriggerContext({
      triggerOn: "extensions",
      ref: "office-ext",
      authMode: "raw",
      staticCredentials: { item: [{ username: "100", password: "secret", extension: "100" }] },
      extensionsEnableCallRecording: true,
      extensionsOptions: {
        authTimeoutSeconds: 3.5,
        recordResponseTimeoutSeconds: 4.5,
        transports: ["udp"],
        localBindPort: 5060,
        localBindIp: "0.0.0.0",
        advertisedIp: "203.0.113.10",
        realm: "office.local",
      },
    }, {
      emitted,
      workflowId: "wf-ext",
      nodeName: "Extensions Trigger",
      nodePosition: [240, 360],
    }));
    const activation = await node.trigger();
    await activation.closeFunction();
  });

  assert.strictEqual(seen.config.ref, "office-ext");
  assert.strictEqual(seen.config.authMode, "raw");
  assert.strictEqual(seen.config.authTimeoutSeconds, 3.5);
  assert.strictEqual(seen.config.recordResponseTimeoutSeconds, 4.5);
  assert.strictEqual(seen.config.extensionsEnableCallRecording, true);
  assert.strictEqual(stream.closed, true);
  assert.strictEqual(emitted.length, 3);
  assert.strictEqual(emitted[0][0][0].json.sipPbx.legId, "leg-ext-1");
  assert.strictEqual(emitted[0][0][0].json.callId, "call-ext-1");
  assert.strictEqual(emitted[0][0][0].json.callerNumber, "caller");
  assert.strictEqual(emitted[0][0][0].json.calledNumber, "100");
  assert.strictEqual(emitted[0][0][0].json.calledName, "Front Desk");
  assert.strictEqual(emitted[0][0][0].json.sipPbx.callId, undefined);
  assert.deepStrictEqual(emitted[0][1], []);
  assert.deepStrictEqual(emitted[0][2], []);
  assert.strictEqual(emitted[1][2][0].json.authRequestId, "auth-1");
  assert.strictEqual(emitted[1][2][0].json.requestType, "register");
  assert.strictEqual(emitted[1][2][0].json.auth.username, "100");
  assert.strictEqual(emitted[1][2][0].json.auth.realm, "office.local");
  assert.strictEqual(emitted[1][2][0].json.auth.nonce, "nonce");
  assert.strictEqual(emitted[1][2][0].json.remoteIp, "203.0.113.9");
  assert.strictEqual(emitted[1][2][0].json.remotePort, 5062);
  assert.strictEqual(emitted[1][2][0].json.transport, "udp");
  assert.strictEqual(emitted[1][2][0].json.localIp, "0.0.0.0");
  assert.strictEqual(emitted[1][2][0].json.localPort, 5060);
  assert.deepStrictEqual(emitted[1][2][0]._sipPbxResponseHandle, { kind: "auth", handle: "auth-1" });
  assert.deepStrictEqual(emitted[1][0], []);
  assert.deepStrictEqual(emitted[1][1], []);
  assert.strictEqual(emitted[2][1][0].json.recordRequestId, "record-1");
  assert.strictEqual(emitted[2][1][0].json.direction, "inbound");
  assert.strictEqual(emitted[2][1][0].json.from, "sip:caller@example.test");
  assert.strictEqual(emitted[2][1][0].json.callerNumber, "caller");
  assert.strictEqual(emitted[2][1][0].json.to, "\"Front Desk\" <sip:100@example.test>");
  assert.strictEqual(emitted[2][1][0].json.calledNumber, "100");
  assert.strictEqual(emitted[2][1][0].json.calledName, "Front Desk");
  assert.strictEqual(emitted[2][1][0].json.timestamp, undefined);
  assert.strictEqual(emitted[2][1][0].json.date, undefined);
  assert.strictEqual(emitted[2][1][0].json.time, undefined);
  assert.strictEqual(emitted[2][1][0].json.yyyy, undefined);
  assert.strictEqual(emitted[2][1][0].json.mm, undefined);
  assert.strictEqual(emitted[2][1][0].json.dd, undefined);
  assert.strictEqual(emitted[2][1][0].json.hh, undefined);
  assert.strictEqual(emitted[2][1][0].json.min, undefined);
  assert.strictEqual(emitted[2][1][0].json.ss, undefined);
  assert.deepStrictEqual(emitted[2][1][0]._sipPbxResponseHandle, { kind: "record", handle: "record-1" });
  assert.deepStrictEqual(emitted[2][0], []);
  assert.deepStrictEqual(emitted[2][2], []);
  return { emitted: emitted.length };
}

async function testQueueTriggerNode() {
  const emitted = [];
  const stream = createFakeStream();
  const seen = {};
  const fakeRuntime = {
    async openQueueTrigger(config, onEvent) {
      seen.config = config;
      stream.onEvent(onEvent);
      stream.emit("Placed", {
        ref: config.ref,
        legId: "leg-queue-1",
        callerNumber: "+12025550101",
        callerName: "Bob",
        trunkRef: "carrier-a",
      });
      stream.emit("Dispatch", {
        ref: config.ref,
        dialId: "dial-queue-1",
        mode: "live",
        callerNumber: "+12025550101",
        callerName: "Bob",
        trunkRef: "carrier-a",
      });
      stream.emit("Dispatch", {
        ref: config.ref,
        dialId: "dial-queue-2",
        mode: "callback",
        callerNumber: "+1000000",
        callerName: "Alice",
        trunkRef: "carrier-a",
      });
      stream.emit("Offline", {
        ref: config.ref,
        mode: "callback",
        callerNumber: "+1000000",
        callerName: "Alice",
        trunkRef: "carrier-a",
      });
      return stream;
    },
    async closeTriggerStream(kind, input) {
      assert.strictEqual(kind, "queue");
      assert.deepStrictEqual(input, { ref: "support" });
      stream.close();
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxTriggerModulePath, async ({ SipPbxTrigger }) => {
    const node = new SipPbxTrigger();
    Object.assign(node, createTriggerContext({
      triggerOn: "queue",
      ref: "support",
      queueExtensions: "100, 101,102",
      queueOptions: {
        queueRetryPauseSeconds: 3.5,
      },
    }, {
      emitted,
      workflowId: "wf-queue",
      nodeName: "Queue Trigger",
      nodePosition: [420, 180],
    }));
    const activation = await node.trigger();
    await activation.closeFunction();
  });

  assert.deepStrictEqual(seen.config.queueExtensions, ["100", "101", "102"]);
  assert.strictEqual(seen.config.queueRetryPauseSeconds, 3.5);
  assert.strictEqual(stream.closed, true);
  assert.strictEqual(emitted.length, 4);
  assert.strictEqual(emitted[0][0][0].json.legId, "leg-queue-1");
  assert.strictEqual(emitted[0][0][0].json.callerNumber, "+12025550101");
  assert.strictEqual(emitted[0][0][0].json.callerName, "Bob");
  assert.strictEqual(emitted[0][0][0].json.trunkRef, "carrier-a");
  assert.strictEqual(emitted[0][0][0].json.eventType, undefined);
  assert.strictEqual(emitted[0][0][0]._sipPbxResponseHandle, undefined);
  assert.strictEqual(emitted[1][1][0].json.dialId, "dial-queue-1");
  assert.strictEqual(emitted[1][1][0].json.mode, "live");
  assert.strictEqual(emitted[1][1][0].json.callerNumber, "+12025550101");
  assert.strictEqual(emitted[1][1][0].json.callerName, "Bob");
  assert.strictEqual(emitted[1][1][0].json.trunkRef, "carrier-a");
  assert.strictEqual("legId" in emitted[1][1][0].json, false);
  assert.strictEqual("legId" in (emitted[1][1][0].json.sipPbx || {}), false);
  assert.strictEqual(emitted[1][1][0].json.eventType, undefined);
  assert.strictEqual("extensionNumbers" in emitted[1][1][0].json, false);
  assert.strictEqual(emitted[1][1][0]._sipPbxResponseHandle, undefined);
  assert.strictEqual(emitted[2][1][0].json.eventType, undefined);
  assert.strictEqual(emitted[2][1][0].json.mode, "callback");
  assert.strictEqual(emitted[2][1][0].json.callerNumber, "+1000000");
  assert.strictEqual(emitted[2][1][0].json.callerName, "Alice");
  assert.strictEqual(emitted[2][1][0].json.trunkRef, "carrier-a");
  assert.strictEqual(emitted[2][1][0].json.dialId, "dial-queue-2");
  assert.strictEqual("extensionNumbers" in emitted[2][1][0].json, false);
  assert.strictEqual(emitted[2][1][0]._sipPbxResponseHandle, undefined);
  assert.strictEqual(emitted[3][2][0].json.sipPbx.ref, "support");
  assert.strictEqual(emitted[3][2][0].json.mode, "callback");
  assert.strictEqual(emitted[3][2][0].json.callerNumber, "+1000000");
  assert.strictEqual(emitted[3][2][0].json.callerName, "Alice");
  assert.strictEqual(emitted[3][2][0].json.trunkRef, "carrier-a");
  assert.strictEqual("legId" in emitted[3][2][0].json, false);
  assert.strictEqual("legId" in emitted[3][2][0].json.sipPbx, false);
  assert.strictEqual(emitted[3][2][0]._sipPbxResponseHandle, undefined);
  return { emitted: emitted.length };
}

async function testAiTriggerNode() {
  const emitted = [];
  const seen = {};
  const stream = createFakeStream();
  const fakeRuntime = {
    async openAiToolTrigger(config, onEvent) {
      seen.config = config;
      stream.onEvent(onEvent);
      stream.emit("Request", {
        ref: config.ref,
        aiToolRequestId: "ai-tool-request-1",
        aiLegId: "ai-leg-1",
        peerLegId: "peer-leg-1",
        flowParams: { customerId: "42" },
        toolParams: { answer: "yes" },
      });
      return stream;
    },
    async closeTriggerStream(kind, input) {
      assert.strictEqual(kind, "aiTool");
      assert.deepStrictEqual(input, { ref: "assistant_tools" });
      stream.close();
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxTriggerModulePath, async ({ SipPbxTrigger }) => {
    const node = new SipPbxTrigger();
    Object.assign(node, createTriggerContext({
      triggerOn: "aiTool",
      ref: "assistant_tools",
      aiToolOptions: {
        aiToolResponseTimeoutSeconds: 7,
      },
    }, {
      emitted,
      workflowId: "wf-ai",
      nodeName: "AI Tool Call",
      nodePosition: [620, 220],
    }));
    const activation = await node.trigger();
    await activation.closeFunction();
  });

  assert.strictEqual(seen.config.ref, "assistant_tools");
  assert.strictEqual(seen.config.aiToolResponseTimeoutSeconds, 7);
  assert.strictEqual(stream.closed, true);
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0][0][0].json.ref, "assistant_tools");
  assert.strictEqual(emitted[0][0][0].json.aiToolRequestId, "ai-tool-request-1");
  assert.strictEqual(emitted[0][0][0].json.aiLegId, "ai-leg-1");
  assert.strictEqual(emitted[0][0][0].json.peerLegId, "peer-leg-1");
  assert.deepStrictEqual(emitted[0][0][0].json.flowParams, { customerId: "42" });
  assert.deepStrictEqual(emitted[0][0][0].json.toolParams, { answer: "yes" });
  assert.deepStrictEqual(emitted[0][0][0]._sipPbxResponseHandle, { kind: "aiTool", handle: "ai-tool-request-1" });
  return { emitted: emitted.length };
}

async function testTriggerActivationRollback() {
  const fakeRuntime = {
    closeAllCalls: 0,
    async closeAllTriggerStreamsAndWait() {
      this.closeAllCalls += 1;
    },
    async openExtensionsTrigger() {
      throw new Error("Active extensions trigger for ref sales already exists");
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxTriggerModulePath, async ({ SipPbxTrigger }) => {
    const node = new SipPbxTrigger();
    Object.assign(node, createTriggerContext({
      triggerOn: "extensions",
      ref: "sales",
      authMode: "raw",
      extensionsOptions: {
        transports: ["udp"],
      },
    }, {
      workflowId: "wf-rollback",
      nodeName: "Extensions Trigger",
      nodePosition: [120, 120],
    }));

    await assert.rejects(async () => {
      await node.trigger();
    }, /already exists/);
  });

  assert.strictEqual(fakeRuntime.closeAllCalls, 1);
  return { rolledBack: true };
}

async function testTriggerPropertyContract() {
  await withPatchedRuntime({}, sipPbxTriggerModulePath, async ({ SipPbxTrigger }) => {
    const node = new SipPbxTrigger();
    const properties = node.description.properties;
    const assertNoNestedDisplayOptions = (property) => {
      if (property.type === "collection" && Array.isArray(property.options)) {
        for (const option of property.options) {
          assert.ok(!option.displayOptions, `collection child ${property.name}.${option.name} must not define displayOptions`);
        }
      }
      if (property.type === "fixedCollection" && Array.isArray(property.options)) {
        for (const option of property.options) {
          if (!Array.isArray(option.values)) {
            continue;
          }
          for (const value of option.values) {
            assert.ok(!value.displayOptions, `fixedCollection child ${property.name}.${option.name}.${value.name} must not define displayOptions`);
          }
        }
      }
    };

    const triggerOnProperty = properties.find((property) => property.name === "triggerOn");
    assert.ok(triggerOnProperty, "missing triggerOn property");
    assert.strictEqual(triggerOnProperty.required, true);

    const refProperties = properties.filter((property) => property.name === "ref");
    assert.strictEqual(refProperties.length, 4);
    assert.deepStrictEqual(refProperties.map((property) => property.displayName), ["AI Tool Ref", "Trunk Ref", "Extensions Ref", "Queue Ref"]);
    for (const property of refProperties) {
      assert.strictEqual(property.required, true, "trigger ref should be required");
    }

    const staticCredentialsProperty = properties.find((property) => property.name === "staticCredentials");
    assert.ok(staticCredentialsProperty, "missing staticCredentials property");
    const credentialValues = staticCredentialsProperty.options[0].values;
    assert.strictEqual(credentialValues[0].required, true);
    assert.strictEqual(credentialValues[1].required, true);
    assert.strictEqual(credentialValues[2].required, true);

    const aiToolOptionsProperty = properties.find((property) => property.name === "aiToolOptions");
    assert.ok(aiToolOptionsProperty, "missing aiToolOptions property");
    assert.strictEqual(aiToolOptionsProperty.type, "collection");
    assert.ok(
      aiToolOptionsProperty.options.some((option) => option.name === "aiToolResponseTimeoutSeconds" && option.description),
      "aiToolOptions should describe aiToolResponseTimeoutSeconds fallback",
    );

    const trunkOptionsProperties = properties.filter((property) => property.name === "trunkOptions");
    assert.ok(trunkOptionsProperties.length >= 1, "missing trunkOptions property");
    assert.ok(trunkOptionsProperties.every((property) => property.type === "collection"));
    assert.ok(
      trunkOptionsProperties.some((property) => property.options.some((option) => option.name === "registrationExpires")),
      "trunkOptions should expose registrationExpires",
    );
    assert.ok(
      trunkOptionsProperties.some((property) => property.options.some((option) => option.name === "registerHeaders")),
      "trunkOptions should expose registerHeaders",
    );
    assert.ok(
      trunkOptionsProperties.some((property) => property.options.some((option) => option.name === "recordResponseTimeoutSeconds")),
      "trunkOptions should expose recordResponseTimeoutSeconds",
    );
    assert.ok(
      trunkOptionsProperties.some((property) => property.options.some((option) => option.name === "recordResponseTimeoutSeconds" && option.description)),
      "trunk recordResponseTimeoutSeconds should describe fallback",
    );
    const trunkHeadersOption = trunkOptionsProperties
      .flatMap((property) => property.options)
      .find((option) => option.name === "registerHeaders");
    assert.strictEqual(trunkHeadersOption.options[0].values[0].required, true);

    const extensionsOptionsProperties = properties.filter((property) => property.name === "extensionsOptions");
    assert.ok(extensionsOptionsProperties.length >= 1, "missing extensionsOptions property");
    assert.ok(extensionsOptionsProperties.every((property) => property.type === "collection"));
    assert.ok(
      extensionsOptionsProperties.some((property) => property.options.some((option) => option.name === "authTimeoutSeconds")),
      "extensionsOptions should expose authTimeoutSeconds",
    );
    assert.ok(
      extensionsOptionsProperties.some((property) => property.options.some((option) => option.name === "recordResponseTimeoutSeconds")),
      "extensionsOptions should expose recordResponseTimeoutSeconds",
    );
    assert.ok(
      extensionsOptionsProperties.some((property) => property.options.some((option) => option.name === "authTimeoutSeconds" && option.description)),
      "extensions authTimeoutSeconds should describe fallback",
    );
    assert.ok(
      extensionsOptionsProperties.some((property) => property.options.some((option) => option.name === "recordResponseTimeoutSeconds" && option.description)),
      "extensions recordResponseTimeoutSeconds should describe fallback",
    );
    assert.ok(!properties.some((property) => property.name === "extensionsAdvancedOptions"));
    assert.ok(!properties.some((property) => property.name === "registrationExpires"));

    const queueOptionsProperty = properties.find((property) => property.name === "queueOptions");
    assert.ok(queueOptionsProperty, "missing queueOptions property");
    assert.strictEqual(queueOptionsProperty.type, "collection");
    const queueExtensionsProperty = properties.find((property) => property.name === "queueExtensions");
    assert.ok(queueExtensionsProperty, "missing queueExtensions property");
    assert.strictEqual(queueExtensionsProperty.required, true);
    assert.ok(queueOptionsProperty.options.some((option) => option.name === "queueRetryPauseSeconds" && option.description));
    assert.ok(!queueOptionsProperty.options.some((option) => option.name === "queueResponseTimeoutSeconds"));
    assert.ok(!queueOptionsProperty.options.some((option) => option.name === "queueNoOperatorsGraceSeconds"));

    assert.ok(!properties.some((property) => property.name === "aiToolResponseTimeoutSeconds"));
    assert.ok(!properties.some((property) => property.name === "authTimeoutSeconds"));
    assert.ok(!properties.some((property) => property.name === "queueResponseTimeoutSeconds"));
    assert.ok(!properties.some((property) => property.displayName === "Advanced Options"));

    for (const property of properties) {
      assertNoNestedDisplayOptions(property);
    }
  });

  return { ok: true };
}

async function runTriggerNodeSmokeCases() {
  return {
    triggerPropertyContract: await testTriggerPropertyContract(),
    aiTrigger: await testAiTriggerNode(),
    triggerActivationRollback: await testTriggerActivationRollback(),
    trunkTrigger: await testTrunkTriggerNode(),
    trunkAuthTrigger: await testTrunkAuthTriggerNode(),
    extensionsTrigger: await testExtensionsTriggerNode(),
    queueTrigger: await testQueueTriggerNode(),
  };
}

module.exports = {
  runTriggerNodeSmokeCases,
};
