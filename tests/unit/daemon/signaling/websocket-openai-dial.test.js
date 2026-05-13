"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

class FakeSocket extends EventEmitter {
  end() {}
}

test("OutboundCallService uses a synthetic target for OpenAI websocket dial instead of an explicit URL", () => {
  const { OutboundCallService } = require("../../../../build-src/daemon/signaling/calls/outbound-call-service.js");

  let capturedInput = null;
  const service = new OutboundCallService(
    {
      createDial(input) {
        capturedInput = input;
        return {
          dialId: "dial-1",
          targets: input.targets,
          attemptLegIds: ["leg-1"],
        };
      },
    },
    () => [],
    () => [],
  );

  const result = service.createDialFromAction({
    callMode: "websocket",
    transportProfile: "openai_realtime",
    openaiApiKey: "test-key",
  });

  assert.strictEqual(result.dialId, "dial-1");
  assert.strictEqual(result.legId, "leg-1");
  assert.deepStrictEqual(capturedInput.targets, [{ kind: "opaque", value: "openai_realtime" }]);
  assert.strictEqual(capturedInput.metadata.transportProfile, "openai_realtime");
  assert.strictEqual(capturedInput.metadata.websocketUrl, "");
  assert.strictEqual("websocketAudioInputSampleRate" in capturedInput.metadata, false);
  assert.strictEqual("websocketAudioOutputSampleRate" in capturedInput.metadata, false);
});

test("OutboundCallService uses a synthetic target for Gemini Live websocket dial instead of an explicit URL", () => {
  const { OutboundCallService } = require("../../../../build-src/daemon/signaling/calls/outbound-call-service.js");

  let capturedInput = null;
  const service = new OutboundCallService(
    {
      createDial(input) {
        capturedInput = input;
        return {
          dialId: "dial-gemini",
          targets: input.targets,
          attemptLegIds: ["leg-gemini"],
        };
      },
    },
    () => [],
    () => [],
  );

  const result = service.createDialFromAction({
    callMode: "websocket",
    transportProfile: "gemini_live",
    geminiApiKey: "gemini-key",
  });

  assert.strictEqual(result.dialId, "dial-gemini");
  assert.strictEqual(result.legId, "leg-gemini");
  assert.deepStrictEqual(capturedInput.targets, [{ kind: "opaque", value: "gemini_live" }]);
  assert.strictEqual(capturedInput.metadata.transportProfile, "gemini_live");
  assert.strictEqual(capturedInput.metadata.websocketUrl, "");
  assert.strictEqual("websocketAudioInputSampleRate" in capturedInput.metadata, false);
});

test("OutboundCallService rejects generic websocket dial without websocketUrl", () => {
  const { OutboundCallService } = require("../../../../build-src/daemon/signaling/calls/outbound-call-service.js");

  const service = new OutboundCallService(
    {
      createDial() {
        throw new Error("createDial should not be called");
      },
    },
    () => [],
    () => [],
  );

  assert.throws(
    () => service.createDialFromAction({
      callMode: "websocket",
      transportProfile: "generic",
      websocketUrl: "",
    }),
    /Generic WebSocket dial requires websocketUrl/,
  );
});

test("OutboundCallService rejects deferred generic websocket dial", () => {
  const { OutboundCallService } = require("../../../../build-src/daemon/signaling/calls/outbound-call-service.js");

  const service = new OutboundCallService(
    {
      createDial() {
        throw new Error("createDial should not be called");
      },
    },
    () => [],
    () => [],
  );

  assert.throws(
    () => service.createDialFromAction({
      callMode: "websocket",
      transportProfile: "generic",
      websocketStartMode: "deferred",
      websocketUrl: "wss://example.invalid/socket",
    }),
    /websocketStartMode=deferred is not supported for transportProfile=generic/,
  );
});

test("SipPbxDaemon attachVoiceAgent activates deferred websocket sessions before waiting", async () => {
  const { SipPbxDaemon } = require("../../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../../build-src/daemon/core/request-context.js");

  const daemon = new SipPbxDaemon(".unused-voice-agent-attach.sock");
  let ensuredLegId = "";
  daemon.mediaService.ensureTransportEndpoint = async (legId) => {
    ensuredLegId = legId;
    return {};
  };

  const leg = daemon.legService.createLeg({
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });
  daemon.registerTriggerStream({
    kind: "voiceAgent",
    config: { legId: leg.legId, memoryText: "Known customer", tools: [] },
    socket: new FakeSocket(),
    write() {},
  });

  const context = new RequestContext();
  const attachPromise = daemon.attachVoiceAgent(context, leg.legId);
  setImmediate(() => context.cancel());
  const result = await attachPromise;

  assert.equal(ensuredLegId, leg.legId);
  assert.equal(daemon.legService.requireLeg(leg.legId).signalingDetails.websocketSessionActivated, true);
  assert.deepStrictEqual(result, {
    legId: leg.legId,
    eventType: "interrupted",
    reason: "request_cancelled",
  });
});

test("SipPbxDaemon attachVoiceAgent activates a deferred websocket leg that is already bridged", async () => {
  const { SipPbxDaemon } = require("../../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../../build-src/daemon/core/request-context.js");

  const daemon = new SipPbxDaemon(".unused-voice-agent-bridged-attach.sock");
  const peerLeg = daemon.legService.createLeg({
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });
  const voiceAgentLeg = daemon.legService.createLeg({
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });

  daemon.registerTriggerStream({
    kind: "voiceAgent",
    config: { legId: voiceAgentLeg.legId, memoryText: "Known customer", tools: [] },
    socket: new FakeSocket(),
    write() {},
  });

  try {
    await daemon.mediaService.bridgeLegs(peerLeg.legId, voiceAgentLeg.legId, {});

    const context = new RequestContext();
    const attachPromise = daemon.attachVoiceAgent(context, voiceAgentLeg.legId);
    setImmediate(() => context.cancel());
    const result = await attachPromise;

    assert.equal(daemon.legService.requireLeg(voiceAgentLeg.legId).signalingDetails.websocketSessionActivated, true);
    assert.equal(daemon.legService.requireLeg(voiceAgentLeg.legId).bridgePeerLegId, peerLeg.legId);
    assert.deepStrictEqual(result, {
      legId: voiceAgentLeg.legId,
      eventType: "interrupted",
      reason: "request_cancelled",
    });
  } finally {
    await daemon.mediaService.closeAll();
  }
});

test("SipPbxDaemon attachVoiceAgent rolls back an existing bridge when deferred transport startup fails", async () => {
  const { SipPbxDaemon } = require("../../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../../build-src/daemon/core/request-context.js");

  const daemon = new SipPbxDaemon(".unused-voice-agent-bridged-failure.sock");
  const peerLeg = daemon.legService.createLeg({
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });
  const voiceAgentLeg = daemon.legService.createLeg({
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {
      transportProfile: "openai_realtime",
      websocketStartMode: "deferred",
      websocketSessionActivated: false,
    },
  });

  daemon.registerTriggerStream({
    kind: "voiceAgent",
    config: { legId: voiceAgentLeg.legId, memoryText: "Known customer", tools: [] },
    socket: new FakeSocket(),
    write() {},
  });

  try {
    await daemon.mediaService.bridgeLegs(peerLeg.legId, voiceAgentLeg.legId, {});

    const originalEnsure = daemon.mediaService.executionPlane.ensureTransportEndpoint;
    daemon.mediaService.executionPlane.ensureTransportEndpoint = async (legId) => {
      if (legId === voiceAgentLeg.legId) {
        throw new Error("bridge migration failed");
      }
      return await originalEnsure.call(daemon.mediaService.executionPlane, legId);
    };

    await assert.rejects(
      () => daemon.attachVoiceAgent(new RequestContext(), voiceAgentLeg.legId),
      /bridge migration failed/,
    );

    assert.equal(daemon.legService.requireLeg(voiceAgentLeg.legId).bridgePeerLegId, undefined);
    assert.equal(daemon.legService.requireLeg(peerLeg.legId).bridgePeerLegId, undefined);
    assert.equal(
      daemon.legService.requireLeg(voiceAgentLeg.legId).signalingDetails.websocketSessionActivated,
      false,
    );
  } finally {
    await daemon.mediaService.closeAll();
  }
});

test("SipPbxDaemon voice agent publishes tool and memory events and forwards tool results", async () => {
  const { SipPbxDaemon } = require("../../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../../build-src/daemon/core/request-context.js");

  const daemon = new SipPbxDaemon(".unused-voice-agent-roundtrip.sock");
  const published = [];
  const sentPayloads = [];
  daemon.mediaService.sendWebSocketJson = async (_legId, payload) => {
    sentPayloads.push(payload);
    return true;
  };

  try {
    const leg = daemon.legService.createLeg({
      direction: "outbound",
      transportType: "websocket",
      signalingDetails: {
        transportProfile: "openai_realtime",
        websocketStartMode: "immediate",
        websocketSessionActivated: true,
      },
    });
    daemon.registerTriggerStream({
      kind: "voiceAgent",
      config: {
        legId: leg.legId,
        memoryText: "VIP caller",
        needsInputTranscription: true,
        tools: [{
          name: "lookup_customer",
          description: "Lookup customer details",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        }],
      },
      socket: new FakeSocket(),
      write(frame) {
        published.push(frame);
      },
    });

    const context = new RequestContext();
    const attachPromise = daemon.attachVoiceAgent(context, leg.legId);
    await new Promise((resolve) => setImmediate(resolve));

    await daemon.handleVoiceAgentTransportEvent(leg.legId, {
      type: "user_transcript",
      eventType: "conversation.item.input_audio_transcription.completed",
      text: "Where is my order?",
    });
    await daemon.handleVoiceAgentTransportEvent(leg.legId, {
      type: "tool_call",
      eventType: "response.function_call_arguments.done",
      voiceAgentRequestId: "req-1",
      toolName: "lookup_customer",
      argumentsJson: "{\"id\":\"42\"}",
    });
    await daemon.respondVoiceAgentToolCall({
      voiceAgentRequestId: "req-1",
      outputText: "{\"status\":\"shipped\"}",
    });
    await daemon.handleVoiceAgentTransportEvent(leg.legId, {
      type: "assistant_transcript",
      eventType: "response.audio_transcript.done",
      text: "Let me check that for you.",
    });

    context.cancel();
    const result = await attachPromise;

    assert.deepStrictEqual(result, {
      legId: leg.legId,
      eventType: "interrupted",
      reason: "request_cancelled",
    });
    assert.deepStrictEqual(published, [
      {
        kind: "voiceAgent",
        branch: "ToolCall",
        payload: {
          legId: leg.legId,
          voiceAgentRequestId: "req-1",
          toolName: "lookup_customer",
          argumentsJson: "{\"id\":\"42\"}",
        },
      },
      {
        kind: "voiceAgent",
        branch: "MemoryTurn",
        payload: {
          legId: leg.legId,
          userText: "Where is my order?",
          assistantText: "Let me check that for you.",
          toolCalls: [{
            voiceAgentRequestId: "req-1",
            toolName: "lookup_customer",
            argumentsJson: "{\"id\":\"42\"}",
            outputText: "{\"status\":\"shipped\"}",
            isError: false,
          }],
        },
      },
    ]);
    assert.deepStrictEqual(sentPayloads, [
      {
        type: "session.update",
        session: {
          type: "realtime",
          instructions: "Memory context:\nVIP caller",
          audio: {
            input: {
              transcription: {
                model: "gpt-4o-transcribe",
              },
            },
          },
          tools: [{
            type: "function",
            name: "lookup_customer",
            description: "Lookup customer details",
            parameters: { type: "object", properties: { id: { type: "string" } } },
          }],
        },
      },
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "req-1",
          output: "{\"status\":\"shipped\"}",
        },
      },
      {
        type: "response.create",
      },
    ]);
  } finally {
    await daemon.stop();
  }
});

test("SipPbxDaemon rejects late Gemini tool attach on already activated session", async () => {
  const { SipPbxDaemon } = require("../../../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../../../build-src/daemon/core/request-context.js");

  const daemon = new SipPbxDaemon(".unused-gemini-late-attach.sock");
  try {
    const leg = daemon.legService.createLeg({
      direction: "outbound",
      transportType: "websocket",
      signalingDetails: {
        transportProfile: "gemini_live",
        websocketStartMode: "immediate",
        websocketSessionActivated: true,
      },
    });
    daemon.registerTriggerStream({
      kind: "voiceAgent",
      config: {
        legId: leg.legId,
        tools: [{
          name: "lookup_order",
          description: "Lookup order status",
          parameters: { type: "object", properties: { orderId: { type: "string" } } },
        }],
      },
      socket: new FakeSocket(),
      write() {},
    });

    await assert.rejects(
      () => daemon.attachVoiceAgent(new RequestContext(), leg.legId),
      /gemini_live tools require websocketStartMode=deferred/,
    );
  } finally {
    await daemon.stop();
  }
});

test("WebSocketSignalingService resolves OpenAI realtime URL when no explicit websocket URL is set", async () => {
  const { WebSocketSignalingService } = require("../../../../build-src/daemon/signaling/websocket/websocket-signaling-service.js");
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");
  const { DialService } = require("../../../../build-src/daemon/dials/dial-service.js");

  const legService = new LegService(new MapRegistry());
  const dialService = new DialService(new MapRegistry(), legService);
  const answeredLegIds = [];
  const signaling = new WebSocketSignalingService({
    legService,
    dialService,
    dialRegistry: { values: () => [] },
    ensureMediaTransportEndpoint: async () => ({}),
  });
  signaling.answerLeg = async (legId) => {
    answeredLegIds.push(legId);
    return { legId };
  };

  const leg = legService.createLeg({
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {},
  });

  signaling.handleAttemptStarted({
    dialId: "dial-1",
    mode: "websocket",
    metadata: {
      transportProfile: "openai_realtime",
      websocketUrl: "",
      openaiRealtimeModel: "gpt-4o-realtime-preview",
      openaiApiKey: "test-key",
    },
  }, leg.legId, "");

  await new Promise((resolve) => setImmediate(resolve));
  const updatedLeg = legService.requireLeg(leg.legId);
  assert.strictEqual(
    updatedLeg.signalingDetails.websocketUrl,
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
  );
  assert.deepStrictEqual(updatedLeg.signalingDetails.websocketHeadersJson, {
    Authorization: "Bearer test-key",
  });
  assert.deepStrictEqual(answeredLegIds, [leg.legId]);
});

test("WebSocketSignalingService resolves Gemini Live URL and headers", async () => {
  const { WebSocketSignalingService } = require("../../../../build-src/daemon/signaling/websocket/websocket-signaling-service.js");
  const { MapRegistry } = require("../../../../build-src/shared/map-registry.js");
  const { LegService } = require("../../../../build-src/daemon/legs/leg-service.js");
  const { DialService } = require("../../../../build-src/daemon/dials/dial-service.js");

  const legService = new LegService(new MapRegistry());
  const dialService = new DialService(new MapRegistry(), legService);
  const signaling = new WebSocketSignalingService({
    legService,
    dialService,
    dialRegistry: { values: () => [] },
    ensureMediaTransportEndpoint: async () => ({}),
  });
  signaling.answerLeg = async () => ({ legId: "ok" });

  const leg = legService.createLeg({
    direction: "outbound",
    transportType: "websocket",
    signalingDetails: {},
  });

  signaling.handleAttemptStarted({
    dialId: "dial-gemini-1",
    mode: "websocket",
    metadata: {
      transportProfile: "gemini_live",
      websocketUrl: "",
      geminiApiKey: "gemini-key",
      geminiLiveApiVersion: "v1beta",
    },
  }, leg.legId, "");

  await new Promise((resolve) => setImmediate(resolve));
  const updatedLeg = legService.requireLeg(leg.legId);
  assert.strictEqual(
    updatedLeg.signalingDetails.websocketUrl,
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  );
  assert.deepStrictEqual(updatedLeg.signalingDetails.websocketHeadersJson, {
    "x-goog-api-key": "gemini-key",
  });
});
