#!/usr/bin/env node
"use strict";

const assert = require("assert");
const http = require("http");
const https = require("https");
const {
  SIP_DTMF_METHOD_RFC2833,
} = require("../../../build-src/shared/sip-media-filters.js");
const {
  sipPbxNodeModulePath,
  createExecuteContext,
  withPatchedRuntime,
} = require("../lib/node-smoke-lib");

async function testMediaPlayAudioAndTone() {
  const seen = { playAudio: null, playTone: null, sendDtmf: null };
  const fakeRuntime = {
    async playAudio(legId, input) {
      seen.playAudio = { legId, input };
      return { mediaId: "media-audio-1", legId, status: "started" };
    },
    async playTone(legId, input) {
      seen.playTone = { legId, input };
      return { legId, status: "interrupted", interruptReason: "call_dtmf", digit: "5" };
    },
    async sendDtmf(legId, digits, input) {
      seen.sendDtmf = { legId, digits, input };
      return { legId, digits, method: input.dtmfMethod };
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const playAudioNode = new SipPbx();
    Object.assign(playAudioNode, createExecuteContext({
      resource: "media",
      operation: "media.playAudio",
      options: { legId: "leg-audio", mediaExecutionMode: "background", duckingFactor: 0.5, stopOtherMedia: true },
      sourceType: "binary",
      binaryProperty: "audio",
      interruptOn: [["dtmf"]],
    }, [{ json: {}, binary: { audio: { data: Buffer.from("AUDIO").toString("base64") } } }]));
    const playAudioOutputs = await playAudioNode.execute();
    assert.strictEqual(playAudioOutputs.length, 1);
    assert.strictEqual(playAudioOutputs[0].length, 1);
    assert.strictEqual(playAudioOutputs[0][0].json.mediaId, "media-audio-1");

    const playToneNode = new SipPbx();
    Object.assign(playToneNode, createExecuteContext({
      resource: "media",
      operation: "media.playTone",
      options: { legId: "leg-tone", voiceThreshold: 0.02, voiceDurationMs: 150, duckingFactor: 0.4, mediaExecutionMode: "blocking" },
      tone: "custom",
      customTone: "440+480/200,0/100",
      repeatInfinite: false,
      interruptOn: [["dtmf"]],
    }, [{ json: {} }]));
    const playToneOutputs = await playToneNode.execute();
    assert.strictEqual(playToneOutputs[0][0].json.interruptReason, "call_dtmf");

    const infiniteToneNode = new SipPbx();
    Object.assign(infiniteToneNode, createExecuteContext({
      resource: "media",
      operation: "media.playTone",
      options: { legId: "leg-tone", voiceThreshold: 0.02, voiceDurationMs: 150, duckingFactor: 0.4, mediaExecutionMode: "blocking" },
      tone: "ringback",
      repeatInfinite: true,
      interruptOn: [["dtmf"]],
    }, [{ json: {} }]));
    const infiniteToneOutputs = await infiniteToneNode.execute();
    assert.strictEqual(infiniteToneOutputs.length, 1);
    assert.strictEqual(infiniteToneOutputs[0][0].json.interruptReason, "call_dtmf");

    const sendDtmfNode = new SipPbx();
    Object.assign(sendDtmfNode, createExecuteContext({
      resource: "media",
      operation: "media.sendDtmf",
      options: { legId: "leg-dtmf", dtmfMethod: SIP_DTMF_METHOD_RFC2833, dtmfDurationMs: 200, dtmfGapMs: 100 },
      dtmfDigits: "123",
    }, [{ json: {} }]));
    const sendDtmfOutputs = await sendDtmfNode.execute();
    assert.strictEqual(sendDtmfOutputs[0][0].json.legId, "leg-dtmf");
    assert.strictEqual(sendDtmfOutputs[0][0].json.method, undefined);
  });

  assert.strictEqual(seen.playAudio.legId, "leg-audio");
  assert.strictEqual(seen.playAudio.input.stopOtherMedia, true);
  assert.strictEqual(seen.playTone.input.customTone, "440+480/200,0/100");
  assert.strictEqual(seen.sendDtmf.digits, "123");
  return { ok: true };
}

async function testMediaRecordAndWait() {
  const seen = { recordAudio: null, stopMedia: null, waitMedia: null };
  const fakeRuntime = {
    async recordAudio(legId, input) {
      seen.recordAudio = { legId, input };
      return { mediaId: "media-record-1", legId, status: "started" };
    },
    async stopMedia(input) {
      seen.stopMedia = input;
      return { mediaId: "media-record-1", legId: "leg-record-1" };
    },
    async waitMedia(input) {
      seen.waitMedia = input;
      return { mediaId: "media-record-1", legId: "leg-record-1", eventType: "completed", interruptReason: null };
    },
  };

  await withPatchedRuntime(fakeRuntime, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const recordNode = new SipPbx();
    Object.assign(recordNode, createExecuteContext({
      resource: "media",
      operation: "media.recordAudio",
      options: { legId: "leg-record-1", mediaExecutionMode: "background", silenceThreshold: 0.01, silenceDurationMs: 300, recordWavSampleRate: 8000, recordWavBitDepth: 16, stopOtherMedia: true },
      interruptOn: [["dtmf", "silence"]],
      maxDurationSeconds: 30,
      recordFileFormat: "wav",
      recordOutputType: "binary",
      recordBinaryProperty: "data",
    }, [{ json: {} }]));
    const recordOutputs = await recordNode.execute();
    assert.strictEqual(recordOutputs[0][0].json.mediaId, "media-record-1");

    const waitNode = new SipPbx();
    Object.assign(waitNode, createExecuteContext({
      resource: "media",
      operation: "media.wait",
      mediaIds: { item: [{ mediaId: "media-record-1" }] },
      waitMediaTimeoutSeconds: 5,
    }, [{ json: {} }]));
    const waitOutputs = await waitNode.execute();
    assert.strictEqual(waitOutputs[2][0].json.mediaId, "media-record-1");

    const stopNode = new SipPbx();
    Object.assign(stopNode, createExecuteContext({
      resource: "media",
      operation: "media.stopMedia",
      stopMediaTarget: "mediaId",
      options: { mediaId: "media-record-1" },
    }, [{ json: {} }]));
    const stopOutputs = await stopNode.execute();
    assert.strictEqual(stopOutputs[0][0].json.legId, "leg-record-1");
  });

  assert.strictEqual(seen.recordAudio.input.recordFileFormat, "wav");
  assert.strictEqual(seen.recordAudio.input.stopOtherMedia, true);
  assert.deepStrictEqual(seen.waitMedia.mediaIds, ["media-record-1"]);
  assert.strictEqual(seen.stopMedia.mediaId, "media-record-1");
  return { ok: true };
}

async function testHttpAuthNormalization() {
  const seen = { playAudio: null, recordAudio: null };
  const fakeRuntime = {
    async playAudio(legId, input) {
      seen.playAudio = { legId, input };
      return { mediaId: "media-http-1", legId, status: "started" };
    },
    async recordAudio(legId, input) {
      seen.recordAudio = { legId, input };
      return { mediaId: "media-http-2", legId, status: "started" };
    },
  };
  const helper = async (credentialType, requestOptions) => await new Promise((resolve, reject) => {
    const url = new URL(requestOptions.url);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: requestOptions.method,
      headers: {
        ...(requestOptions.headers || {}),
        Authorization: credentialType === "predefinedApi" ? "Bearer predefined-token" : "Bearer generic-token",
        "X-Resolved-Auth": credentialType,
      },
    }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.once("error", reject);
    request.end();
  });

  await withPatchedRuntime(fakeRuntime, sipPbxNodeModulePath, async ({ SipPbx }) => {
    const playAudioNode = new SipPbx();
    Object.assign(playAudioNode, createExecuteContext({
      resource: "media",
      operation: "media.playAudio",
      options: {
        legId: "leg-http-play",
        mediaExecutionMode: "background",
        playbackHttpHeaders: { item: [{ name: "X-Client", value: "playback" }] },
      },
      sourceType: "http",
      playbackHttpUrl: "https://media.example.test/audio?existing=1",
      authentication: "predefinedCredentialType",
      nodeCredentialType: "predefinedApi",
      interruptOn: [[]],
    }, [{ json: {} }], {
      helpers: { httpRequestWithAuthentication: helper },
    }));
    await playAudioNode.execute();

    const recordNode = new SipPbx();
    Object.assign(recordNode, createExecuteContext({
      resource: "media",
      operation: "media.recordAudio",
      options: {
        legId: "leg-http-record",
        mediaExecutionMode: "background",
        recordHttpHeaders: { item: [{ name: "X-Client", value: "record" }] },
      },
      interruptOn: [[]],
      maxDurationSeconds: 30,
      recordFileFormat: "wav",
      recordOutputType: "http",
      recordHttpUrl: "https://media.example.test/upload",
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
    }, [{ json: {} }], {
      helpers: { httpRequestWithAuthentication: helper },
    }));
    await recordNode.execute();
  });

  assert.strictEqual(seen.playAudio.legId, "leg-http-play");
  assert.strictEqual(seen.playAudio.input.playbackHttpUrl, "https://media.example.test/audio?existing=1");
  assert.deepStrictEqual(seen.playAudio.input.playbackHttpHeaders, [
    { name: "X-Client", value: "playback" },
    { name: "Authorization", value: "Bearer predefined-token" },
    { name: "X-Resolved-Auth", value: "predefinedApi" },
  ]);
  assert.strictEqual(seen.playAudio.input.authentication, undefined);
  assert.strictEqual(seen.playAudio.input.nodeCredentialType, undefined);
  assert.strictEqual(seen.playAudio.input.genericAuthType, undefined);
  assert.strictEqual(seen.playAudio.input.playbackHttpAuth, undefined);

  assert.strictEqual(seen.recordAudio.legId, "leg-http-record");
  assert.strictEqual(seen.recordAudio.input.recordHttpUrl, "https://media.example.test/upload");
  assert.deepStrictEqual(seen.recordAudio.input.recordHttpHeaders, [
    { name: "X-Client", value: "record" },
    { name: "Authorization", value: "Bearer generic-token" },
    { name: "X-Resolved-Auth", value: "httpHeaderAuth" },
  ]);
  assert.strictEqual(seen.recordAudio.input.authentication, undefined);
  assert.strictEqual(seen.recordAudio.input.nodeCredentialType, undefined);
  assert.strictEqual(seen.recordAudio.input.genericAuthType, undefined);
  assert.strictEqual(seen.recordAudio.input.recordHttpAuth, undefined);

  return { ok: true };
}

async function runActionMediaNodeSmokeCases() {
  return {
    mediaPlayback: await testMediaPlayAudioAndTone(),
    mediaRecording: await testMediaRecordAndWait(),
    mediaHttpAuthNormalization: await testHttpAuthNormalization(),
  };
}

module.exports = {
  runActionMediaNodeSmokeCases,
};
