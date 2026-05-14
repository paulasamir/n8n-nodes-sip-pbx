#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  sipPbxNodeModulePath,
  createExecuteContext,
  withPatchedRuntime,
} = require("../lib/node-smoke-lib");

async function testCallWaitForEventRouting() {
  const seen = {};
  const fakeRuntime = {
    async waitForLegEvent(legId, options) {
      seen.legId = legId;
      seen.options = options;
      return {
        legId: Array.isArray(legId) ? legId[0] : legId,
        eventType: "dtmf",
        output: "matched",
        matchedPattern: "123",
        matchedLabel: "Sales",
        digits: "123",
      };
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const node = new SipPbx();
    Object.assign(node, createExecuteContext({
      operation: "call.wait",
      timeoutSeconds: 20,
      callOptions: { interdigitTimeoutSeconds: 0.8 },
      waitDtmfFallbackEnabled: true,
      waitDtmfMultiDigitFallbackEnabled: true,
      dtmfTerminatorDigit: "#",
      rules: {
        item: [
          { pattern: "123", label: "Sales" },
          { pattern: "456", label: "Support" },
        ],
      },
    }, [{ json: { legId: "leg-call-1" } }]));
    const outputs = await node.execute();
    assert.strictEqual(outputs.length, 6);
    assert.strictEqual(outputs[0][0].json.eventType, "dtmf");
    assert.strictEqual(outputs[0][0].json.digits, undefined);
    assert.strictEqual(outputs[0][0].json.legId, "leg-call-1");
    assert.strictEqual(outputs[0][0].json.sipPbx.legId, "leg-call-1");
  });

  assert.strictEqual(seen.legId, "leg-call-1");
  assert.strictEqual(seen.options.rules.length, 2);
  return { matchedRuleCount: seen.options.rules.length };
}

async function testCallWaitForEventRoutingMultipleLegs() {
  const seen = {};
  const fakeRuntime = {
    async waitForLegEvent(legIds, options) {
      seen.legIds = legIds;
      seen.options = options;
      return {
        legId: Array.isArray(legIds) ? legIds[1] : legIds,
        eventType: "ended",
        output: "ended",
        reason: "hangup",
      };
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const node = new SipPbx();
    Object.assign(node, createExecuteContext({
      operation: "call.wait",
      legIds: { item: [{ legId: "leg-call-1" }, { legId: "leg-call-2" }] },
      timeoutSeconds: 20,
      rules: {
        item: [
          { pattern: "123", label: "Sales" },
        ],
      },
    }, [{ json: {} }]));
    const outputs = await node.execute();
    assert.strictEqual(outputs[2][0].json.legId, "leg-call-2");
    assert.strictEqual(outputs[2][0].json.reason, "hangup");
  });

  assert.deepStrictEqual(seen.legIds, ["leg-call-1", "leg-call-2"]);
  return { legCount: seen.legIds.length };
}

async function testDialWaitForEventRouting() {
  const fakeRuntime = {
    async waitForDialEvent(dialId, options) {
      assert.deepStrictEqual(options.waitEventOutputs, ["ringing", "rejected"]);
      return {
        eventType: "rejected",
        dialId,
        legId: "leg-attempt-1",
        stillDialingLegCount: 1,
        reason: "busy",
      };
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const node = new SipPbx();
    Object.assign(node, createExecuteContext({
      resource: "dial",
      operation: "dial.wait",
      dialTimeoutSeconds: 15,
      waitEventOutputs: [["ringing", "rejected"]],
    }, [{ json: { dialId: "dial-1" } }]));
    const outputs = await node.execute();
    assert.strictEqual(outputs.length, 5);
    assert.strictEqual(outputs[1][0].json.dialId, "dial-1");
    assert.strictEqual(outputs[1][0].json.legId, "leg-attempt-1");
    assert.strictEqual(outputs[1][0].json.stillDialingLegCount, 1);
  });

  return { ok: true };
}

async function testDialWaitForEventRoutingMultipleDials() {
  const seen = {};
  const fakeRuntime = {
    async waitForDialEvent(dialIds, options) {
      seen.dialIds = dialIds;
      assert.deepStrictEqual(options.waitEventOutputs, ["ringing"]);
      return {
        eventType: "answered",
        dialId: Array.isArray(dialIds) ? dialIds[1] : dialIds,
        legId: "leg-attempt-2",
        stillDialingLegCount: 0,
      };
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const node = new SipPbx();
    Object.assign(node, createExecuteContext({
      resource: "dial",
      operation: "dial.wait",
      dialIds: { item: [{ dialId: "dial-1" }, { dialId: "dial-2" }] },
      dialTimeoutSeconds: 15,
      waitEventOutputs: [["ringing"]],
    }, [{ json: {} }]));
    const outputs = await node.execute();
    assert.strictEqual(outputs[1][0].json.dialId, "dial-2");
    assert.strictEqual(outputs[1][0].json.legId, "leg-attempt-2");
  });

  assert.deepStrictEqual(seen.dialIds, ["dial-1", "dial-2"]);
  return { ok: true };
}

async function testQueueAndAuthResponses() {
  const seen = { auth: [], record: [], recording: [], stats: null };
  const fakeRuntime = {
    async respondToAuth(input) {
      seen.auth.push(input);
      return { authRequestId: input.authRequestId };
    },
    async respondToRecord(input) {
      seen.record.push(input);
      if (input.active) {
        return {
          recordRequestId: input.recordRequestId,
          active: true,
          legId: "leg-record-explicit",
          filePath: input.recordFilePath,
          durationMs: 1234,
          bytesProduced: 256,
        };
      }
      return { recordRequestId: input.recordRequestId, active: false };
    },
    async startGlobalRecording(input) {
      seen.recording.push(input);
      return {
        legId: input.legId,
        filePath: input.recordFilePath,
        durationMs: 4321,
        bytesProduced: 512,
      };
    },
    async getQueueStats(input) {
      seen.stats = input;
      return {
        ref: input.ref || "support",
        ...(input.legId ? { legId: input.legId } : {}),
        size: 3,
        averageWaitSeconds: 1,
        completedCount: 10,
        updatedAt: 1,
        position: 1,
        estimatedAnswerSeconds: 4,
      };
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const authNode = new SipPbx();
    Object.assign(authNode, createExecuteContext({
      resource: "respond",
      operation: "respond.toAuth",
      authAction: "allow",
      extension: "",
    }, [{ json: { username: "100" }, _sipPbxResponseHandle: { kind: "auth", handle: "auth-1" } }]));
    const authOutputs = await authNode.execute();
    assert.strictEqual(authOutputs[0][0].json.authRequestId, "auth-1");
    assert.deepStrictEqual(authOutputs[0][0]._sipPbxResponseHandle, { kind: "auth", handle: "auth-1" });

    const authExplicitNode = new SipPbx();
    Object.assign(authExplicitNode, createExecuteContext({
      resource: "respond",
      operation: "respond.toAuth",
      respondOptions: { requestId: "auth-explicit" },
      authAction: "allow",
      extension: "",
    }, [{ json: { username: "100" } }]));
    const authExplicitOutputs = await authExplicitNode.execute();
    assert.strictEqual(authExplicitOutputs[0][0].json.authRequestId, "auth-explicit");

    const recordNode = new SipPbx();
    Object.assign(recordNode, createExecuteContext({
      resource: "respond",
      operation: "respond.toRecord",
      respondOptions: { requestId: "record-explicit" },
      active: false,
    }, [{ json: {} }]));
    const recordOutputs = await recordNode.execute();
    assert.strictEqual(recordOutputs[0][0].json.recordRequestId, "record-explicit");

    const recordWaitNode = new SipPbx();
    Object.assign(recordWaitNode, createExecuteContext({
      resource: "respond",
      operation: "respond.toRecord",
      respondOptions: { requestId: "record-wait", recordWavSampleRate: 8000, recordWavBitDepth: 16 },
      active: true,
      recordFilePath: "recordings/call.wav",
      recordFileFormat: "wav",
      recordSplitChannels: true,
      waitForRecordingCompletion: true,
    }, [{ json: {} }]));
    const recordWaitOutputs = await recordWaitNode.execute();
    assert.strictEqual(recordWaitOutputs[0][0].json.recordRequestId, "record-wait");
    assert.strictEqual(recordWaitOutputs[0][0].json.filePath, "recordings/call.wav");
    assert.strictEqual(recordWaitOutputs[0][0].json.durationMs, 1234);
    assert.strictEqual(recordWaitOutputs[0][0].json.sipPbx.mediaId, undefined);

    const directRecordNode = new SipPbx();
    Object.assign(directRecordNode, createExecuteContext({
      resource: "recording",
      operation: "recording.start",
      recordFilePath: "recordings/direct.wav",
      recordFileFormat: "wav",
      recordSplitChannels: true,
      waitForRecordingCompletion: true,
      recordingOptions: { legId: "leg-record-direct", recordWavSampleRate: 16000, recordWavBitDepth: 16 },
    }, [{ json: {} }]));
    const directRecordOutputs = await directRecordNode.execute();
    assert.strictEqual(directRecordOutputs[0][0].json.legId, "leg-record-direct");
    assert.strictEqual(directRecordOutputs[0][0].json.filePath, "recordings/direct.wav");
    assert.strictEqual(directRecordOutputs[0][0].json.durationMs, 4321);

    const statsNode = new SipPbx();
    Object.assign(statsNode, createExecuteContext({
      resource: "queue",
      operation: "queue.getStats",
      queueStatsTarget: "legId",
      queueOptions: { legId: "leg-queue-1" },
    }, [{ json: {} }]));
    const statsOutputs = await statsNode.execute();
    assert.strictEqual(statsOutputs[0][0].json.position, 1);
    assert.strictEqual(statsOutputs[0][0].json.averageWaitSeconds, 1);
    assert.strictEqual(statsOutputs[0][0].json.legId, "leg-queue-1");
    assert.strictEqual(statsOutputs[0][0].json.sipPbx.legId, "leg-queue-1");
  });

  assert.deepStrictEqual(seen.auth[0], {
    authRequestId: "auth-1",
    authAction: "allow",
    password: "",
    extension: "",
    statusCode: 401,
    reason: "",
  });
  assert.strictEqual(seen.auth[1].authRequestId, "auth-explicit");
  assert.deepStrictEqual(seen.record[0], {
    recordRequestId: "record-explicit",
    active: false,
  });
  assert.deepStrictEqual(seen.record[1], {
    recordRequestId: "record-wait",
    active: true,
    recordFilePath: "recordings/call.wav",
    recordFileFormat: "wav",
    recordWavSampleRate: 8000,
    recordWavBitDepth: 16,
    recordSplitChannels: true,
    waitForRecordingCompletion: true,
  });
  assert.deepStrictEqual(seen.recording[0], {
    legId: "leg-record-direct",
    recordFilePath: "recordings/direct.wav",
    recordFileFormat: "wav",
    recordWavSampleRate: 16000,
    recordWavBitDepth: 16,
    recordSplitChannels: true,
    waitForRecordingCompletion: true,
  });
  assert.deepStrictEqual(seen.stats, {
    queueStatsTarget: "legId",
    ref: "",
    legId: "leg-queue-1",
  });
  return { ok: true };
}

async function testDialMakeAndBridge() {
  const seen = { makeDial: [], bridge: null, unbridge: null };
  const fakeRuntime = {
    async makeDial(input) {
      seen.makeDial.push(input);
      if (input.callMode === "extension" && Array.isArray(input.extensionNumbers) && input.extensionNumbers.includes("999")) {
        const error = new Error("Extension dial requires active registrations");
        error.code = "invalid_dial_targets";
        throw error;
      }
      if (input.callMode === "direct") {
        return { dialId: "dial-created-1", legId: "leg-created-1" };
      }
      return { dialId: "dial-created-1" };
    },
    async bridge(legAId, legBId, input) {
      seen.bridge = { legAId, legBId, input };
      return { legAId, legBId };
    },
    async unbridge(legId) {
      seen.unbridge = legId;
      return { origLegId: legId, peerLegId: "leg-peer-1" };
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const makeDialNode = new SipPbx();
    Object.assign(makeDialNode, createExecuteContext({
      resource: "dial",
      operation: "dial.make",
      callMode: "extension",
      callStrategy: "parallel",
      extensionNumbers: "100, 101",
      dialOptions: {
        callerNumber: "+1000000",
        callerName: "Alice",
      },
    }, [{ json: {} }]));
    const makeDialOutputs = await makeDialNode.execute();
    assert.strictEqual(makeDialOutputs[0][0].json.dialId, "dial-created-1");
    assert.deepStrictEqual(makeDialOutputs[1], []);

    const unavailableExtensionNode = new SipPbx();
    Object.assign(unavailableExtensionNode, createExecuteContext({
      resource: "dial",
      operation: "dial.make",
      callMode: "extension",
      callStrategy: "parallel",
      extensionNumbers: "999",
      dialOptions: {
        callerNumber: "+1999000",
      },
    }, [{ json: {} }]));
    const unavailableOutputs = await unavailableExtensionNode.execute();
    assert.deepStrictEqual(unavailableOutputs[0], []);
    assert.strictEqual(unavailableOutputs[1][0].json.reason, "no_available_endpoints");
    assert.deepStrictEqual(unavailableOutputs[1][0].json.extensionNumbers, ["999"]);

    const makeDirectDialNode = new SipPbx();
    Object.assign(makeDirectDialNode, createExecuteContext({
      resource: "dial",
      operation: "dial.make",
      callMode: "direct",
      callStrategy: "parallel",
      destination: "200",
      dialOptions: {
        callerNumber: "+2000000",
        callerName: "Bob",
      },
    }, [{ json: {} }], {
      credentials: {
        sipPbxExternal: {
          sipServer: "sip.example.test",
          port: 5061,
          transport: "udp",
          username: "alice",
          password: "secret",
        },
      },
    }));
    const makeDirectDialOutputs = await makeDirectDialNode.execute();
    assert.strictEqual(makeDirectDialOutputs[0][0].json.dialId, "dial-created-1");
    assert.strictEqual(makeDirectDialOutputs[0][0].json.legId, "leg-created-1");
    assert.strictEqual(makeDirectDialOutputs[0][0].json.sipPbx.legId, "leg-created-1");

    const makeOpenAiDialNode = new SipPbx();
    Object.assign(makeOpenAiDialNode, createExecuteContext({
      resource: "dial",
      operation: "dial.make",
      callMode: "websocket",
      transportProfile: "openai_realtime",
      dialOptions: {
        openaiRealtimeModel: "gpt-realtime-test",
        openaiRealtimeVoice: "verse",
        openaiRealtimeInputTranscriptionModel: "gpt-realtime-whisper",
        openaiRealtimePromptVariablesJson: "{\"customer\":\"Alice\"}",
      },
    }, [{ json: {} }], {
      credentials: {
        openAiApi: {
          apiKey: "sk-test",
        },
      },
    }));
    const makeOpenAiDialOutputs = await makeOpenAiDialNode.execute();
    assert.strictEqual(makeOpenAiDialOutputs[0][0].json.dialId, "dial-created-1");

    const bridgeNode = new SipPbx();
    Object.assign(bridgeNode, createExecuteContext({
      resource: "call",
      operation: "call.bridge",
      legAId: "leg-a",
      legBId: "leg-b",
      callOptions: {
        emitDtmfEvents: true,
        relayDtmf: "auto",
      },
    }, [{ json: {} }]));
    const bridgeOutputs = await bridgeNode.execute();
    assert.strictEqual(bridgeOutputs[0][0].json.legIdA, "leg-a");
    assert.strictEqual(bridgeOutputs[0][0].json.legIdB, "leg-b");
    assert.strictEqual(bridgeOutputs[0][0].json.sipPbx, undefined);

    const unbridgeNode = new SipPbx();
    Object.assign(unbridgeNode, createExecuteContext({
      resource: "call",
      operation: "call.unbridge",
      callOptions: { legId: "leg-a" },
    }, [{ json: {} }]));
    const unbridgeOutputs = await unbridgeNode.execute();
    assert.strictEqual(unbridgeOutputs[0][0].json.legId, "leg-a");
    assert.strictEqual(unbridgeOutputs[1][0].json.legId, "leg-peer-1");
  });

  assert.deepStrictEqual(seen.makeDial[0].extensionNumbers, ["100", "101"]);
  assert.strictEqual(seen.makeDial[0].extensionListOnlyFreeEndpoints, true);
  assert.strictEqual(seen.makeDial[0].ref, undefined);
  assert.strictEqual(seen.makeDial[1].sipCredentials.username, "alice");
  assert.strictEqual(seen.makeDial[1].sipCredentials.transport, "udp");
  assert.strictEqual(seen.makeDial[2].openaiRealtimeModel, "gpt-realtime-test");
  assert.strictEqual(seen.makeDial[2].openaiRealtimeVoice, "verse");
  assert.strictEqual(seen.makeDial[2].openaiRealtimeInputTranscriptionModel, "gpt-realtime-whisper");
  assert.deepStrictEqual(seen.makeDial[2].openaiRealtimePromptVariablesJson, { customer: "Alice" });
  assert.strictEqual(seen.bridge.input.relaySignaling, undefined);
  assert.strictEqual(seen.unbridge, "leg-a");
  return { ok: true };
}

async function testOperationOnlyAnswerRouting() {
  const seen = { answerLegId: null };
  const fakeRuntime = {
    async answer(legId) {
      seen.answerLegId = legId;
      return { legId };
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const node = new SipPbx();
    Object.assign(node, createExecuteContext({
      operation: "call.answer",
      callOptions: { legId: "leg-answer-1" },
    }, [{ json: {} }]));
    const outputs = await node.execute();
    assert.strictEqual(outputs[0][0].json.legId, "leg-answer-1");
  });

  assert.strictEqual(seen.answerLegId, "leg-answer-1");
  return { operationOnlyAnswerOk: true };
}

async function testActionOperationContract() {
  const expectedOperationsByResource = {
    call: ["call.ringing", "call.answer", "call.hangup", "call.bridge", "call.unbridge", "call.wait"],
    dial: ["dial.make", "dial.break", "dial.wait"],
    media: ["media.playAudio", "media.playTone", "media.recordAudio", "media.stopMedia", "media.wait", "media.sendDtmf"],
    queue: ["queue.putLeg", "queue.setCallback", "queue.getStats"],
    recording: ["recording.start", "recording.control"],
    ai: ["ai.attachVoiceAgent", "ai.invokeAiTool"],
    respond: ["respond.toRecord", "respond.toAuth", "respond.toAiTool"],
  };

  await withPatchedRuntime({}, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const node = new SipPbx();
    const properties = node.description.properties;
    const propertyByName = new Map(properties.map((property) => [property.name, property]));
    const resourceProperty = propertyByName.get("resource");
    assert.deepStrictEqual(
      resourceProperty.options.map((option) => option.value),
      ["call", "dial", "media", "queue", "recording", "ai", "respond"],
    );
    assert.strictEqual(
      resourceProperty.options.find((option) => option.value === "recording").name,
      "Global recording",
    );
    const operationProperties = properties.filter((property) => property.name === "operation");
    assert.strictEqual(operationProperties.length, Object.keys(expectedOperationsByResource).length);
    for (const property of operationProperties) {
      const [resource] = property.displayOptions.show.resource;
      assert.deepStrictEqual(
        property.options.map((option) => option.value),
        expectedOperationsByResource[resource],
      );
      assert.strictEqual(property.default, "");
      assert.strictEqual(property.required, true);
    }
    const queueOperationIndex = operationProperties.findIndex((property) => property.displayOptions.show.resource.includes("queue"));
    const recordingOperationIndex = operationProperties.findIndex((property) => property.displayOptions.show.resource.includes("recording"));
    const aiOperationIndex = operationProperties.findIndex((property) => property.displayOptions.show.resource.includes("ai"));
    const respondOperationIndex = operationProperties.findIndex((property) => property.displayOptions.show.resource.includes("respond"));
    assert.ok(queueOperationIndex >= 0, "missing queue operation property");
    assert.ok(recordingOperationIndex >= 0, "missing recording operation property");
    assert.ok(aiOperationIndex >= 0, "missing ai operation property");
    assert.ok(respondOperationIndex >= 0, "missing respond operation property");
    assert.ok(recordingOperationIndex > queueOperationIndex, "recording operations should be below queue operations");
    assert.ok(aiOperationIndex > recordingOperationIndex, "ai operations should be below recording operations");
    assert.ok(respondOperationIndex > aiOperationIndex, "respond operations should be below ai operations");
    const recordingOperationProperty = operationProperties.find((property) => property.displayOptions.show.resource.includes("recording"));
    assert.deepStrictEqual(
      recordingOperationProperty.options.map((option) => option.name),
      ["Start recording", "Control recording"],
    );
    const respondOperationProperty = operationProperties.find((property) => property.displayOptions.show.resource.includes("respond"));
    assert.ok(
      respondOperationProperty.options.some((option) => option.value === "respond.toRecord" && option.name === "Respond to recording"),
      "respond recording operation label should be updated",
    );
    for (const name of ["callOptions", "dialOptions", "mediaOptions", "respondOptions", "queueOptions", "recordingOptions", "aiOptions"]) {
      const matching = properties.filter((property) => property.name === name);
      assert.ok(matching.length > 0, `missing property: ${name}`);
      for (const property of matching) {
        assert.strictEqual(property.displayName, "Options");
        assert.strictEqual(property.type, "collection");
        assert.strictEqual(property.placeholder, "Add Option");
        assert.strictEqual(property.typeOptions, undefined);
        assert.ok(property.options.length >= 1, `${name} should have option fields`);
        for (const option of property.options) {
          assert.notStrictEqual(option.required, true, `${name}.${option.name} should be an optional override`);
        }
      }
    }
    const extensionRefProperty = properties.find((property) => property.name === "ref" && property.displayOptions?.show?.resource?.includes("dial") && property.displayOptions?.show?.callMode?.includes("extension"));
    assert.strictEqual(extensionRefProperty, undefined, "extension dial must not expose ref");
    const extensionNumbersProperty = propertyByName.get("extensionNumbers");
    assert.ok(extensionNumbersProperty.description.includes("across all extensions refs in the current flow"), "extension list hint should explain flow-local cross-ref dialing");
    assert.ok(extensionNumbersProperty.description.includes("matching endpoint"), "extension list hint should explain endpoint-level dialing");
    assert.strictEqual(propertyByName.get("openaiRealtimeOptions"), undefined, "openaiRealtimeOptions should not exist");
    for (const name of ["legIdOptions", "dialIdOptions", "mediaLegIdOptions", "requestIdOptions", "stopMediaIdOptions", "stopMediaLegIdOptions"]) {
      assert.strictEqual(propertyByName.get(name), undefined, `${name} should not exist`);
    }
    for (const name of ["callMode", "destination", "extensionNumbers", "transportProfile", "sourceType", "recordOutputType", "stopMediaTarget", "queueStatsTarget", "authAction", "legAId", "legBId"]) {
      const property = propertyByName.get(name);
      assert.ok(property, `missing property: ${name}`);
      assert.strictEqual(property.required, true, `${name} should be required`);
    }
    const sendDtmfOptionsIndex = properties.findIndex((property) => property.name === "mediaOptions" && property.displayOptions?.show?.operation?.includes("media.sendDtmf"));
    assert.ok(sendDtmfOptionsIndex >= 0, "missing mediaOptions for sendDtmf");
    const queueTargetIndex = properties.findIndex((property) => property.name === "queueStatsTarget");
    const queueRefIndex = properties.findIndex((property) => property.name === "ref" && property.displayOptions?.show?.resource?.includes("queue") && property.displayOptions?.show?.operation?.includes("queue.getStats"));
    assert.ok(queueTargetIndex >= 0, "missing queueStatsTarget");
    assert.ok(queueRefIndex >= 0, "missing queue ref");
    assert.ok(queueRefIndex > queueTargetIndex, "queue ref should be placed below Target");
    const rulesProperty = propertyByName.get("rules");
    assert.ok(rulesProperty, "missing property: rules");
    assert.strictEqual(rulesProperty.options[0].values[0].required, true);
    assert.strictEqual(rulesProperty.options[0].values[1].required, true);
    const queueRefProperty = properties.find((property) => property.name === "ref" && property.displayOptions?.show?.resource?.includes("queue"));
    assert.ok(queueRefProperty, "missing queue ref property");
    assert.strictEqual(queueRefProperty.displayName, "Queue Ref");
    assert.strictEqual(queueRefProperty.required, true, "queue ref should be required");
    const dialOptionCollections = properties.filter((property) => property.name === "dialOptions");
    const makeSipDialOptions = dialOptionCollections.find((property) => property.displayOptions?.show?.operation?.includes("dial.make") && property.displayOptions?.show?.callMode?.includes("trunk"));
    const breakDialOptions = dialOptionCollections.find((property) => property.displayOptions?.show?.operation?.includes("dial.break"));
    const openAiDialOptions = dialOptionCollections.find((property) => property.displayOptions?.show?.transportProfile?.includes("openai_realtime"));
    const geminiDialOptions = dialOptionCollections.find((property) => property.displayOptions?.show?.transportProfile?.includes("gemini_live"));
    const genericDialOptions = dialOptionCollections.find((property) => property.displayOptions?.show?.transportProfile?.includes("generic"));
    const websocketStartModeProperty = propertyByName.get("websocketStartMode");
    assert.ok(makeSipDialOptions, "missing dial.make SIP dialOptions");
    assert.ok(breakDialOptions, "missing dial.break dialOptions");
    assert.ok(openAiDialOptions, "missing OpenAI dialOptions");
    assert.ok(geminiDialOptions, "missing Gemini dialOptions");
    assert.ok(genericDialOptions, "missing generic dialOptions");
    assert.deepStrictEqual(websocketStartModeProperty.displayOptions.show.transportProfile, ["openai_realtime", "gemini_live"]);
    assert.ok(makeSipDialOptions.options.some((option) => option.name === "callerNumber"));
    assert.ok(makeSipDialOptions.options.some((option) => option.name === "callerName"));
    assert.ok(makeSipDialOptions.options.some((option) => option.name === "customSipHeaders"));
    const freeEndpointsOption = makeSipDialOptions.options.find((option) => option.name === "extensionListOnlyFreeEndpoints");
    assert.ok(freeEndpointsOption, "missing Only Free Endpoints option");
    assert.strictEqual(freeEndpointsOption.default, true);
    assert.ok(!makeSipDialOptions.options.some((option) => option.name === "dialId"));
    assert.ok(breakDialOptions.options.some((option) => option.name === "dialId"));
    assert.ok(!breakDialOptions.options.some((option) => option.name === "callerNumber"));
    assert.ok(openAiDialOptions.options.some((option) => option.name === "openaiRealtimeModel"));
    assert.ok(geminiDialOptions.options.some((option) => option.name === "geminiLiveModel"));
    assert.ok(genericDialOptions.options.some((option) => option.name === "websocketHeadersJson"));
    assert.strictEqual(propertyByName.get("customSipHeaders"), undefined);
    assert.strictEqual(propertyByName.get("callerNumber"), undefined);
    assert.strictEqual(propertyByName.get("callerName"), undefined);
    assert.strictEqual(propertyByName.get("emitDtmfEvents"), undefined);
    assert.strictEqual(propertyByName.get("relayDtmf"), undefined);
    assert.strictEqual(propertyByName.get("interdigitTimeoutSeconds"), undefined);
    assert.strictEqual(propertyByName.get("duckingFactor"), undefined);
    assert.strictEqual(propertyByName.get("mediaExecutionMode"), undefined);
    assert.strictEqual(propertyByName.get("voiceThreshold"), undefined);
    assert.strictEqual(propertyByName.get("voiceDurationMs"), undefined);
    assert.strictEqual(propertyByName.get("silenceThreshold"), undefined);
    assert.strictEqual(propertyByName.get("silenceDurationMs"), undefined);
    assert.strictEqual(propertyByName.get("dtmfMethod"), undefined);
    assert.strictEqual(propertyByName.get("dtmfDurationMs"), undefined);
    assert.strictEqual(propertyByName.get("dtmfGapMs"), undefined);
    const bridgeCallOptions = properties.find((property) => property.name === "callOptions" && property.displayOptions?.show?.operation?.includes("call.bridge"));
    const waitCallOptions = properties.find((property) => property.name === "callOptions" && property.displayOptions?.show?.operation?.includes("call.wait"));
    const waitCallTimeoutProperty = properties.find((property) => property.name === "timeoutSeconds" && property.displayOptions?.show?.operation?.includes("call.wait"));
    assert.ok(bridgeCallOptions, "missing call.bridge callOptions");
    assert.ok(waitCallOptions, "missing call.wait callOptions");
    assert.ok(waitCallTimeoutProperty, "missing call.wait timeoutSeconds");
    assert.doesNotMatch(waitCallTimeoutProperty.description || "", /wait indefinitely/i);
    assert.ok(bridgeCallOptions.options.some((option) => option.name === "emitDtmfEvents"));
    assert.ok(bridgeCallOptions.options.some((option) => option.name === "relayDtmf"));
    assert.ok(!bridgeCallOptions.options.some((option) => option.name === "relaySignaling"));
    assert.ok(waitCallOptions.options.some((option) => option.name === "interdigitTimeoutSeconds"));
    const mediaOptionCollections = properties.filter((property) => property.name === "mediaOptions");
    const directRecordingActiveProperty = properties.find((property) =>
      property.name === "active"
      && property.displayOptions?.show?.resource?.includes("recording")
      && property.displayOptions?.show?.operation?.includes("recording.start"));
    const respondRecordingActiveProperty = properties.find((property) =>
      property.name === "active"
      && property.displayOptions?.show?.resource?.includes("respond")
      && property.displayOptions?.show?.operation?.includes("respond.toRecord"));
    assert.strictEqual(directRecordingActiveProperty, undefined);
    assert.ok(respondRecordingActiveProperty, "respond recording should still expose active");
    const stopMediaIdOptions = mediaOptionCollections.find((property) => property.displayOptions?.show?.operation?.includes("media.stopMedia") && property.displayOptions?.show?.stopMediaTarget?.includes("mediaId"));
    const stopMediaLegOptions = mediaOptionCollections.find((property) => property.displayOptions?.show?.operation?.includes("media.stopMedia") && property.displayOptions?.show?.stopMediaTarget?.includes("legId"));
    const playAudioLegOptions = mediaOptionCollections.find((property) => property.displayOptions?.show?.operation?.includes("media.playAudio"));
    const playAudioHttpOptions = mediaOptionCollections.find((property) => property.displayOptions?.show?.operation?.includes("media.playAudio") && property.displayOptions?.show?.sourceType?.includes("http"));
    const playAudioVoiceOptions = mediaOptionCollections.find((property) => property.displayOptions?.show?.operation?.includes("media.playAudio") && property.displayOptions?.show?.interruptOnVoice?.includes(true));
    const recordSilenceOptions = mediaOptionCollections.find((property) => property.displayOptions?.show?.operation?.includes("media.recordAudio") && property.displayOptions?.show?.interruptOnSilence?.includes(true));
    const recordHttpOptions = mediaOptionCollections.find((property) => property.displayOptions?.show?.operation?.includes("media.recordAudio") && property.displayOptions?.show?.recordOutputType?.includes("http"));
    const sendDtmfOptions = mediaOptionCollections.find((property) => property.displayOptions?.show?.operation?.includes("media.sendDtmf"));
    const overlappingPlayAudioOptions = mediaOptionCollections.filter((property) => property.displayOptions?.show?.operation?.includes("media.playAudio") && !property.displayOptions?.show?.sourceType);
    const overlappingRecordAudioOptions = mediaOptionCollections.filter((property) => property.displayOptions?.show?.operation?.includes("media.recordAudio") && !property.displayOptions?.show?.recordOutputType);
    assert.ok(stopMediaIdOptions?.options.some((option) => option.name === "mediaId"));
    assert.ok(!playAudioLegOptions?.options.some((option) => option.name === "mediaId"));
    assert.deepStrictEqual(overlappingPlayAudioOptions, []);
    assert.deepStrictEqual(overlappingRecordAudioOptions, []);
    assert.ok(stopMediaLegOptions?.options.some((option) => option.name === "legId"));
    assert.ok(playAudioLegOptions?.options.some((option) => option.name === "duckingFactor"));
    assert.ok(playAudioLegOptions?.options.some((option) => option.name === "stopOtherMedia"));
    assert.ok(playAudioLegOptions?.options.some((option) => option.name === "mediaExecutionMode"));
    assert.ok(playAudioHttpOptions?.options.some((option) => option.name === "playbackHttpMethod"));
    assert.ok(playAudioHttpOptions?.options.some((option) => option.name === "playbackHttpHeaders"));
    assert.ok(!playAudioHttpOptions?.options.some((option) => option.name === "playbackHttpAuthentication"));
    assert.ok(!playAudioHttpOptions?.options.some((option) => option.name === "playbackHttpNodeCredentialType"));
    assert.ok(!playAudioHttpOptions?.options.some((option) => option.name === "playbackHttpGenericAuthType"));
    const playAudioHttpAuthMode = properties.find((property) =>
      property.name === "playbackHttpAuthentication"
      && property.displayOptions?.show?.operation?.includes("media.playAudio")
      && property.displayOptions?.show?.sourceType?.includes("http"));
    const playAudioHttpPredefinedCredential = properties.find((property) =>
      property.name === "playbackHttpNodeCredentialType"
      && property.displayOptions?.show?.operation?.includes("media.playAudio")
      && property.displayOptions?.show?.sourceType?.includes("http")
      && property.displayOptions?.show?.playbackHttpAuthentication?.includes("predefinedCredentialType"));
    const playAudioHttpAuthCredential = properties.find((property) =>
      property.name === "playbackHttpGenericAuthType"
      && property.displayOptions?.show?.operation?.includes("media.playAudio")
      && property.displayOptions?.show?.sourceType?.includes("http")
      && property.displayOptions?.show?.playbackHttpAuthentication?.includes("genericCredentialType"));
    assert.strictEqual(playAudioHttpAuthMode?.displayName, "HTTP Auth");
    assert.strictEqual(playAudioHttpAuthMode?.type, "options");
    assert.deepStrictEqual(playAudioHttpAuthMode?.options?.map((option) => option.value), ["none", "predefinedCredentialType", "genericCredentialType"]);
    assert.strictEqual(playAudioHttpPredefinedCredential?.displayName, "Credential Type");
    assert.strictEqual(playAudioHttpPredefinedCredential?.type, "credentialsSelect");
    assert.strictEqual(playAudioHttpAuthCredential?.displayName, "Generic Auth Type");
    assert.strictEqual(playAudioHttpAuthCredential?.type, "credentialsSelect");
    assert.ok(playAudioVoiceOptions?.options.some((option) => option.name === "voiceThreshold"));
    assert.strictEqual(playAudioVoiceOptions?.options.find((option) => option.name === "voiceDurationMs")?.default, 150);
    assert.ok(recordSilenceOptions?.options.some((option) => option.name === "silenceThreshold"));
    assert.strictEqual(recordSilenceOptions?.options.find((option) => option.name === "silenceDurationMs")?.default, 300);
    assert.ok(recordSilenceOptions?.options.some((option) => option.name === "stopOtherMedia"));
    assert.ok(recordHttpOptions?.options.some((option) => option.name === "recordHttpMethod"));
    assert.ok(recordHttpOptions?.options.some((option) => option.name === "recordHttpHeaders"));
    assert.ok(recordHttpOptions?.options.some((option) => option.name === "stopOtherMedia"));
    assert.ok(!recordHttpOptions?.options.some((option) => option.name === "recordHttpAuthentication"));
    assert.ok(!recordHttpOptions?.options.some((option) => option.name === "recordHttpNodeCredentialType"));
    assert.ok(!recordHttpOptions?.options.some((option) => option.name === "recordHttpGenericAuthType"));
    const recordHttpAuthMode = properties.find((property) =>
      property.name === "recordHttpAuthentication"
      && property.displayOptions?.show?.operation?.includes("media.recordAudio")
      && property.displayOptions?.show?.recordOutputType?.includes("http"));
    const recordHttpPredefinedCredential = properties.find((property) =>
      property.name === "recordHttpNodeCredentialType"
      && property.displayOptions?.show?.operation?.includes("media.recordAudio")
      && property.displayOptions?.show?.recordOutputType?.includes("http")
      && property.displayOptions?.show?.recordHttpAuthentication?.includes("predefinedCredentialType"));
    const recordHttpAuthCredential = properties.find((property) =>
      property.name === "recordHttpGenericAuthType"
      && property.displayOptions?.show?.operation?.includes("media.recordAudio")
      && property.displayOptions?.show?.recordOutputType?.includes("http")
      && property.displayOptions?.show?.recordHttpAuthentication?.includes("genericCredentialType"));
    assert.strictEqual(recordHttpAuthMode?.displayName, "HTTP Auth");
    assert.strictEqual(recordHttpAuthMode?.type, "options");
    assert.deepStrictEqual(recordHttpAuthMode?.options?.map((option) => option.value), ["none", "predefinedCredentialType", "genericCredentialType"]);
    assert.strictEqual(recordHttpPredefinedCredential?.displayName, "Credential Type");
    assert.strictEqual(recordHttpPredefinedCredential?.type, "credentialsSelect");
    assert.strictEqual(recordHttpAuthCredential?.displayName, "Generic Auth Type");
    assert.strictEqual(recordHttpAuthCredential?.type, "credentialsSelect");
    assert.ok(sendDtmfOptions?.options.some((option) => option.name === "dtmfMethod"));
    assert.ok(sendDtmfOptions?.options.some((option) => option.name === "dtmfDurationMs"));
    assert.ok(sendDtmfOptions?.options.some((option) => option.name === "dtmfGapMs"));
    const customSipHeadersOption = makeSipDialOptions.options.find((option) => option.name === "customSipHeaders");
    assert.strictEqual(customSipHeadersOption.options[0].values[0].required, true);
  });

  return { operationPropertyCount: Object.keys(expectedOperationsByResource).length };
}

async function testMissingOperationRejected() {
  await withPatchedRuntime({}, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const node = new SipPbx();
    Object.assign(node, createExecuteContext({
      resource: "media",
      mediaOptions: { legId: "leg-audio" },
    }, [{ json: {} }]));
    await assert.rejects(
      async () => await node.execute(),
      /Operation is required/,
    );
  });

  return { ok: true };
}

async function runActionControlNodeSmokeCases() {
  return {
    actionOperationContract: await testActionOperationContract(),
    missingOperationRejected: await testMissingOperationRejected(),
    callWaitForEvent: await testCallWaitForEventRouting(),
    callWaitForEventMultipleLegs: await testCallWaitForEventRoutingMultipleLegs(),
    dialWaitForEvent: await testDialWaitForEventRouting(),
    dialWaitForEventMultipleDials: await testDialWaitForEventRoutingMultipleDials(),
    authAndQueue: await testQueueAndAuthResponses(),
    dialAndBridge: await testDialMakeAndBridge(),
    operationOnlyAnswerRouting: await testOperationOnlyAnswerRouting(),
  };
}

module.exports = {
  runActionControlNodeSmokeCases,
};
