#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

if (process.platform !== "linux") {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "runtime media smoke requires the Linux native backend",
  }, null, 2));
  process.exit(0);
}

const SMOKE_TIMEOUT_FLOOR_MS = Math.max(
  1000,
  Number(process.env.SIP_PBX_SMOKE_TIMEOUT_FLOOR_MS || 2500),
);

function withSmokeTimeoutFloor(timeoutMs) {
  return Math.max(Number(timeoutMs || 0), SMOKE_TIMEOUT_FLOOR_MS);
}

function createSocketPath() {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".smoke-runtime-"));
  return path.join(tempDir, "daemon.sock");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeQuietly(closeable) {
  if (!closeable || typeof closeable.close !== "function") {
    return;
  }
  try {
    await closeable.close();
  } catch {}
}

async function closeWebSocketServer(server) {
  if (!server) {
    return;
  }
  await new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function waitForCondition(predicate, timeoutMs = 1000, label = "condition") {
  const effectiveTimeoutMs = withSmokeTimeoutFloor(timeoutMs);
  const startedAt = Date.now();
  while (Date.now() - startedAt < effectiveTimeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Wait timeout: ${label}`);
}

function readWavChannelCount(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.ok(buffer.length >= 24, `WAV file too short: ${filePath}`);
  assert.strictEqual(buffer.subarray(0, 4).toString("ascii"), "RIFF");
  assert.strictEqual(buffer.subarray(8, 12).toString("ascii"), "WAVE");
  return buffer.readUInt16LE(22);
}

function findWavDataOffset(buffer) {
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length >= 44, "WAV buffer too short");
  assert.strictEqual(buffer.subarray(0, 4).toString("ascii"), "RIFF");
  assert.strictEqual(buffer.subarray(8, 12).toString("ascii"), "WAVE");
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      return offset + 8;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error("WAV recording has no data chunk");
}

function readWavLeadingAverageAbsLevel(buffer, sampleCount = 160) {
  const channels = Math.max(1, buffer.readUInt16LE(22));
  const dataOffset = findWavDataOffset(buffer);
  const availableSamples = Math.floor((buffer.length - dataOffset) / (channels * 2));
  const samplesToRead = Math.max(0, Math.min(sampleCount, availableSamples));
  if (!samplesToRead) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < samplesToRead; index += 1) {
    total += Math.abs(buffer.readInt16LE(dataOffset + index * channels * 2));
  }
  return total / samplesToRead;
}

async function waitForWebSocketMessage(socket, predicate, timeoutMs = 1000, label = "websocket") {
  return await new Promise((resolve, reject) => {
    const effectiveTimeoutMs = withSmokeTimeoutFloor(timeoutMs);
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`WebSocket wait timeout: ${label}`));
    }, effectiveTimeoutMs);
    const onMessage = (raw) => {
      let payload = raw;
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
        payload = JSON.parse(text);
      } catch {}
      if (!predicate(payload)) {
        return;
      }
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(payload);
    };
    socket.on("message", onMessage);
  });
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function createSpeechPcmFrame(sampleCount = 160, amplitude = 12000) {
  const frame = Buffer.allocUnsafe(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    frame.writeInt16LE(index % 2 === 0 ? amplitude : -amplitude, index * 2);
  }
  return frame;
}

async function sendUdpBuffer(socket, buffer, port, host) {
  await new Promise((resolve, reject) => {
    socket.send(buffer, port, host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function parseSipMessage(text) {
  const [headerText, body = ""] = String(text || "").split(/\r?\n\r?\n/, 2);
  const lines = headerText.split(/\r?\n/).filter(Boolean);
  const startLine = lines.shift() || "";
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!headers[name]) {
      headers[name] = [];
    }
    headers[name].push(value);
  }
  const responseMatch = startLine.match(/^SIP\/2\.0\s+(\d{3})\s*(.*)$/i);
  if (responseMatch) {
    return {
      startLine,
      statusCode: Number(responseMatch[1]),
      reasonPhrase: String(responseMatch[2] || "").trim(),
      headers,
      body,
    };
  }
  const requestMatch = startLine.match(/^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/i);
  return {
    startLine,
    method: requestMatch ? requestMatch[1].toUpperCase() : "",
    requestUri: requestMatch ? requestMatch[2] : "",
    headers,
    body,
  };
}

function sipHeader(message, name) {
  return ((message.headers || {})[String(name || "").toLowerCase()] || [])[0] || "";
}

function sipContactUri(message) {
  return (/<([^>]+)>/.exec(sipHeader(message, "contact")) || [])[1] || "";
}

function buildRegister(options) {
  const lines = [
    `REGISTER ${options.requestUri} SIP/2.0`,
    `Via: SIP/2.0/UDP ${options.localHost}:${options.localPort};branch=${options.branch}`,
    "Max-Forwards: 70",
    `From: <sip:${options.username}@${options.realm}>;tag=${options.tag}`,
    `To: <sip:${options.username}@${options.realm}>`,
    `Call-ID: ${options.callId}`,
    `CSeq: ${options.cseq} REGISTER`,
    `Contact: <sip:${options.username}@${options.localHost}:${options.localPort}>;expires=${options.expires}`,
  ];
  if (options.authorization) {
    lines.push(`Authorization: ${options.authorization}`);
  }
  lines.push("Content-Length: 0");
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function buildInvite(options) {
  const body = String(options.body || "");
  const headers = [
    `INVITE ${options.requestUri} SIP/2.0`,
    `Via: SIP/2.0/UDP ${options.localHost}:${options.localPort};branch=${options.branch}`,
    "Max-Forwards: 70",
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Call-ID: ${options.callId}`,
    `CSeq: ${options.cseq} INVITE`,
    `Contact: <sip:${options.contactUser || "caller"}@${options.localHost}:${options.localPort}>`,
  ];
  if (options.extraHeaders && typeof options.extraHeaders === "object") {
    for (const [name, value] of Object.entries(options.extraHeaders)) {
      if (value == null || value === "") {
        continue;
      }
      headers.push(`${name}: ${value}`);
    }
  }
  if (body) {
    headers.push(`Content-Type: ${options.contentType || "application/sdp"}`);
  }
  headers.push(`Content-Length: ${Buffer.byteLength(body, "utf8")}`);
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

function buildCancel(options) {
  const headers = [
    `CANCEL ${options.requestUri} SIP/2.0`,
    `Via: SIP/2.0/UDP ${options.localHost}:${options.localPort};branch=${options.branch}`,
    "Max-Forwards: 70",
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Call-ID: ${options.callId}`,
    `CSeq: ${options.cseq} CANCEL`,
    "Content-Length: 0",
  ];
  return `${headers.join("\r\n")}\r\n\r\n`;
}

function buildOptions(options) {
  const headers = [
    `OPTIONS ${options.requestUri} SIP/2.0`,
    `Via: SIP/2.0/UDP ${options.localHost}:${options.localPort};branch=${options.branch}`,
    "Max-Forwards: 70",
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Call-ID: ${options.callId}`,
    `CSeq: ${options.cseq} OPTIONS`,
    "Content-Length: 0",
  ];
  return `${headers.join("\r\n")}\r\n\r\n`;
}

function buildInfo(options) {
  const body = String(options.body || "");
  const headers = [
    `INFO ${options.requestUri} SIP/2.0`,
    `Via: SIP/2.0/UDP ${options.localHost}:${options.localPort};branch=${options.branch}`,
    "Max-Forwards: 70",
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Call-ID: ${options.callId}`,
    `CSeq: ${options.cseq} INFO`,
    `Contact: <sip:${options.contactUser || "caller"}@${options.localHost}:${options.localPort}>`,
    "Content-Type: application/dtmf-relay",
    `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
  ];
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

function buildAck(options) {
  const headers = [
    `ACK ${options.requestUri} SIP/2.0`,
    `Via: SIP/2.0/UDP ${options.localHost}:${options.localPort};branch=${options.branch}`,
    "Max-Forwards: 70",
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Call-ID: ${options.callId}`,
    `CSeq: ${options.cseq} ACK`,
    "Content-Length: 0",
  ];
  return `${headers.join("\r\n")}\r\n\r\n`;
}

function buildResponse(message, statusCode, reasonPhrase, extraHeaders) {
  return buildResponseWithBody(message, statusCode, reasonPhrase, extraHeaders, "");
}

function buildResponseWithBody(message, statusCode, reasonPhrase, extraHeaders, body) {
  const lines = [
    `SIP/2.0 ${statusCode} ${reasonPhrase}`,
    `Via: ${sipHeader(message, "via")}`,
    `From: ${sipHeader(message, "from")}`,
    `To: ${sipHeader(message, "to").includes(";tag=") ? sipHeader(message, "to") : `${sipHeader(message, "to")};tag=remote`}`,
    `Call-ID: ${sipHeader(message, "call-id")}`,
    `CSeq: ${sipHeader(message, "cseq")}`,
  ];
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    if (value != null && value !== "") {
      lines.push(`${name}: ${value}`);
    }
  }
  const payload = String(body || "");
  lines.push(`Content-Length: ${Buffer.byteLength(payload, "utf8")}`);
  return `${lines.join("\r\n")}\r\n\r\n${payload}`;
}

function sendUdp(socket, text, port, host) {
  return new Promise((resolve, reject) => {
    socket.send(Buffer.from(text, "utf8"), port, host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForUdpMessage(socket, predicate, timeoutMs = 1000, label = "udp") {
  return new Promise((resolve, reject) => {
    const effectiveTimeoutMs = withSmokeTimeoutFloor(timeoutMs);
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`UDP wait timeout: ${label}`));
    }, effectiveTimeoutMs);
    const onMessage = (buffer, rinfo) => {
      const text = buffer.toString("utf8");
      const message = parseSipMessage(text);
      if (!predicate(message, text, rinfo)) {
        return;
      }
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve({ message, text, rinfo });
    };
    socket.on("message", onMessage);
  });
}

function waitForUdpBuffer(socket, predicate, timeoutMs = 1000, label = "udp-buffer") {
  return new Promise((resolve, reject) => {
    const effectiveTimeoutMs = withSmokeTimeoutFloor(timeoutMs);
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`UDP wait timeout: ${label}`));
    }, effectiveTimeoutMs);
    const onMessage = (buffer, rinfo) => {
      if (!predicate(buffer, rinfo)) {
        return;
      }
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve({ buffer, rinfo });
    };
    socket.on("message", onMessage);
  });
}

function createWavSilenceBase64(durationMs = 200, sampleRate = 8000) {
  return createWavPcmBase64(Buffer.alloc(Math.max(1, Math.round((durationMs / 1000) * sampleRate)) * 2), sampleRate);
}

function createTonePcm(sampleRate = 8000, durationMs = 20, frequencyHz = 440) {
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * 12000);
    const normalized = sample < 0 ? 0x10000 + sample : sample;
    buffer[index * 2] = normalized & 0xff;
    buffer[index * 2 + 1] = (normalized >> 8) & 0xff;
  }
  return buffer;
}

function createStereoTonePcm(sampleRate = 8000, durationMs = 20, frequencyHz = 440) {
  const mono = createTonePcm(sampleRate, durationMs, frequencyHz);
  const buffer = Buffer.alloc(mono.length * 2);
  for (let offset = 0; offset < mono.length; offset += 2) {
    buffer[offset] = mono[offset];
    buffer[offset + 1] = mono[offset + 1];
    buffer[offset + mono.length] = mono[offset];
    buffer[offset + mono.length + 1] = mono[offset + 1];
  }
  return buffer;
}

function createWavConstantBase64(sampleValue, durationMs = 200, sampleRate = 8000) {
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const data = Buffer.alloc(sampleCount * 2);
  const normalized = Math.max(-32768, Math.min(32767, Number(sampleValue || 0)));
  const unsigned = normalized < 0 ? 0x10000 + normalized : normalized;
  for (let offset = 0; offset < data.length; offset += 2) {
    data[offset] = unsigned & 0xff;
    data[offset + 1] = (unsigned >> 8) & 0xff;
  }
  return createWavPcmBase64(data, sampleRate);
}

function createWavPcmBase64(data, sampleRate = 8000) {
  const wav = Buffer.alloc(44 + data.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav.toString("base64");
}

function readPcmPeakFromBase64(audioBase64) {
  const buffer = Buffer.from(String(audioBase64 || ""), "base64");
  let peak = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const value = ((buffer[offset + 1] || 0) << 8) | (buffer[offset] || 0);
    const sample = Math.abs(value & 0x8000 ? value - 0x10000 : value);
    if (sample > peak) {
      peak = sample;
    }
  }
  return peak;
}

function parseAudioPortFromSdp(body) {
  const match = String(body || "").match(/^m=audio\s+(\d+)/m);
  return match ? Number(match[1]) : 0;
}

function parseAudioPayloadTypesFromSdp(body) {
  const match = String(body || "").match(/^m=audio\s+\d+\s+\S+\s+(.+)$/m);
  if (!match) {
    return [];
  }
  return String(match[1] || "").trim().split(/\s+/).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0);
}

function parseSdpRtpMap(body) {
  const result = {};
  for (const line of String(body || "").split(/\r?\n/)) {
    const match = line.match(/^a=rtpmap:(\d+)\s+(.+)$/i);
    if (!match) {
      continue;
    }
    result[Number(match[1])] = String(match[2] || "").trim();
  }
  return result;
}

function parseSdpFmtp(body) {
  const result = {};
  for (const line of String(body || "").split(/\r?\n/)) {
    const match = line.match(/^a=fmtp:(\d+)\s+(.+)$/i);
    if (!match) {
      continue;
    }
    result[Number(match[1])] = String(match[2] || "").trim();
  }
  return result;
}

function buildAudioSdp(host, port, options = {}) {
  const audioPayloadType = Number(options.audioPayloadType ?? 0);
  const audioCodec = String(options.audioCodec || (audioPayloadType === 8 ? "PCMA" : "PCMU")).toUpperCase();
  const dtmfPayloadType = options.includeDtmf === false ? null : Number(options.dtmfPayloadType ?? 101);
  const payloadTypes = dtmfPayloadType == null
    ? [audioPayloadType]
    : [audioPayloadType, dtmfPayloadType];
  const lines = [
    "v=0",
    `o=- ${Date.now()} ${Date.now()} IN IP4 ${host}`,
    "s=smoke",
    `c=IN IP4 ${host}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP ${payloadTypes.join(" ")}`,
    `a=rtpmap:${audioPayloadType} ${audioCodec}/8000`,
  ];
  if (dtmfPayloadType != null) {
    lines.push(`a=rtpmap:${dtmfPayloadType} telephone-event/8000`);
    lines.push(`a=fmtp:${dtmfPayloadType} 0-16`);
  }
  lines.push("a=ptime:20");
  lines.push("a=sendrecv");
  return lines.join("\r\n");
}

function rtpPayloadType(buffer) {
  return (buffer[1] || 0) & 0x7f;
}

function buildInviteTransactionKey(message) {
  return [
    sipHeader(message, "call-id"),
    sipHeader(message, "cseq"),
    sipHeader(message, "via"),
  ].join("|");
}

function buildRegisterTransactionKey(message) {
  return [
    sipHeader(message, "call-id"),
    sipHeader(message, "cseq"),
    sipHeader(message, "via"),
  ].join("|");
}

function buildRtpPacket(payloadType, payload, sequenceNumber = 1, timestamp = 160, ssrc = 1234) {
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = payloadType & 0x7f;
  packet[2] = (sequenceNumber >> 8) & 0xff;
  packet[3] = sequenceNumber & 0xff;
  packet[4] = (timestamp >>> 24) & 0xff;
  packet[5] = (timestamp >>> 16) & 0xff;
  packet[6] = (timestamp >>> 8) & 0xff;
  packet[7] = timestamp & 0xff;
  packet[8] = (ssrc >>> 24) & 0xff;
  packet[9] = (ssrc >>> 16) & 0xff;
  packet[10] = (ssrc >>> 8) & 0xff;
  packet[11] = ssrc & 0xff;
  payload.copy(packet, 12);
  return packet;
}

function buildRtpDtmfPacket(payloadType, digit, sequenceNumber = 1, timestamp = 160, end = true, duration = 160, ssrc = 1234) {
  const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#", "A", "B", "C", "D"];
  const eventCode = digits.indexOf(String(digit || "").slice(0, 1));
  if (eventCode < 0) {
    throw new Error(`Unsupported DTMF digit: ${digit}`);
  }
  const payload = Buffer.from([
    eventCode & 0xff,
    (end ? 0x80 : 0) | 0x0a,
    (duration >> 8) & 0xff,
    duration & 0xff,
  ]);
  return buildRtpPacket(payloadType, payload, sequenceNumber, timestamp, ssrc);
}

async function main() {
  const { ControllerClient } = require("../../dist/control/controller-client.js");
  const { PbxRuntime } = require("../../dist/runtime/pbx-runtime.js");
  const { SipPbxDaemon } = require("../../dist/daemon/sip-pbx-daemon.js");
  const { createCodec, loadNativeCodecBindings } = require("../../dist/daemon/media/codecs/audio-codec.js");

  const socketPath = createSocketPath();
  const daemon = new SipPbxDaemon(socketPath);
  await daemon.start();

  try {
    const nativeCodecBindings = loadNativeCodecBindings();
    assert.ok(nativeCodecBindings);
    assert.strictEqual(typeof nativeCodecBindings.Pcm16Converter, "function");
    assert.strictEqual(typeof nativeCodecBindings.SetThreadName, "function");
    nativeCodecBindings.SetThreadName("media-worker-7");
    const threadName = fs.readFileSync(`/proc/self/task/${process.pid}/comm`, "utf8").trim();
    assert.ok(threadName.startsWith("media-worker-7"));
    const monoInput = createTonePcm(8000, 20, 440);
    const stereoInput = createStereoTonePcm(8000, 20, 440);
    const monoToStereo = new nativeCodecBindings.Pcm16Converter(8000, 1, 8000, 2);
    const stereoToMono = new nativeCodecBindings.Pcm16Converter(8000, 2, 8000, 1);
    const monoToStereoTarget = Buffer.alloc(monoInput.length * 2);
    const stereoToMonoTarget = Buffer.alloc(stereoInput.length / 2);
    assert.strictEqual(typeof monoToStereo.convertInto, "function");
    assert.strictEqual(typeof stereoToMono.convertInto, "function");
    assert.strictEqual(monoToStereo.convertInto(monoInput, 0, monoInput.length, monoToStereoTarget, 0, monoToStereoTarget.length), monoToStereoTarget.length);
    assert.strictEqual(stereoToMono.convertInto(stereoInput, 0, stereoInput.length, stereoToMonoTarget, 0, stereoToMonoTarget.length), stereoToMonoTarget.length);
    monoToStereo.close();
    stereoToMono.close();

    const runtime = new PbxRuntime(new ControllerClient(socketPath));
    const playbackBinaryBase64 = createWavSilenceBase64(200);
    const interruptPlaybackBinaryBase64 = createWavSilenceBase64(2000);
    const leg = daemon.legService.createLeg({
      legId: "runtime-leg-1",
      direction: "outbound",
      transportType: "sip",
      status: "answered",
    });

    const playback = await runtime.playAudio(leg.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: interruptPlaybackBinaryBase64,
    });
    assert.strictEqual(playback.status, "started");

    const waitBeforeStop = await runtime.waitMedia({
      waitMediaIds: [playback.mediaId],
      waitMediaTimeoutSeconds: 0.01,
    });
    assert.strictEqual(waitBeforeStop.status, "timeout");

    const waitingPlaybackPromise = runtime.waitMedia({
      waitMediaIds: [playback.mediaId],
      waitMediaTimeoutSeconds: 0.1,
    });
    await sleep(10);
    const stopPlayback = await runtime.stopMedia({
      stopMediaTarget: "mediaId",
      stopMediaId: playback.mediaId,
      stopMediaReason: "smoke_stop",
    });
    assert.strictEqual(stopPlayback.mediaId, playback.mediaId);

    const waitedPlayback = await waitingPlaybackPromise;
    assert.strictEqual(waitedPlayback.status, "interrupted");
    assert.strictEqual(waitedPlayback.interruptReason, "smoke_stop");

    const tone = await runtime.playTone(leg.legId, {
      mediaExecutionMode: "blocking",
      tone: "ringback",
    });
    assert.strictEqual(tone.status, "completed");

    const mixLeg = daemon.legService.createLeg({
      legId: "runtime-leg-mix",
      direction: "outbound",
      transportType: "sip",
      status: "answered",
    });
    const lowPriorityPlayback = await runtime.playAudio(mixLeg.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: interruptPlaybackBinaryBase64,
      duckingFactor: 1,
    });
    const highPriorityPlayback = await runtime.playAudio(mixLeg.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: playbackBinaryBase64,
      duckingFactor: 0.4,
    });
    const mixDetails = daemon.legService.requireLeg(mixLeg.legId).mediaDetails;
    assert.strictEqual(mixDetails.playbackCount, 2);
    assert.strictEqual(mixDetails.activePlaybackMediaIds[0], highPriorityPlayback.mediaId);
    assert.strictEqual(mixDetails.activePlaybackMediaIds[1], lowPriorityPlayback.mediaId);
    assert.strictEqual(mixDetails.playbackMix[0].effectiveGain, 1);
    assert.strictEqual(mixDetails.playbackMix[1].effectiveGain, 0.4);
    await runtime.stopMedia({
      stopMediaTarget: "legId",
      stopMediaLegId: mixLeg.legId,
      stopMediaReason: "mix_cleanup",
    });

    const boostMixLeg = daemon.legService.createLeg({
      legId: "runtime-leg-mix-boost",
      direction: "outbound",
      transportType: "sip",
      status: "answered",
    });
    const boostLowPriorityPlayback = await runtime.playAudio(boostMixLeg.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: playbackBinaryBase64,
      duckingFactor: 1,
    });
    const boostHighPriorityPlayback = await runtime.playAudio(boostMixLeg.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: playbackBinaryBase64,
      duckingFactor: 2,
    });
    const boostMixDetails = daemon.legService.requireLeg(boostMixLeg.legId).mediaDetails;
    assert.strictEqual(boostMixDetails.playbackCount, 2);
    assert.strictEqual(boostMixDetails.activePlaybackMediaIds[0], boostHighPriorityPlayback.mediaId);
    assert.strictEqual(boostMixDetails.activePlaybackMediaIds[1], boostLowPriorityPlayback.mediaId);
    assert.strictEqual(boostMixDetails.playbackMix[0].effectiveGain, 1);
    assert.strictEqual(boostMixDetails.playbackMix[1].effectiveGain, 0.5);
    await runtime.stopMedia({
      stopMediaTarget: "legId",
      stopMediaLegId: boostMixLeg.legId,
      stopMediaReason: "mix_boost_cleanup",
    });

    const voiceLeg = daemon.legService.createLeg({
      legId: "runtime-leg-voice",
      direction: "outbound",
      transportType: "sip",
      status: "answered",
    });
    const voicePlayback = await runtime.playAudio(voiceLeg.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: playbackBinaryBase64,
      interruptOnVoice: true,
      voiceThreshold: 0.1,
      voiceDurationMs: 50,
    });
    const voiceWaitPromise = runtime.waitMedia({
      waitMediaIds: [voicePlayback.mediaId],
      waitMediaTimeoutSeconds: 0.1,
    });
    await daemon.mediaService.reportVoiceActivity(voiceLeg.legId, 0.4, 100);
    const voiceInterruptedMedia = await voiceWaitPromise;
    assert.strictEqual(voiceInterruptedMedia.status, "interrupted");
    assert.strictEqual(voiceInterruptedMedia.interruptReason, "voice");

    const dtmf = await runtime.sendDtmf(leg.legId, "45", {
      dtmfMethod: "rfc2833",
      dtmfDurationMs: 120,
      dtmfGapMs: 50,
    });
    assert.strictEqual(dtmf.sent, 2);

    const dtmfLeg = daemon.legService.createLeg({
      legId: "runtime-leg-dtmf",
      direction: "outbound",
      transportType: "sip",
      status: "answered",
    });
    const dtmfPlayback = await runtime.playAudio(dtmfLeg.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: interruptPlaybackBinaryBase64,
      interruptOnDtmf: true,
    });
    await sleep(150);
    const dtmfWaitPromise = runtime.waitMedia({
      waitMediaIds: [dtmfPlayback.mediaId],
      waitMediaTimeoutSeconds: 0.1,
    });
    const legWaitPromise = runtime.waitForLegEvent(dtmfLeg.legId, {
      timeoutSeconds: 0.1,
      rules: [{ pattern: "7", label: "Digit 7" }],
      waitDtmfFallbackEnabled: true,
    });
    await sleep(10);
    await runtime.sendDtmf(dtmfLeg.legId, "7", {
      dtmfMethod: "rfc2833",
      dtmfDurationMs: 120,
      dtmfGapMs: 50,
    });
    const dtmfInterruptedMedia = await dtmfWaitPromise;
    const dtmfLegEvent = await legWaitPromise;
    assert.strictEqual(dtmfInterruptedMedia.status, "interrupted");
    assert.strictEqual(dtmfInterruptedMedia.interruptReason, "dtmf");
    assert.strictEqual(dtmfLegEvent.output, "matched");
    assert.strictEqual(dtmfLegEvent.digits, "7");

    const queueEvents = [];
    const queueStream = await runtime.openQueueTrigger({
      ref: "support-runtime",
      queueExtensions: ["200", "201"],
      queueRetryPauseSeconds: 0.01,
    }, (event) => queueEvents.push(event));

    daemon.extensionService.registerEndpoint({
      ref: "support-runtime",
      extensionNumber: "200",
      contactUri: "sip:200@office.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "support-runtime",
      extensionNumber: "201",
      contactUri: "sip:201@office.local",
    });
    daemon.legService.createLeg({
      legId: "runtime-operator-leg-200",
      direction: "inbound",
      transportType: "sip",
      status: "answered",
      triggerMetadata: {
        ref: "support-runtime",
        extensionNumber: "200",
      },
    });
    daemon.legService.createLeg({
      legId: "runtime-operator-leg-201",
      direction: "inbound",
      transportType: "sip",
      status: "answered",
      triggerMetadata: {
        ref: "support-runtime",
        extensionNumber: "201",
      },
    });

    const queueLeg = daemon.legService.createLeg({
      legId: "runtime-queue-leg-1",
      direction: "inbound",
      transportType: "sip",
      status: "created",
    });
    await runtime.enqueueLeg("support-runtime", queueLeg.legId, "back");
    await sleep(30);
    assert.ok(queueEvents.some((event) => event.branch === "Placed"));
    assert.ok(!queueEvents.some((event) => event.branch === "Dispatch"));

    daemon.legService.hangupLeg("runtime-operator-leg-200", "operator_free");
    await sleep(30);
    const firstReadyEvent = queueEvents.find((event) => event.branch === "Dispatch");
    assert.ok(firstReadyEvent);
    assert.ok(firstReadyEvent.payload.dialId);
    assert.strictEqual("extensionNumbers" in firstReadyEvent.payload, false);
    await runtime.breakDial(firstReadyEvent.payload.dialId, "retry");
    await sleep(30);
    assert.ok(queueEvents.filter((event) => event.branch === "Dispatch").length >= 2);
    const secondReadyEvent = queueEvents.filter((event) => event.branch === "Dispatch").slice(-1)[0];
    const secondDial = daemon.dialService.requireDial(secondReadyEvent.payload.dialId);
    daemon.dialService.markAttemptAnswered(secondDial.dialId, secondDial.attemptLegIds[0]);
    await sleep(30);
    await assert.rejects(
      runtime.getQueueStats({
        queueStatsTarget: "legId",
        legId: queueLeg.legId,
      }),
      /invalid_queue_stats_target|Unknown queue target|not in queue/i,
    );
    daemon.legService.hangupLeg("runtime-operator-leg-201", "operator_cleanup");

    const callbackEvents = [];
    const callbackStream = await runtime.openQueueTrigger({
      ref: "support-callback",
      queueExtensions: ["210"],
      queueRetryPauseSeconds: 0.01,
    }, (event) => callbackEvents.push(event));
    daemon.extensionService.registerEndpoint({
      ref: "support-callback",
      extensionNumber: "210",
      contactUri: "sip:210@office.local",
    });
    const callbackLeg = daemon.legService.createLeg({
      legId: "runtime-queue-leg-callback",
      direction: "inbound",
      transportType: "sip",
      status: "created",
      signalingDetails: {
        from: "+12025550123",
        callerName: "Callback Caller",
      },
      triggerMetadata: {
        ref: "carrier-runtime",
      },
    });
    await runtime.enqueueLeg("support-callback", callbackLeg.legId, "back");
    await runtime.setQueueCallback(callbackLeg.legId);
    await sleep(30);
    const callbackReadyEvent = callbackEvents.find((event) => event.branch === "Callback");
    assert.ok(callbackReadyEvent);
    assert.strictEqual(callbackReadyEvent.payload.callerNumber, "+12025550123");
    assert.strictEqual(callbackReadyEvent.payload.callerName, "Callback Caller");
    assert.strictEqual(callbackReadyEvent.payload.trunkRef, "carrier-runtime");
    assert.ok(callbackReadyEvent.payload.dialId);
    assert.strictEqual("legId" in callbackReadyEvent.payload, false);
    assert.strictEqual("extensionNumbers" in callbackReadyEvent.payload, false);
    const callbackDial = daemon.dialService.requireDial(callbackReadyEvent.payload.dialId);
    daemon.dialService.markAttemptAnswered(callbackDial.dialId, callbackDial.attemptLegIds[0]);
    await sleep(30);
    await assert.rejects(
      runtime.getQueueStats({
        queueStatsTarget: "legId",
        legId: callbackLeg.legId,
      }),
      /invalid_queue_stats_target|Unknown queue target|not in queue/i,
    );

    const noOperatorEvents = [];
    const noOperatorStream = await runtime.openQueueTrigger({
      ref: "support-empty",
      queueExtensions: [],
      queueRetryPauseSeconds: 0.01,
    }, (event) => noOperatorEvents.push(event));
    const noOperatorLeg = daemon.legService.createLeg({
      legId: "runtime-queue-leg-2",
      direction: "inbound",
      transportType: "sip",
      status: "created",
    });
    await runtime.enqueueLeg("support-empty", noOperatorLeg.legId, "back");
    await sleep(40);
    assert.ok(!noOperatorEvents.some((event) => event.branch === "Placed"));
    assert.ok(noOperatorEvents.some((event) => event.branch === "Offline"));
    await assert.rejects(
      runtime.getQueueStats({
        queueStatsTarget: "legId",
        legId: noOperatorLeg.legId,
      }),
      /invalid_queue_stats_target|Unknown queue target|not in queue/i,
    );

    const disappearingOperatorEvents = [];
    const disappearingOperatorStream = await runtime.openQueueTrigger({
      ref: "support-disappearing",
      queueExtensions: ["300"],
      queueRetryPauseSeconds: 0.01,
    }, (event) => disappearingOperatorEvents.push(event));
    daemon.extensionService.registerEndpoint({
      ref: "support-disappearing",
      extensionNumber: "300",
      contactUri: "sip:300@office.local",
    });
    const disappearingOperatorLeg = daemon.legService.createLeg({
      legId: "runtime-queue-leg-3",
      direction: "inbound",
      transportType: "sip",
      status: "created",
    });
    await runtime.enqueueLeg("support-disappearing", disappearingOperatorLeg.legId, "back");
    await sleep(15);
    assert.ok(disappearingOperatorEvents.some((event) => event.branch === "Dispatch"));
    daemon.extensionService.unregisterEndpoint("support-disappearing", "300");
    await sleep(30);
    assert.ok(disappearingOperatorEvents.some((event) => event.branch === "Offline"));

    const extensionsEventsA = [];
    const extensionsEventsB = [];
    const trunkEvents = [];
    const recordingDir = fs.mkdtempSync(path.join(process.cwd(), ".smoke-recording-"));
    const trunkStream = await runtime.openTrunkTrigger({
      ref: "carrier-runtime",
      enableCallRecording: true,
    }, (event) => trunkEvents.push(event));
    const extensionsStreamA = await runtime.openExtensionsTrigger({
      ref: "office-ext-runtime",
      extensionsLocalBindPort: 0,
      authMode: "raw",
      authTimeoutSeconds: 0.025,
    }, (event) => extensionsEventsA.push(event));
    const extensionsStreamB = await runtime.openExtensionsTrigger({
      ref: "office-ext-runtime",
      extensionsLocalBindPort: 0,
      authMode: "raw",
      authTimeoutSeconds: 0.025,
      extensionsEnableCallRecording: true,
    }, (event) => extensionsEventsB.push(event));
    daemon.authService.createRequest({
      triggerKey: "wf:office-ext-runtime",
      ref: "office-ext-runtime",
      requestContext: {
        requestType: "register",
        method: "REGISTER",
        username: "100",
      },
    });
    await sleep(10);
    assert.strictEqual(extensionsEventsA.length, 0);
    assert.ok(extensionsEventsB.some((event) => event.branch === "Auth"));
    const sessionInvite = daemon.extensionService.emitInboundInvite({
      ref: "office-ext-runtime",
      extensionNumber: "100",
      from: "sip:caller@example.test",
      to: "sip:100@office.local",
      callId: "auto-ext-call-1",
      callerName: "Caller",
    });
    const trunkInvite = daemon.trunkService.emitInboundInvite({
      ref: "carrier-runtime",
      from: "sip:caller@example.test",
      to: "sip:ivr@example.test",
      callId: "auto-trunk-call-1",
      callerName: "Caller",
    });
    await sleep(10);
    assert.ok(extensionsEventsB.some((event) => event.branch === "Call" && event.payload.legId === sessionInvite.legId && event.payload.callId === "auto-ext-call-1"));
    assert.ok(trunkEvents.some((event) => event.branch === "Call" && event.payload.callId === "auto-trunk-call-1"));
    await waitForCondition(
      () => trunkEvents.some((event) => event.branch === "Record") && extensionsEventsB.some((event) => event.branch === "Record"),
      1500,
      "record trigger emitted",
    );
    const trunkRecordEvent = trunkEvents.find((event) => event.branch === "Record");
    const extensionsRecordEvent = extensionsEventsB.find((event) => event.branch === "Record");
    assert.ok(trunkRecordEvent && trunkRecordEvent.payload && trunkRecordEvent.payload.recordRequestId);
    assert.ok(extensionsRecordEvent && extensionsRecordEvent.payload && extensionsRecordEvent.payload.recordRequestId);
    const extensionsRecordPath = path.join(recordingDir, `extensions-100-auto-ext-call-1-${sessionInvite.legId}.wav`);
    const trunkRecordPath = path.join(recordingDir, `trunk-auto-trunk-call-1-${trunkInvite.legId}.wav`);
    const trunkRecordCompletion = runtime.respondToRecord({
      recordRequestId: trunkRecordEvent.payload.recordRequestId,
      active: true,
      recordFilePath: trunkRecordPath,
      recordFileFormat: "wav",
      recordWavSampleRate: 8000,
      recordWavBitDepth: 16,
      recordSplitChannels: true,
      waitForRecordingCompletion: true,
    });
    await runtime.respondToRecord({
      recordRequestId: extensionsRecordEvent.payload.recordRequestId,
      active: true,
      recordFilePath: extensionsRecordPath,
      recordFileFormat: "wav",
      recordWavSampleRate: 8000,
      recordWavBitDepth: 16,
      recordSplitChannels: true,
    });
    await waitForCondition(() => fs.existsSync(extensionsRecordPath) && fs.existsSync(trunkRecordPath) && daemon.mediaService.hasActiveWork(), 1500, "recording started");
    daemon.legService.hangupLeg(sessionInvite.legId, "auto_recording_smoke");
    daemon.legService.hangupLeg(trunkInvite.legId, "auto_recording_smoke");
    const trunkRecordResult = await trunkRecordCompletion;
    assert.strictEqual(trunkRecordResult.filePath, trunkRecordPath);
    assert.ok(Number(trunkRecordResult.durationMs || 0) > 0);
    assert.ok(Number(trunkRecordResult.bytesProduced || 0) >= 24);
    await waitForCondition(() => fs.existsSync(extensionsRecordPath) && fs.statSync(extensionsRecordPath).size >= 24, 1500, "extensions recording");
    await waitForCondition(() => fs.existsSync(trunkRecordPath) && fs.statSync(trunkRecordPath).size >= 24, 1500, "trunk recording");
    assert.strictEqual(readWavChannelCount(extensionsRecordPath), 2);
    assert.strictEqual(readWavChannelCount(trunkRecordPath), 2);

    const staticExtensionsEvents = [];
    const staticExtensionsStream = await runtime.openExtensionsTrigger({
      ref: "office-ext-sip",
      transport: "udp",
      extensionsLocalBindIp: "127.0.0.1",
      extensionsLocalBindPort: 0,
      advertisedIp: "127.0.0.1",
      realm: "office.test",
      authMode: "static",
      staticCredentials: [
        {
          username: "401",
          password: "secret401",
          extension: "401",
        },
      ],
    }, (event) => staticExtensionsEvents.push(event));
    await sleep(20);
    const extensionEndpoint = daemon.sipTransportService.getExtensionsEndpoint("office-ext-sip");
    assert.ok(extensionEndpoint);
    const extensionClient = dgram.createSocket("udp4");
    await new Promise((resolve) => extensionClient.bind(0, "127.0.0.1", resolve));
    const extensionClientAddress = extensionClient.address();
    await sendUdp(extensionClient, buildOptions({
      requestUri: "sip:office.test",
      localHost: "127.0.0.1",
      localPort: extensionClientAddress.port,
      branch: "z9hG4bK-options-ext-1",
      from: "<sip:401@office.test>;tag=options-ext",
      to: "<sip:401@office.test>",
      callId: "options-ext-1",
      cseq: 1,
    }), extensionEndpoint.port, extensionEndpoint.host);
    const extensionOptionsNotImplemented = await waitForUdpMessage(extensionClient, (message) => message.statusCode === 501 && sipHeader(message, "cseq") === "1 OPTIONS", 1000, "extensions-options-not-implemented");
    assert.strictEqual(extensionOptionsNotImplemented.message.statusCode, 501);
    assert.ok(/REGISTER/.test(sipHeader(extensionOptionsNotImplemented.message, "allow")));
    const registerBase = {
      requestUri: "sip:office.test",
      localHost: "127.0.0.1",
      localPort: extensionClientAddress.port,
      username: "401",
      realm: "office.test",
      tag: "reg-tag",
      callId: "reg-call-401",
      cseq: 1,
      expires: 600,
      branch: "z9hG4bK-reg-1",
    };
    await sendUdp(extensionClient, buildRegister(registerBase), extensionEndpoint.port, extensionEndpoint.host);
    const challenge = await waitForUdpMessage(extensionClient, (message) => message.statusCode === 401, 1000, "extensions-register-challenge");
    const wwwAuthenticate = sipHeader(challenge.message, "www-authenticate");
    const nonceMatch = wwwAuthenticate.match(/nonce="([^"]+)"/);
    assert.ok(nonceMatch);
    const nonce = nonceMatch[1];
    const ha1 = md5("401:office.test:secret401");
    const ha2 = md5("REGISTER:sip:office.test");
    const response = md5(`${ha1}:${nonce}:00000001:clientcnonce:auth:${ha2}`);
    const authorization = `Digest username="401", realm="office.test", nonce="${nonce}", uri="sip:office.test", response="${response}", algorithm=MD5, qop=auth, nc=00000001, cnonce="clientcnonce"`;
    await sendUdp(extensionClient, buildRegister({
      ...registerBase,
      cseq: 2,
      branch: "z9hG4bK-reg-2",
      authorization,
    }), extensionEndpoint.port, extensionEndpoint.host);
	    const registerOk = await waitForUdpMessage(extensionClient, (message) => message.statusCode === 200, 1000, "extensions-register-ok");
	    assert.strictEqual(registerOk.message.statusCode, 200);
	    assert.deepStrictEqual(daemon.extensionService.listOnlineExtensionNumbers("office-ext-sip"), ["401"]);
    await sendUdp(extensionClient, buildRegister({
      ...registerBase,
      cseq: 3,
      branch: "z9hG4bK-reg-3",
      authorization,
    }), extensionEndpoint.port, extensionEndpoint.host);
    const replayRejected = await waitForUdpMessage(extensionClient, (message) => message.statusCode === 401, 1000, "extensions-register-replay-rejected");
    assert.strictEqual(replayRejected.message.statusCode, 401);
    assert.ok(sipHeader(replayRejected.message, "www-authenticate").includes("nonce="));

    const staticExtensionEventCountBeforeInvite = staticExtensionsEvents.filter((event) => event.branch === "Call").length;
    const originalEnsureTransportEndpoint = daemon.mediaService.ensureTransportEndpoint.bind(daemon.mediaService);
    daemon.mediaService.ensureTransportEndpoint = async (...args) => {
      await sleep(200);
      return await originalEnsureTransportEndpoint(...args);
    };
    try {
      const extensionInviteRtpSocket = dgram.createSocket("udp4");
      await new Promise((resolve) => extensionInviteRtpSocket.bind(0, "127.0.0.1", resolve));
      const extensionInviteRtpAddress = extensionInviteRtpSocket.address();
      const negotiatedOfferSdp = [
        "v=0",
        "o=- 3985199638 3985199638 IN IP4 127.0.0.1",
        "s=pjmedia",
        "b=AS:117",
        "t=0 0",
        "a=X-nat:0",
        `m=audio ${extensionInviteRtpAddress.port} RTP/AVP 96 9 8 0 101 102`,
        "c=IN IP4 192.0.2.10",
        `a=rtcp:${extensionInviteRtpAddress.port + 1} IN IP4 127.0.0.1`,
        "a=sendrecv",
        "a=rtpmap:96 opus/48000/2",
        "a=fmtp:96 useinbandfec=1",
        "a=rtpmap:9 G722/8000",
        "a=rtpmap:8 PCMA/8000",
        "a=rtpmap:0 PCMU/8000",
        "a=rtpmap:101 telephone-event/48000",
        "a=fmtp:101 0-16",
        "a=rtpmap:102 telephone-event/8000",
        "a=fmtp:102 0-16",
        "a=ssrc:92752265 cname:test",
      ].join("\r\n");
      const baseInvite = {
        requestUri: "sip:401@office.test",
        localHost: "127.0.0.1",
        localPort: extensionClientAddress.port,
        from: "\"Extension Caller\" <sip:caller@office.test>;tag=invite-tag-1",
        to: "<sip:401@office.test>",
        callId: "invite-call-401",
        cseq: 1,
        branch: "z9hG4bK-invite-1",
        contactUser: "caller",
        body: negotiatedOfferSdp,
      };
      await sendUdp(extensionClient, buildInvite(baseInvite), extensionEndpoint.port, extensionEndpoint.host);
      const inviteChallenge = await waitForUdpMessage(extensionClient, (message) => message.statusCode === 401 && sipHeader(message, "cseq") === "1 INVITE", 1000, "extensions-invite-challenge");
      const inviteNonce = /nonce="([^"]+)"/.exec(sipHeader(inviteChallenge.message, "www-authenticate"))[1];
      const inviteHa1 = md5("401:office.test:secret401");
      const inviteHa2 = md5("INVITE:sip:401@office.test");
      const inviteResponse = md5(`${inviteHa1}:${inviteNonce}:00000001:invitecnonce:auth:${inviteHa2}`);
      const inviteAuthorization = `Digest username="401", realm="office.test", nonce="${inviteNonce}", uri="sip:401@office.test", response="${inviteResponse}", algorithm=MD5, qop=auth, nc=00000001, cnonce="invitecnonce"`;
      await sendUdp(extensionClient, [
        "ACK sip:401@office.test SIP/2.0",
        `Via: SIP/2.0/UDP 127.0.0.1:${extensionClientAddress.port};branch=z9hG4bK-invite-ack-1`,
        "Max-Forwards: 70",
        "From: \"Extension Caller\" <sip:caller@office.test>;tag=invite-tag-1",
        `To: ${sipHeader(inviteChallenge.message, "to")}`,
        "Call-ID: invite-call-401",
        "CSeq: 1 ACK",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"), extensionEndpoint.port, extensionEndpoint.host);
      const extensionTryingPromise = waitForUdpMessage(extensionClient, (message) => message.statusCode === 100 && sipHeader(message, "call-id") === "invite-call-401", 1000, "extensions-invite-trying");
      const extensionOkPromise = waitForUdpMessage(extensionClient, (message) => message.statusCode === 200 && sipHeader(message, "call-id") === "invite-call-401", 1500, "extensions-invite-ok");
      await sendUdp(extensionClient, buildInvite({
        ...baseInvite,
        branch: "z9hG4bK-invite-2",
        extraHeaders: {
          Authorization: inviteAuthorization,
        },
      }), extensionEndpoint.port, extensionEndpoint.host);
      await waitForCondition(() => staticExtensionsEvents.filter((event) => event.branch === "Call").length === staticExtensionEventCountBeforeInvite + 1, 1000, "extensions-invite-event");
      const staticInviteEvent = staticExtensionsEvents.filter((event) => event.branch === "Call")[staticExtensionEventCountBeforeInvite];
      assert.ok(staticInviteEvent);
      await runtime.answer(staticInviteEvent.payload.legId);
      const extensionTrying = await extensionTryingPromise;
      assert.strictEqual(extensionTrying.message.statusCode, 100);
      const extensionOk = await extensionOkPromise;
      assert.strictEqual(extensionOk.message.statusCode, 200);
      const extensionAnswerPayloadTypes = parseAudioPayloadTypesFromSdp(extensionOk.message.body);
      const extensionAnswerRtpMap = parseSdpRtpMap(extensionOk.message.body);
      const extensionAnswerFmtp = parseSdpFmtp(extensionOk.message.body);
      assert.deepStrictEqual(extensionAnswerPayloadTypes, [96, 101]);
      assert.strictEqual(extensionAnswerRtpMap[96], "opus/48000/2");
      assert.strictEqual(extensionAnswerFmtp[96], "useinbandfec=1");
      assert.strictEqual(extensionAnswerRtpMap[101], "telephone-event/48000");
      assert.strictEqual(extensionAnswerFmtp[101], "0-16");
      assert.strictEqual(extensionAnswerRtpMap[102], undefined);
      const extensionAnswerAudioPort = parseAudioPortFromSdp(extensionOk.message.body);
      assert.ok(extensionAnswerAudioPort > 0);
      await sendUdp(extensionInviteRtpSocket, buildRtpDtmfPacket(101, "1", 1, 160), extensionAnswerAudioPort, "127.0.0.1");
      await sleep(25);
      const extensionPlaybackRtpPromise = waitForUdpBuffer(extensionInviteRtpSocket, (buffer) => buffer.length > 12 && (buffer[0] >> 6) === 2, 1000, "extensions-rtp-playback");
      const extensionPlayback = await runtime.playAudio(staticInviteEvent.payload.legId, {
        mediaExecutionMode: "background",
        sourceType: "binary",
        binaryProperty: "audio",
        binaryDataBase64: playbackBinaryBase64,
      });
      assert.strictEqual(extensionPlayback.status, "started");
      const extensionPlaybackPacket = await extensionPlaybackRtpPromise;
      assert.ok(extensionPlaybackPacket.buffer.length > 12);
      await sendUdp(extensionClient, [
        `ACK ${(/<([^>]+)>/.exec(sipHeader(extensionOk.message, "contact")) || [])[1] || "sip:401@office.test"} SIP/2.0`,
        `Via: SIP/2.0/UDP 127.0.0.1:${extensionClientAddress.port};branch=z9hG4bK-invite-ack-2`,
        "Max-Forwards: 70",
        "From: \"Extension Caller\" <sip:caller@office.test>;tag=invite-tag-1",
        `To: ${sipHeader(extensionOk.message, "to")}`,
        "Call-ID: invite-call-401",
        "CSeq: 1 ACK",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"), extensionEndpoint.port, extensionEndpoint.host);
      const extensionPlaybackWaitPromise = runtime.waitMedia({
        waitMediaIds: [extensionPlayback.mediaId],
        waitMediaTimeoutSeconds: 1,
      });
      const extensionByeText = [
        `BYE ${(/<([^>]+)>/.exec(sipHeader(extensionOk.message, "contact")) || [])[1] || "sip:401@office.test"} SIP/2.0`,
        `Via: SIP/2.0/UDP 127.0.0.1:${extensionClientAddress.port};branch=z9hG4bK-invite-bye-1`,
        "Max-Forwards: 70",
        "From: \"Extension Caller\" <sip:caller@office.test>;tag=invite-tag-1",
        `To: ${sipHeader(extensionOk.message, "to")}`,
        "Call-ID: invite-call-401",
        "CSeq: 2 BYE",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n");
      await sendUdp(extensionClient, extensionByeText, extensionEndpoint.port, extensionEndpoint.host);
      const extensionByeOk = await waitForUdpMessage(extensionClient, (message) => message.statusCode === 200 && sipHeader(message, "cseq") === "2 BYE", 1000, "extensions-bye-ok");
      assert.strictEqual(extensionByeOk.message.statusCode, 200);
      const extensionPlaybackWait = await extensionPlaybackWaitPromise;
      assert.strictEqual(extensionPlaybackWait.status, "interrupted");
      assert.strictEqual(extensionPlaybackWait.interruptReason, "leg_ended");
      await waitForCondition(() => {
        const leg = daemon.legService.getLeg(staticInviteEvent.payload.legId);
        return !leg || leg.status === "ended";
      }, 1000, "extensions-leg-ended");
      await waitForCondition(() => !daemon.legService.getLeg(staticInviteEvent.payload.legId), 1000, "extensions-leg-removed");
      extensionInviteRtpSocket.close();
    } finally {
      daemon.mediaService.ensureTransportEndpoint = originalEnsureTransportEndpoint;
    }

	    const rawAuthEvents = [];
	    const rawAuthStream = await runtime.openExtensionsTrigger({
	      ref: "office-ext-raw",
	      transport: "udp",
	      extensionsLocalBindIp: "127.0.0.1",
	      extensionsLocalBindPort: 0,
	      advertisedIp: "127.0.0.1",
	      realm: "office.raw",
	      authMode: "raw",
	      authTimeoutSeconds: 1,
	    }, (event) => rawAuthEvents.push(event));
	    await sleep(20);
	    const rawEndpoint = daemon.sipTransportService.getExtensionsEndpoint("office-ext-raw");
	    assert.ok(rawEndpoint);
	    const rawClient = dgram.createSocket("udp4");
	    await new Promise((resolve) => rawClient.bind(0, "127.0.0.1", resolve));
	    const rawClientAddress = rawClient.address();
	    const rawRegisterPromise = waitForUdpMessage(rawClient, (message) => message.statusCode === 200, 1000, "extensions-raw-ok");
	    await sendUdp(rawClient, buildRegister({
	      requestUri: "sip:office.raw",
	      localHost: "127.0.0.1",
	      localPort: rawClientAddress.port,
	      username: "501",
	      realm: "office.raw",
	      tag: "raw-tag",
	      callId: "raw-call-501",
	      cseq: 1,
	      expires: 600,
	      branch: "z9hG4bK-raw-1",
	    }), rawEndpoint.port, rawEndpoint.host);
	    await sleep(20);
	    const rawAuthEvent = rawAuthEvents.find((event) => event.branch === "Auth");
	    assert.ok(rawAuthEvent);
	    await runtime.respondToAuth({
	      authRequestId: rawAuthEvent.payload.authRequestId,
	      authAction: "allow",
	      extension: "501",
	    });
	    const rawRegisterOk = await rawRegisterPromise;
	    assert.strictEqual(rawRegisterOk.message.statusCode, 200);
	    assert.deepStrictEqual(daemon.extensionService.listOnlineExtensionNumbers("office-ext-raw"), ["501"]);

	    const digestAuthEvents = [];
	    const digestAuthStream = await runtime.openExtensionsTrigger({
	      ref: "office-ext-digest",
	      transport: "udp",
	      extensionsLocalBindIp: "127.0.0.1",
	      extensionsLocalBindPort: 0,
	      advertisedIp: "127.0.0.1",
	      realm: "office.digest",
	      authMode: "digest-first",
	      authTimeoutSeconds: 1,
	    }, (event) => digestAuthEvents.push(event));
	    await sleep(20);
	    const digestEndpoint = daemon.sipTransportService.getExtensionsEndpoint("office-ext-digest");
	    assert.ok(digestEndpoint);
	    const digestClient = dgram.createSocket("udp4");
	    await new Promise((resolve) => digestClient.bind(0, "127.0.0.1", resolve));
	    const digestClientAddress = digestClient.address();
	    await sendUdp(digestClient, buildRegister({
	      requestUri: "sip:office.digest",
	      localHost: "127.0.0.1",
	      localPort: digestClientAddress.port,
	      username: "601",
	      realm: "office.digest",
	      tag: "digest-tag",
	      callId: "digest-call-601",
	      cseq: 1,
	      expires: 600,
	      branch: "z9hG4bK-digest-1",
	    }), digestEndpoint.port, digestEndpoint.host);
	    const digestChallenge = await waitForUdpMessage(digestClient, (message) => message.statusCode === 401, 1000, "extensions-digest-challenge");
	    const digestNonce = /nonce="([^"]+)"/.exec(sipHeader(digestChallenge.message, "www-authenticate"))[1];
	    const digestHa1 = md5("601:office.digest:secret601");
	    const digestHa2 = md5("REGISTER:sip:office.digest");
	    const digestResponse = md5(`${digestHa1}:${digestNonce}:00000001:digestcnonce:auth:${digestHa2}`);
	    const digestAuthorization = `Digest username="601", realm="office.digest", nonce="${digestNonce}", uri="sip:office.digest", response="${digestResponse}", algorithm=MD5, qop=auth, nc=00000001, cnonce="digestcnonce"`;
	    const digestOkPromise = waitForUdpMessage(digestClient, (message) => message.statusCode === 200, 1000, "extensions-digest-ok");
	    await sendUdp(digestClient, buildRegister({
	      requestUri: "sip:office.digest",
	      localHost: "127.0.0.1",
	      localPort: digestClientAddress.port,
	      username: "601",
	      realm: "office.digest",
	      tag: "digest-tag",
	      callId: "digest-call-601",
	      cseq: 2,
	      expires: 600,
	      branch: "z9hG4bK-digest-2",
	      authorization: digestAuthorization,
	    }), digestEndpoint.port, digestEndpoint.host);
	    await sleep(20);
	    const digestAuthEvent = digestAuthEvents.find((event) => event.branch === "Auth");
	    assert.ok(digestAuthEvent);
	    await runtime.respondToAuth({
	      authRequestId: digestAuthEvent.payload.authRequestId,
	      authAction: "verify_password",
	      password: "secret601",
	      extension: "601",
	    });
	    const digestRegisterOk = await digestOkPromise;
	    assert.strictEqual(digestRegisterOk.message.statusCode, 200);
	    assert.deepStrictEqual(daemon.extensionService.listOnlineExtensionNumbers("office-ext-digest"), ["601"]);

	    const extensionDial = await runtime.makeDial({
	      callMode: "extension",
      callStrategy: "parallel",
      ref: "office-ext-sip",
      extensionNumbers: ["401"],
    });
    const extensionInvite = await waitForUdpMessage(extensionClient, (message) => message.method === "INVITE", 1000, "extensions-invite");
    await sendUdp(extensionClient, buildResponse(extensionInvite.message, 180, "Ringing"), extensionInvite.rinfo.port, extensionInvite.rinfo.address);
	    const extensionDialRinging = await runtime.waitForDialEvent(extensionDial.dialId, {
	      dialTimeoutSeconds: 1,
	      waitEventOutputs: ["ringing"],
	    });
	    assert.strictEqual(extensionDialRinging.eventType, "ringing");
	    const extensionAnsweredPromise = runtime.waitForDialEvent(extensionDial.dialId, {
	      dialTimeoutSeconds: 1,
	    });
	    const extensionAckPromise = waitForUdpMessage(extensionClient, (message) => message.method === "ACK", 1000, "extensions-ack");
	    await sleep(10);
	    await sendUdp(extensionClient, buildResponse(extensionInvite.message, 200, "OK", {
	      Contact: `<sip:401@127.0.0.1:${extensionClientAddress.port}>`,
	    }), extensionInvite.rinfo.port, extensionInvite.rinfo.address);
	    const extensionDialAnswered = await extensionAnsweredPromise;
	    assert.strictEqual(extensionDialAnswered.eventType, "answered");
	    const extensionAck = await extensionAckPromise;
	    assert.strictEqual(extensionAck.message.method, "ACK");
	    const extensionByePromise = waitForUdpMessage(extensionClient, (message) => message.method === "BYE", 1000, "extensions-bye");
	    await runtime.hangup(extensionDialAnswered.legId);
	    const extensionBye = await extensionByePromise;
	    assert.strictEqual(extensionBye.message.method, "BYE");

	    const directPeer = dgram.createSocket("udp4");
	    await new Promise((resolve) => directPeer.bind(0, "127.0.0.1", resolve));
	    const directPeerAddress = directPeer.address();
	    const directRtpPeer = dgram.createSocket("udp4");
	    await new Promise((resolve) => directRtpPeer.bind(0, "127.0.0.1", resolve));
	    const directRtpPeerAddress = directRtpPeer.address();
	    const directDial = await runtime.makeDial({
	      callMode: "direct",
	      callStrategy: "parallel",
	      destination: ["700"],
	      sipCredentials: {
	        sipServer: "127.0.0.1",
	        port: directPeerAddress.port,
	        localBindIp: "127.0.0.1",
	        localBindPort: 0,
	        transport: "udp",
	        username: "direct-user",
	        publicDomain: "127.0.0.1",
	      },
	    });
	    const directInviteInitial = await waitForUdpMessage(directPeer, (message) => message.method === "INVITE", 1000, "direct-invite-initial");
	    const directInviteRetransmit = await waitForUdpMessage(directPeer, (message) => {
	      return message.method === "INVITE"
	        && buildInviteTransactionKey(message) === buildInviteTransactionKey(directInviteInitial.message);
	    }, 1500, "direct-invite-retransmit");
	    const directInvite = directInviteRetransmit;
	    assert.strictEqual(directInvite.message.requestUri, `sip:700@127.0.0.1:${directPeerAddress.port}`);
	    const directInvitePayloadTypes = parseAudioPayloadTypesFromSdp(directInvite.message.body);
	    const directInviteRtpMap = parseSdpRtpMap(directInvite.message.body);
	    assert.ok(directInvitePayloadTypes.length >= 3);
	    assert.strictEqual(directInviteRtpMap[0], "PCMU/8000");
	    assert.strictEqual(directInviteRtpMap[8], "PCMA/8000");
	    const directLocalRtpPort = parseAudioPortFromSdp(directInvite.message.body);
	    assert.ok(directLocalRtpPort > 0);
	    await sendUdp(directPeer, buildResponse(directInvite.message, 180, "Ringing"), directInvite.rinfo.port, directInvite.rinfo.address);
	    const directRinging = await runtime.waitForDialEvent(directDial.dialId, {
	      dialTimeoutSeconds: 1,
	      waitEventOutputs: ["ringing"],
	    });
	    assert.strictEqual(directRinging.eventType, "ringing");
	    const directAnsweredPromise = runtime.waitForDialEvent(directDial.dialId, {
	      dialTimeoutSeconds: 1,
	    });
	    const directAckPromise = waitForUdpMessage(directPeer, (message) => message.method === "ACK", 1000, "direct-ack");
	    await sleep(10);
	    const directAnswerSdp = [
	      "v=0",
	      `o=- ${Date.now()} ${Date.now()} IN IP4 127.0.0.1`,
	      "s=smoke",
	      "c=IN IP4 127.0.0.1",
	      "t=0 0",
	      `m=audio ${directRtpPeerAddress.port} RTP/AVP 8 9 97`,
	      "a=rtpmap:8 PCMA/8000",
	      "a=rtpmap:9 G722/8000",
	      "a=rtpmap:97 telephone-event/8000",
	      "a=fmtp:97 0-16",
	      "a=ptime:20",
	      "a=sendrecv",
	    ].join("\r\n");
	    await sendUdp(directPeer, buildResponseWithBody(directInvite.message, 200, "OK", {
	      Contact: `<sip:700@127.0.0.1:${directPeerAddress.port}>`,
	      "Content-Type": "application/sdp",
	    }, directAnswerSdp), directInvite.rinfo.port, directInvite.rinfo.address);
	    const directAnswered = await directAnsweredPromise;
	    assert.strictEqual(directAnswered.eventType, "answered");
	    const directAck = await directAckPromise;
	    assert.strictEqual(directAck.message.method, "ACK");
	    const directLegDetails = daemon.legService.requireLeg(directAnswered.legId).signalingDetails;
	    assert.strictEqual(directLegDetails.audioPayloadType, 8);
	    assert.strictEqual(directLegDetails.dtmfPayloadType, 97);
	    assert.strictEqual(String((directLegDetails.payloadCodecs || {})[9]?.codec || ""), "g722");
	    const directVoicePlayback = await runtime.playAudio(directAnswered.legId, {
	      mediaExecutionMode: "background",
	      sourceType: "binary",
	      binaryProperty: "audio",
	      binaryDataBase64: playbackBinaryBase64,
	      interruptOnVoice: true,
	      voiceThreshold: 0.1,
	      voiceDurationMs: 60,
	    });
	    const directVoiceInterruptedPromise = runtime.waitMedia({
	      waitMediaIds: [directVoicePlayback.mediaId],
	      waitMediaTimeoutSeconds: 1,
	    });
	    const directPcmaCodec = createCodec("pcma");
	    const directPcmaDescriptor = directPcmaCodec.resolveDescriptor(8, {
	      8: { codec: "pcma", clockRate: 8000, channels: 1 },
	    });
	    assert.ok(directPcmaDescriptor);
	    const directPcmaPayloadTarget = Buffer.allocUnsafe(512);
	    const directSpeechFrame = createSpeechPcmFrame();
	    const directPcmaPayloadLength = directPcmaCodec.encodeRtpPayload(
	      directPcmaDescriptor,
	      directSpeechFrame,
	      1,
	      directPcmaPayloadTarget,
	    );
	    assert.ok(directPcmaPayloadLength > 0);
	    for (let index = 0; index < 3; index += 1) {
	      await sendUdpBuffer(
	        directRtpPeer,
	        buildRtpPacket(
	          8,
	          directPcmaPayloadTarget.subarray(0, directPcmaPayloadLength),
	          100 + index,
	          160 * (index + 1),
	          3210,
	        ),
	        directLocalRtpPort,
	        "127.0.0.1",
	      );
	    }
	    directPcmaCodec.close();
	    const directVoiceInterrupted = await directVoiceInterruptedPromise;
	    assert.strictEqual(directVoiceInterrupted.status, "interrupted");
	    assert.strictEqual(directVoiceInterrupted.interruptReason, "voice");
	    const directDtmfPacketPromise = waitForUdpBuffer(
	      directRtpPeer,
	      (buffer) => buffer.length > 12 && rtpPayloadType(buffer) === 97,
	      1000,
	      "direct-rtp-dtmf",
	    );
	    const directDtmf = await runtime.sendDtmf(directAnswered.legId, "5", {
	      dtmfMethod: "rfc2833",
	    });
	    assert.strictEqual(directDtmf.method, "rfc2833");
	    const directDtmfPacket = await directDtmfPacketPromise;
	    assert.ok(directDtmfPacket.buffer.length > 12);
	    const directDtmfLegEvent = await runtime.waitForLegEvent(directAnswered.legId, {
	      timeoutSeconds: 1,
	      interdigitTimeoutSeconds: 0.001,
	      rules: [],
	      waitDtmfFallbackEnabled: true,
	      waitDtmfMultiDigitFallbackEnabled: false,
	    });
	    assert.strictEqual(directDtmfLegEvent.output, "dtmfFallback");
	    assert.strictEqual(directDtmfLegEvent.digits, "5");
	    const directInfoPromise = waitForUdpMessage(directPeer, (message) => message.method === "INFO", 1000, "direct-info-dtmf");
	    const directInfo = await runtime.sendDtmf(directAnswered.legId, "6", {
	      dtmfMethod: "info",
	    });
	    assert.strictEqual(directInfo.method, "info");
	    const directInfoRequest = await directInfoPromise;
	    assert.strictEqual(directInfoRequest.message.method, "INFO");
	    assert.strictEqual(sipHeader(directInfoRequest.message, "content-type"), "application/dtmf-relay");
	    assert.ok(String(directInfoRequest.message.body || "").includes("Signal=6"));
	    await sendUdp(directPeer, buildResponse(directInfoRequest.message, 200, "OK"), directInfoRequest.rinfo.port, directInfoRequest.rinfo.address);
	    const directInfoLegEvent = await runtime.waitForLegEvent(directAnswered.legId, {
	      timeoutSeconds: 1,
	      interdigitTimeoutSeconds: 0.001,
	      rules: [],
	      waitDtmfFallbackEnabled: true,
	      waitDtmfMultiDigitFallbackEnabled: false,
	    });
	    assert.strictEqual(directInfoLegEvent.output, "dtmfFallback");
	    assert.strictEqual(directInfoLegEvent.digits, "6");
	    const directInbandPacketPromise = waitForUdpBuffer(
	      directRtpPeer,
	      (buffer) => buffer.length > 12 && rtpPayloadType(buffer) === 8,
	      1000,
	      "direct-inband-dtmf",
	    );
	    const directInband = await runtime.sendDtmf(directAnswered.legId, "7", {
	      dtmfMethod: "inband",
	    });
	    assert.strictEqual(directInband.method, "inband");
	    const directInbandPacket = await directInbandPacketPromise;
	    assert.ok(directInbandPacket.buffer.length > 12);
	    const directInbandLegEvent = await runtime.waitForLegEvent(directAnswered.legId, {
	      timeoutSeconds: 1,
	      interdigitTimeoutSeconds: 0.001,
	      rules: [],
	      waitDtmfFallbackEnabled: true,
	      waitDtmfMultiDigitFallbackEnabled: false,
	    });
	    assert.strictEqual(directInbandLegEvent.output, "dtmfFallback");
	    assert.strictEqual(directInbandLegEvent.digits, "7");
	    const inboundInfoEventPromise = runtime.waitForLegEvent(directAnswered.legId, {
	      timeoutSeconds: 1,
	      interdigitTimeoutSeconds: 0.001,
	      rules: [],
	      waitDtmfFallbackEnabled: true,
	      waitDtmfMultiDigitFallbackEnabled: false,
	    });
	    const inboundInfoPromise = waitForUdpMessage(directPeer, (message) => message.statusCode === 200 && sipHeader(message, "cseq") === "2 INFO", 1000, "direct-inbound-info-ok");
	    await sendUdp(directPeer, buildInfo({
	      requestUri: `sip:direct-user@127.0.0.1:${directInvite.rinfo.port}`,
	      localHost: "127.0.0.1",
	      localPort: directPeerAddress.port,
	      branch: "z9hG4bK-direct-info-inbound",
	      from: `${sipHeader(directInvite.message, "to")};tag=remote`,
	      to: sipHeader(directInvite.message, "from"),
	      callId: sipHeader(directInvite.message, "call-id"),
	      cseq: 2,
	      contactUser: "700",
	      body: "Signal=8\r\nDuration=160",
	    }), directInvite.rinfo.port, directInvite.rinfo.address);
	    const inboundInfoOk = await inboundInfoPromise;
	    assert.strictEqual(inboundInfoOk.message.statusCode, 200);
	    const inboundInfoEvent = await inboundInfoEventPromise;
	    assert.strictEqual(inboundInfoEvent.output, "dtmfFallback");
	    assert.strictEqual(inboundInfoEvent.digits, "8");
	    const directPlaybackPromise = waitForUdpBuffer(directRtpPeer, (buffer) => buffer.length > 12 && (buffer[0] >> 6) === 2, 1000, "direct-rtp-playback");
	    const directPlayback = await runtime.playAudio(directAnswered.legId, {
	      mediaExecutionMode: "background",
	      sourceType: "binary",
	      binaryProperty: "audio",
	      binaryDataBase64: playbackBinaryBase64,
	    });
	    assert.strictEqual(directPlayback.status, "started");
	    const directPlaybackPacket = await directPlaybackPromise;
	    assert.ok(directPlaybackPacket.buffer.length > 12);
	    assert.strictEqual(rtpPayloadType(directPlaybackPacket.buffer), 8);
	    await runtime.stopMedia({
	      stopMediaTarget: "mediaId",
	      stopMediaId: directPlayback.mediaId,
	      stopMediaReason: "direct_playback_cleanup",
	    });
	    const directPreRollPcmaCodec = createCodec("pcma");
	    const directPreRollPcmaDescriptor = directPreRollPcmaCodec.resolveDescriptor(8, {
	      8: { codec: "pcma", clockRate: 8000, channels: 1 },
	    });
	    assert.ok(directPreRollPcmaDescriptor);
	    const directPreRollPayloadTarget = Buffer.allocUnsafe(512);
	    const directPreRollSpeechFrame = createSpeechPcmFrame();
	    const directPreRollPayloadLength = directPreRollPcmaCodec.encodeRtpPayload(
	      directPreRollPcmaDescriptor,
	      directPreRollSpeechFrame,
	      1,
	      directPreRollPayloadTarget,
	    );
	    assert.ok(directPreRollPayloadLength > 0);
	    for (let index = 0; index < 3; index += 1) {
	      await sendUdpBuffer(
	        directRtpPeer,
	        buildRtpPacket(
	          8,
	          directPreRollPayloadTarget.subarray(0, directPreRollPayloadLength),
	          400 + index,
	          160 * (index + 1),
	          6543,
	        ),
	        directLocalRtpPort,
	        "127.0.0.1",
	      );
	    }
	    directPreRollPcmaCodec.close();
	    const directPreRollRecording = await runtime.recordAudio(directAnswered.legId, {
	      mediaExecutionMode: "background",
	      recordOutputType: "binary",
	      recordFileFormat: "wav",
	      recordBinaryProperty: "directPreRollAudio",
	    });
	    assert.strictEqual(directPreRollRecording.status, "started");
	    await sleep(40);
	    const directPreRollStop = await runtime.stopMedia({
	      stopMediaTarget: "mediaId",
	      stopMediaId: directPreRollRecording.mediaId,
	      stopMediaReason: "direct_recording_preroll_complete",
	    });
	    assert.strictEqual(directPreRollStop.status, "interrupted");
	    assert.ok(directPreRollStop.outputBinaryBase64);
	    const directPreRollBuffer = Buffer.from(directPreRollStop.outputBinaryBase64, "base64");
	    assert.ok(
	      readWavLeadingAverageAbsLevel(directPreRollBuffer, 80) > 1000,
	      "direct pre-roll recording must start with preserved inbound speech",
	    );
	    assert.strictEqual(directPreRollStop.outputBinaryProperty, "directPreRollAudio");
	    const directRecording = await runtime.recordAudio(directAnswered.legId, {
	      mediaExecutionMode: "background",
	      recordOutputType: "binary",
	      recordFileFormat: "wav",
	      recordBinaryProperty: "directRtpAudio",
	    });
	    assert.strictEqual(directRecording.status, "started");
	    const g722Codec = createCodec("g722");
	    const g722Descriptor = g722Codec.resolveDescriptor(9, {
	      9: { codec: "g722", clockRate: 8000, channels: 1 },
	    });
	    assert.ok(g722Descriptor);
	    const g722PayloadTarget = Buffer.allocUnsafe(512);
	    const g722PayloadLength = g722Codec.encodeRtpPayload(g722Descriptor, Buffer.alloc(320, 0x55), 1, g722PayloadTarget);
	    assert.ok(g722PayloadLength > 0);
	    const inboundRtp = buildRtpPacket(
	      9,
	      g722PayloadTarget.subarray(0, g722PayloadLength),
	      1,
	      160,
	      1234,
	    );
	    g722Codec.close();
	    await new Promise((resolve, reject) => {
	      directRtpPeer.send(inboundRtp, directLocalRtpPort, "127.0.0.1", (error) => {
	        if (error) reject(error);
	        else resolve();
	      });
	    });
	    await sleep(30);
	    const directRecordingStop = await runtime.stopMedia({
	      stopMediaTarget: "mediaId",
	      stopMediaId: directRecording.mediaId,
	      stopMediaReason: "direct_recording_complete",
	    });
	    assert.strictEqual(directRecordingStop.status, "interrupted");
	    assert.ok(directRecordingStop.outputBinaryBase64);
	    assert.strictEqual(directRecordingStop.outputBinaryProperty, "directRtpAudio");
	    const directSilencePcmaCodec = createCodec("pcma");
	    const directSilencePcmaDescriptor = directSilencePcmaCodec.resolveDescriptor(8, {
	      8: { codec: "pcma", clockRate: 8000, channels: 1 },
	    });
	    assert.ok(directSilencePcmaDescriptor);
	    const directSilencePayloadTarget = Buffer.allocUnsafe(512);
	    const directSilencePayloadLength = directSilencePcmaCodec.encodeRtpPayload(
	      directSilencePcmaDescriptor,
	      Buffer.alloc(320, 0),
	      1,
	      directSilencePayloadTarget,
	    );
	    assert.ok(directSilencePayloadLength > 0);
	    for (let index = 0; index < 60; index += 1) {
	      await sendUdpBuffer(
	        directRtpPeer,
	        buildRtpPacket(
	          8,
	          directSilencePayloadTarget.subarray(0, directSilencePayloadLength),
	          450 + index,
	          160 * (index + 1),
	          7654,
	        ),
	        directLocalRtpPort,
	        "127.0.0.1",
	      );
	    }
	    const directSilenceRecording = await runtime.recordAudio(directAnswered.legId, {
	      mediaExecutionMode: "background",
	      recordOutputType: "binary",
	      recordFileFormat: "wav",
	      recordBinaryProperty: "directSilenceAudio",
	      interruptOnSilence: true,
	      silenceThreshold: 0.01,
	      silenceDurationMs: 40,
	    });
	    assert.strictEqual(directSilenceRecording.status, "started");
	    const directSilenceWaitPromise = runtime.waitMedia({
	      waitMediaIds: [directSilenceRecording.mediaId],
	      waitMediaTimeoutSeconds: 1,
	    });
	    for (let index = 0; index < 3; index += 1) {
	      await sendUdpBuffer(
	        directRtpPeer,
	        buildRtpPacket(
	          8,
	          directSilencePayloadTarget.subarray(0, directSilencePayloadLength),
	          510 + index,
	          160 * (61 + index),
	          7654,
	        ),
	        directLocalRtpPort,
	        "127.0.0.1",
	      );
	    }
	    directSilencePcmaCodec.close();
	    const directSilenceInterrupted = await directSilenceWaitPromise;
	    assert.strictEqual(directSilenceInterrupted.status, "interrupted");
	    assert.strictEqual(directSilenceInterrupted.interruptReason, "silence");
	    assert.ok(directSilenceInterrupted.outputBinaryBase64);
	    const directSilenceBuffer = Buffer.from(directSilenceInterrupted.outputBinaryBase64, "base64");
	    assert.ok(directSilenceBuffer.length > 44);
	    assert.strictEqual(directSilenceInterrupted.outputBinaryProperty, "directSilenceAudio");
	    const directNoRtpSilenceRecording = await runtime.recordAudio(directAnswered.legId, {
	      mediaExecutionMode: "background",
	      recordOutputType: "binary",
	      recordFileFormat: "wav",
	      recordBinaryProperty: "directNoRtpSilenceAudio",
	      interruptOnSilence: true,
	      silenceThreshold: 0.01,
	      silenceDurationMs: 40,
	    });
	    assert.strictEqual(directNoRtpSilenceRecording.status, "started");
	    const directNoRtpSilenceInterrupted = await runtime.waitMedia({
	      waitMediaIds: [directNoRtpSilenceRecording.mediaId],
	      waitMediaTimeoutSeconds: 1,
	    });
	    assert.strictEqual(directNoRtpSilenceInterrupted.status, "interrupted");
	    assert.strictEqual(directNoRtpSilenceInterrupted.interruptReason, "silence");
	    assert.ok(directNoRtpSilenceInterrupted.outputBinaryBase64);
	    const directNoRtpSilenceBuffer = Buffer.from(directNoRtpSilenceInterrupted.outputBinaryBase64, "base64");
	    assert.ok(directNoRtpSilenceBuffer.length > 44);
	    assert.strictEqual(directNoRtpSilenceInterrupted.outputBinaryProperty, "directNoRtpSilenceAudio");
	    const directReinviteRtpPeer = dgram.createSocket("udp4");
	    await new Promise((resolve) => directReinviteRtpPeer.bind(0, "127.0.0.1", resolve));
	    const directReinviteRtpPeerAddress = directReinviteRtpPeer.address();
	    const directReinviteSdp = [
	      "v=0",
	      `o=- ${Date.now()} ${Date.now()} IN IP4 127.0.0.1`,
	      "s=smoke-reinvite",
	      "c=IN IP4 127.0.0.1",
	      "t=0 0",
	      `m=audio ${directReinviteRtpPeerAddress.port} RTP/AVP 0 8 97`,
	      "a=rtpmap:0 PCMU/8000",
	      "a=rtpmap:8 PCMA/8000",
	      "a=rtpmap:97 telephone-event/8000",
	      "a=fmtp:97 0-16",
	      "a=ptime:20",
	      "a=sendrecv",
	    ].join("\r\n");
	    const directReinviteOkPromise = waitForUdpMessage(directPeer, (message) => {
	      return message.statusCode === 200
	        && sipHeader(message, "call-id") === sipHeader(directInvite.message, "call-id")
	        && sipHeader(message, "cseq") === "3 INVITE";
	    }, 1000, "direct-reinvite-ok");
	    await sendUdp(directPeer, buildInvite({
	      requestUri: `sip:direct-user@127.0.0.1:${directInvite.rinfo.port}`,
	      localHost: "127.0.0.1",
	      localPort: directPeerAddress.port,
	      branch: "z9hG4bK-direct-reinvite",
	      from: `${sipHeader(directInvite.message, "to")};tag=remote`,
	      to: sipHeader(directInvite.message, "from"),
	      callId: sipHeader(directInvite.message, "call-id"),
	      cseq: 3,
	      contactUser: "700",
	      body: directReinviteSdp,
	    }), directInvite.rinfo.port, directInvite.rinfo.address);
	    const directReinviteOk = await directReinviteOkPromise;
	    assert.strictEqual(directReinviteOk.message.statusCode, 200);
	    assert.deepStrictEqual(parseAudioPayloadTypesFromSdp(directReinviteOk.message.body), [0, 97]);
	    await sendUdp(directPeer, buildAck({
	      requestUri: `sip:direct-user@127.0.0.1:${directInvite.rinfo.port}`,
	      localHost: "127.0.0.1",
	      localPort: directPeerAddress.port,
	      branch: "z9hG4bK-direct-reinvite-ack",
	      from: `${sipHeader(directInvite.message, "to")};tag=remote`,
	      to: sipHeader(directReinviteOk.message, "to"),
	      callId: sipHeader(directInvite.message, "call-id"),
	      cseq: 3,
	    }), directInvite.rinfo.port, directInvite.rinfo.address);
	    const directReinviteLegDetails = daemon.legService.requireLeg(directAnswered.legId).signalingDetails;
	    assert.strictEqual(directReinviteLegDetails.audioPayloadType, 0);
	    assert.strictEqual(directReinviteLegDetails.remoteRtpPort, directReinviteRtpPeerAddress.port);
	    const directReinvitePlaybackPacketPromise = waitForUdpBuffer(
	      directReinviteRtpPeer,
	      (buffer) => buffer.length > 12 && (buffer[0] >> 6) === 2,
	      1000,
	      "direct-reinvite-playback",
	    );
	    const directReinvitePlayback = await runtime.playAudio(directAnswered.legId, {
	      mediaExecutionMode: "background",
	      sourceType: "binary",
	      binaryProperty: "audio",
	      binaryDataBase64: playbackBinaryBase64,
	    });
	    assert.strictEqual(directReinvitePlayback.status, "started");
	    const directReinvitePlaybackPacket = await directReinvitePlaybackPacketPromise;
	    assert.strictEqual(rtpPayloadType(directReinvitePlaybackPacket.buffer), 0);
	    await runtime.stopMedia({
	      stopMediaTarget: "mediaId",
	      stopMediaId: directReinvitePlayback.mediaId,
	      stopMediaReason: "direct_reinvite_playback_cleanup",
	    });
	    const bridgePeer = dgram.createSocket("udp4");
	    await new Promise((resolve) => bridgePeer.bind(0, "127.0.0.1", resolve));
	    const bridgePeerAddress = bridgePeer.address();
	    const bridgeRtpPeer = dgram.createSocket("udp4");
	    await new Promise((resolve) => bridgeRtpPeer.bind(0, "127.0.0.1", resolve));
	    const bridgeRtpPeerAddress = bridgeRtpPeer.address();
	    const bridgeDial = await runtime.makeDial({
	      callMode: "direct",
	      callStrategy: "parallel",
	      destination: ["702"],
	      sipCredentials: {
	        sipServer: "127.0.0.1",
	        port: bridgePeerAddress.port,
	        localBindIp: "127.0.0.1",
	        localBindPort: 0,
	        transport: "udp",
	        username: "bridge-user",
	        publicDomain: "127.0.0.1",
	      },
	    });
	    const bridgeInvite = await waitForUdpMessage(bridgePeer, (message) => message.method === "INVITE", 1000, "bridge-invite");
	    const bridgeLocalRtpPort = parseAudioPortFromSdp(bridgeInvite.message.body);
	    assert.ok(bridgeLocalRtpPort > 0);
	    const bridgeAnsweredPromise = runtime.waitForDialEvent(bridgeDial.dialId, {
	      dialTimeoutSeconds: 1,
	    });
	    const bridgeAckPromise = waitForUdpMessage(bridgePeer, (message) => message.method === "ACK", 1000, "bridge-ack");
	    await sleep(10);
	    await sendUdp(bridgePeer, buildResponseWithBody(bridgeInvite.message, 200, "OK", {
	      Contact: `<sip:702@127.0.0.1:${bridgePeerAddress.port}>`,
	      "Content-Type": "application/sdp",
	    }, buildAudioSdp("127.0.0.1", bridgeRtpPeerAddress.port)), bridgeInvite.rinfo.port, bridgeInvite.rinfo.address);
	    const bridgeAnswered = await bridgeAnsweredPromise;
	    assert.strictEqual(bridgeAnswered.eventType, "answered");
	    const bridgeAck = await bridgeAckPromise;
	    assert.strictEqual(bridgeAck.message.method, "ACK");
	    const bridgeResult = await runtime.bridge(directAnswered.legId, bridgeAnswered.legId, {
	      emitDtmfEvents: true,
	      relayDtmf: "auto",
	    });
	    assert.strictEqual(bridgeResult.legAId, directAnswered.legId);
	    assert.strictEqual(bridgeResult.legBId, bridgeAnswered.legId);
	    const bridgeForwardPromise = waitForUdpBuffer(bridgeRtpPeer, (buffer) => buffer.length > 12 && (buffer[0] >> 6) === 2, 1000, "bridge-forward");
	    const bridgedInboundRtp = buildRtpPacket(0, Buffer.alloc(160, 0x7f), 2, 320, 5678);
	    await new Promise((resolve, reject) => {
	      directRtpPeer.send(bridgedInboundRtp, directLocalRtpPort, "127.0.0.1", (error) => {
	        if (error) reject(error);
	        else resolve();
	      });
	    });
	    const bridgeForwardPacket = await bridgeForwardPromise;
	    assert.ok(bridgeForwardPacket.buffer.length > 12);
	    const bridgeRtpDtmfPromise = waitForUdpBuffer(
	      bridgeRtpPeer,
	      (buffer) => buffer.length > 12 && (buffer[1] & 0x7f) === 101,
	      1000,
	      "bridge-dtmf-forward",
	    );
	    const bridgedInboundDtmf = buildRtpDtmfPacket(97, "3", 3, 480, true, 160, 91011);
	    await new Promise((resolve, reject) => {
	      directRtpPeer.send(bridgedInboundDtmf, directLocalRtpPort, "127.0.0.1", (error) => {
	        if (error) reject(error);
	        else resolve();
	      });
	    });
	    const bridgeRtpDtmfPacket = await bridgeRtpDtmfPromise;
	    assert.ok(bridgeRtpDtmfPacket.buffer.length > 12);
	    const bridgeInboundRtpDtmfPromise = runtime.waitForLegEvent(bridgeAnswered.legId, {
	      timeoutSeconds: 1,
	      interdigitTimeoutSeconds: 0.001,
	      rules: [],
	      waitDtmfFallbackEnabled: true,
	      waitDtmfMultiDigitFallbackEnabled: false,
	    });
	    const bridgeInboundRtpDtmfEvent = await bridgeInboundRtpDtmfPromise;
	    assert.strictEqual(bridgeInboundRtpDtmfEvent.output, "dtmfFallback");
	    assert.strictEqual(bridgeInboundRtpDtmfEvent.digits, "3");
	    const bridgeDtmfPromise = runtime.waitForLegEvent(bridgeAnswered.legId, {
	      timeoutSeconds: 1,
	      interdigitTimeoutSeconds: 0.001,
	      rules: [],
	      waitDtmfFallbackEnabled: true,
	      waitDtmfMultiDigitFallbackEnabled: false,
	    });
	    await runtime.sendDtmf(directAnswered.legId, "9", {
	      dtmfMethod: "auto",
	    });
	    const bridgeDtmfEvent = await bridgeDtmfPromise;
	    assert.strictEqual(bridgeDtmfEvent.output, "dtmfFallback");
	    assert.strictEqual(bridgeDtmfEvent.digits, "9");
	    const directByePromise = waitForUdpMessage(directPeer, (message) => message.method === "BYE", 1000, "direct-bye");
	    const bridgeByePromise = waitForUdpMessage(bridgePeer, (message) => message.method === "BYE", 1000, "bridge-bye");
	    await runtime.hangup(directAnswered.legId);
	    await runtime.hangup(bridgeAnswered.legId);
	    const directBye = await directByePromise;
	    const bridgeBye = await bridgeByePromise;
	    assert.strictEqual(directBye.message.method, "BYE");
	    assert.strictEqual(bridgeBye.message.method, "BYE");
	    directPeer.close();
	    directRtpPeer.close();
	    bridgePeer.close();
	    bridgeRtpPeer.close();

	    const directAuthPeer = dgram.createSocket("udp4");
	    await new Promise((resolve) => directAuthPeer.bind(0, "127.0.0.1", resolve));
	    const directAuthPeerAddress = directAuthPeer.address();
	    const directAuthRtpPeer = dgram.createSocket("udp4");
	    await new Promise((resolve) => directAuthRtpPeer.bind(0, "127.0.0.1", resolve));
	    const directAuthRtpPeerAddress = directAuthRtpPeer.address();
	    const directAuthDial = await runtime.makeDial({
	      callMode: "direct",
	      callStrategy: "parallel",
	      destination: ["703"],
	      sipCredentials: {
	        sipServer: "127.0.0.1",
	        port: directAuthPeerAddress.port,
	        localBindIp: "127.0.0.1",
	        localBindPort: 0,
	        transport: "udp",
	        username: "direct-auth-user",
	        password: "direct-auth-secret",
	        publicDomain: "127.0.0.1",
	      },
	    });
	    const directAuthInviteInitial = await waitForUdpMessage(directAuthPeer, (message) => message.method === "INVITE", 1000, "direct-auth-invite-initial");
	    await sendUdp(directAuthPeer, buildResponse(directAuthInviteInitial.message, 401, "Unauthorized", {
	      "WWW-Authenticate": 'Digest realm="direct.test", nonce="direct-nonce-1", algorithm=MD5, qop="auth"',
	    }), directAuthInviteInitial.rinfo.port, directAuthInviteInitial.rinfo.address);
	    const directAuthAck = await waitForUdpMessage(directAuthPeer, (message) => {
	      return message.method === "ACK"
	        && sipHeader(message, "call-id") === sipHeader(directAuthInviteInitial.message, "call-id")
	        && sipHeader(message, "cseq") === "1 ACK";
	    }, 1000, "direct-auth-ack");
	    assert.strictEqual(directAuthAck.message.method, "ACK");
	    const directAuthInviteAuthorized = await waitForUdpMessage(directAuthPeer, (message) => {
	      return message.method === "INVITE"
	        && sipHeader(message, "call-id") === sipHeader(directAuthInviteInitial.message, "call-id")
	        && sipHeader(message, "cseq") === "2 INVITE";
	    }, 1000, "direct-auth-invite-authorized");
	    const directAuthorization = sipHeader(directAuthInviteAuthorized.message, "authorization");
	    assert.ok(directAuthorization.startsWith("Digest "));
	    assert.ok(/username="direct-auth-user"/.test(directAuthorization));
	    assert.ok(/realm="direct\.test"/.test(directAuthorization));
	    assert.ok(/nonce="direct-nonce-1"/.test(directAuthorization));
	    const directAuthCnonce = /cnonce="([^"]+)"/.exec(directAuthorization)?.[1] || "";
	    const directAuthNc = /nc=([0-9a-fA-F]+)/.exec(directAuthorization)?.[1] || "";
	    const directAuthResponse = /response="([^"]+)"/.exec(directAuthorization)?.[1] || "";
	    const directAuthHa1 = md5("direct-auth-user:direct.test:direct-auth-secret");
	    const directAuthHa2 = md5(`INVITE:${directAuthInviteAuthorized.message.requestUri}`);
	    assert.strictEqual(directAuthResponse, md5(`${directAuthHa1}:direct-nonce-1:${directAuthNc}:${directAuthCnonce}:auth:${directAuthHa2}`));
	    const directAuthAnsweredPromise = runtime.waitForDialEvent(directAuthDial.dialId, {
	      dialTimeoutSeconds: 1,
	    });
	    const directAuthAckAfterOkPromise = waitForUdpMessage(directAuthPeer, (message) => {
	      return message.method === "ACK"
	        && sipHeader(message, "call-id") === sipHeader(directAuthInviteInitial.message, "call-id")
	        && sipHeader(message, "cseq") === "2 ACK";
	    }, 1000, "direct-auth-ack-after-ok");
	    await sendUdp(directAuthPeer, buildResponseWithBody(directAuthInviteAuthorized.message, 200, "OK", {
	      Contact: `<sip:703@127.0.0.1:${directAuthPeerAddress.port}>`,
	      "Content-Type": "application/sdp",
	    }, buildAudioSdp("127.0.0.1", directAuthRtpPeerAddress.port)), directAuthInviteAuthorized.rinfo.port, directAuthInviteAuthorized.rinfo.address);
	    const directAuthAnswered = await directAuthAnsweredPromise;
	    assert.strictEqual(directAuthAnswered.eventType, "answered");
	    const directAuthAckAfterOk = await directAuthAckAfterOkPromise;
	    assert.strictEqual(directAuthAckAfterOk.message.method, "ACK");
	    const directAuthByePromise = waitForUdpMessage(directAuthPeer, (message) => message.method === "BYE", 1000, "direct-auth-bye");
	    await runtime.hangup(directAuthAnswered.legId);
	    const directAuthBye = await directAuthByePromise;
	    assert.strictEqual(directAuthBye.message.method, "BYE");
	    directAuthPeer.close();
	    directAuthRtpPeer.close();

	    const trunkProvider = dgram.createSocket("udp4");
	    await new Promise((resolve) => trunkProvider.bind(0, "127.0.0.1", resolve));
	    const trunkProviderAddress = trunkProvider.address();
	    const registeringTrunkStream = await runtime.openTrunkTrigger({
	      ref: "carrier-outbound",
	      registerOnStart: true,
	      registrationExpires: 2,
	      sipCredentials: {
	        sipServer: "127.0.0.1",
	        port: trunkProviderAddress.port,
	        localBindIp: "127.0.0.1",
	        localBindPort: 0,
	        transport: "udp",
	        username: "carrier-user",
	        password: "carrier-secret",
	        publicDomain: "127.0.0.1",
	      },
	    }, () => undefined);
	    const trunkRegisterInitial = await waitForUdpMessage(trunkProvider, (message) => message.method === "REGISTER", 1000, "trunk-register-initial");
	    const trunkRegisterRetransmit = await waitForUdpMessage(trunkProvider, (message) => {
	      return message.method === "REGISTER"
	        && buildRegisterTransactionKey(message) === buildRegisterTransactionKey(trunkRegisterInitial.message);
	    }, 1500, "trunk-register-retransmit");
	    assert.strictEqual(trunkRegisterRetransmit.message.method, "REGISTER");
	    const trunkChallengeNonce = "trunk-nonce-1";
	    await sendUdp(trunkProvider, buildResponse(trunkRegisterRetransmit.message, 401, "Unauthorized", {
	      "WWW-Authenticate": `Digest realm="carrier.test", nonce="${trunkChallengeNonce}", algorithm=MD5, qop="auth"`,
	    }), trunkRegisterRetransmit.rinfo.port, trunkRegisterRetransmit.rinfo.address);
	    const trunkRegisterAuthorized = await waitForUdpMessage(trunkProvider, (message) => {
	      return message.method === "REGISTER"
	        && sipHeader(message, "call-id") === sipHeader(trunkRegisterInitial.message, "call-id")
	        && sipHeader(message, "cseq") === "2 REGISTER";
	    }, 1000, "trunk-register-authorized");
	    const trunkAuthorization = sipHeader(trunkRegisterAuthorized.message, "authorization");
	    assert.ok(trunkAuthorization.startsWith("Digest "));
	    assert.ok(/username="carrier-user"/.test(trunkAuthorization));
	    assert.ok(/realm="carrier\.test"/.test(trunkAuthorization));
	    assert.ok(/nonce="trunk-nonce-1"/.test(trunkAuthorization));
	    const trunkAuthCnonce = /cnonce="([^"]+)"/.exec(trunkAuthorization)?.[1] || "";
	    const trunkAuthNc = /nc=([0-9a-fA-F]+)/.exec(trunkAuthorization)?.[1] || "";
	    const trunkAuthResponse = /response="([^"]+)"/.exec(trunkAuthorization)?.[1] || "";
	    const trunkHa1 = md5("carrier-user:carrier.test:carrier-secret");
	    const trunkHa2 = md5(`REGISTER:${trunkRegisterAuthorized.message.requestUri}`);
	    assert.strictEqual(trunkAuthResponse, md5(`${trunkHa1}:trunk-nonce-1:${trunkAuthNc}:${trunkAuthCnonce}:auth:${trunkHa2}`));
	    await sendUdp(trunkProvider, buildResponse(trunkRegisterAuthorized.message, 200, "OK", {
	      Contact: `<sip:carrier-user@127.0.0.1:${trunkRegisterAuthorized.rinfo.port}>;expires=2`,
	      Expires: "2",
	    }), trunkRegisterAuthorized.rinfo.port, trunkRegisterAuthorized.rinfo.address);
	    const trunkRegisterRefresh = await waitForUdpMessage(trunkProvider, (message) => {
	      return message.method === "REGISTER"
	        && sipHeader(message, "call-id") === sipHeader(trunkRegisterInitial.message, "call-id")
	        && sipHeader(message, "cseq") === "3 REGISTER";
	    }, 3000, "trunk-register-refresh");
	    const trunkRefreshAuthorization = sipHeader(trunkRegisterRefresh.message, "authorization");
	    assert.ok(trunkRefreshAuthorization.startsWith("Digest "));
	    assert.ok(/nonce="trunk-nonce-1"/.test(trunkRefreshAuthorization));
	    assert.ok(/nc=00000002/.test(trunkRefreshAuthorization));
	    await sendUdp(trunkProvider, buildResponse(trunkRegisterRefresh.message, 200, "OK", {
	      Contact: `<sip:carrier-user@127.0.0.1:${trunkRegisterRefresh.rinfo.port}>;expires=2`,
	      Expires: "2",
	    }), trunkRegisterRefresh.rinfo.port, trunkRegisterRefresh.rinfo.address);
	    const trunkDial = await runtime.makeDial({
	      callMode: "trunk",
	      callStrategy: "parallel",
	      ref: "carrier-outbound",
	      destination: ["701"],
	    });
	    const trunkOutboundInviteInitial = await waitForUdpMessage(trunkProvider, (message) => message.method === "INVITE", 1000, "trunk-outbound-invite-initial");
	    assert.strictEqual(trunkOutboundInviteInitial.message.requestUri, `sip:701@127.0.0.1:${trunkProviderAddress.port}`);
	    assert.strictEqual(trunkOutboundInviteInitial.rinfo.port, trunkRegisterAuthorized.rinfo.port);
	    const trunkOutboundAnsweredPromise = runtime.waitForDialEvent(trunkDial.dialId, {
	      dialTimeoutSeconds: 1,
	    });
	    await sendUdp(trunkProvider, buildResponse(trunkOutboundInviteInitial.message, 407, "Proxy Authentication Required", {
	      "Proxy-Authenticate": 'Digest realm="carrier.test", nonce="trunk-invite-nonce-1", algorithm=MD5, qop="auth"',
	    }), trunkOutboundInviteInitial.rinfo.port, trunkOutboundInviteInitial.rinfo.address);
	    const trunkInviteAck = await waitForUdpMessage(trunkProvider, (message) => {
	      return message.method === "ACK"
	        && sipHeader(message, "call-id") === sipHeader(trunkOutboundInviteInitial.message, "call-id")
	        && sipHeader(message, "cseq") === "1 ACK";
	    }, 1000, "trunk-outbound-ack-auth");
	    assert.strictEqual(trunkInviteAck.message.method, "ACK");
	    const trunkOutboundInviteAuthorized = await waitForUdpMessage(trunkProvider, (message) => {
	      return message.method === "INVITE"
	        && sipHeader(message, "call-id") === sipHeader(trunkOutboundInviteInitial.message, "call-id")
	        && sipHeader(message, "cseq") === "2 INVITE";
	    }, 1000, "trunk-outbound-invite-authorized");
	    const trunkInviteAuthorization = sipHeader(trunkOutboundInviteAuthorized.message, "proxy-authorization");
	    assert.ok(trunkInviteAuthorization.startsWith("Digest "));
	    assert.ok(/username="carrier-user"/.test(trunkInviteAuthorization));
	    assert.ok(/realm="carrier\.test"/.test(trunkInviteAuthorization));
	    assert.ok(/nonce="trunk-invite-nonce-1"/.test(trunkInviteAuthorization));
	    const trunkInviteCnonce = /cnonce="([^"]+)"/.exec(trunkInviteAuthorization)?.[1] || "";
	    const trunkInviteNc = /nc=([0-9a-fA-F]+)/.exec(trunkInviteAuthorization)?.[1] || "";
	    const trunkInviteResponse = /response="([^"]+)"/.exec(trunkInviteAuthorization)?.[1] || "";
	    const trunkInviteHa1 = md5("carrier-user:carrier.test:carrier-secret");
	    const trunkInviteHa2 = md5(`INVITE:${trunkOutboundInviteAuthorized.message.requestUri}`);
	    assert.strictEqual(trunkInviteResponse, md5(`${trunkInviteHa1}:trunk-invite-nonce-1:${trunkInviteNc}:${trunkInviteCnonce}:auth:${trunkInviteHa2}`));
	    const trunkOutboundAckPromise = waitForUdpMessage(trunkProvider, (message) => {
	      return message.method === "ACK"
	        && sipHeader(message, "call-id") === sipHeader(trunkOutboundInviteInitial.message, "call-id")
	        && sipHeader(message, "cseq") === "2 ACK";
	    }, 1000, "trunk-outbound-ack");
	    await sleep(10);
	    await sendUdp(trunkProvider, buildResponse(trunkOutboundInviteAuthorized.message, 200, "OK", {
	      Contact: `<sip:701@127.0.0.1:${trunkProviderAddress.port}>`,
	    }), trunkOutboundInviteAuthorized.rinfo.port, trunkOutboundInviteAuthorized.rinfo.address);
	    const trunkOutboundAnswered = await trunkOutboundAnsweredPromise;
	    assert.strictEqual(trunkOutboundAnswered.eventType, "answered");
	    const trunkOutboundAck = await trunkOutboundAckPromise;
	    assert.strictEqual(trunkOutboundAck.message.method, "ACK");
	    const trunkOutboundByePromise = waitForUdpMessage(trunkProvider, (message) => {
	      return message.method === "BYE"
	        && sipHeader(message, "call-id") === sipHeader(trunkOutboundInviteInitial.message, "call-id");
	    }, 1000, "trunk-outbound-bye");
	    await runtime.hangup(trunkOutboundAnswered.legId);
	    const trunkOutboundBye = await trunkOutboundByePromise;
	    assert.strictEqual(trunkOutboundBye.message.method, "BYE");
	    assert.ok(/;tag=/.test(sipHeader(trunkOutboundBye.message, "to")));
	    await sendUdp(trunkProvider, buildResponse(trunkOutboundBye.message, 200, "OK"), trunkOutboundBye.rinfo.port, trunkOutboundBye.rinfo.address);
	    const trunkDeregisterPromise = waitForUdpMessage(trunkProvider, (message) => {
	      return message.method === "REGISTER"
	        && sipHeader(message, "call-id") === sipHeader(trunkRegisterInitial.message, "call-id")
	        && sipHeader(message, "cseq") === "4 REGISTER"
	        && sipHeader(message, "expires") === "0"
	        && /expires=0/.test(sipHeader(message, "contact"));
	    }, 1000, "trunk-register-deregister");
	    await registeringTrunkStream.close();
	    const trunkDeregister = await trunkDeregisterPromise;
	    assert.strictEqual(trunkDeregister.message.method, "REGISTER");
	    assert.strictEqual(sipHeader(trunkDeregister.message, "expires"), "0");
	    trunkProvider.close();

    const providerSocket = dgram.createSocket("udp4");
    await new Promise((resolve) => providerSocket.bind(0, "127.0.0.1", resolve));
    const providerAddress = providerSocket.address();
	    const realTrunkEvents = [];
	    const realTrunkStream = await runtime.openTrunkTrigger({
      ref: "carrier-sip",
      registerOnStart: true,
      registrationExpires: 60,
      sipCredentials: {
        sipServer: "127.0.0.1",
        port: providerAddress.port,
        localBindIp: "127.0.0.1",
        localBindPort: 0,
        transport: "udp",
        username: "carrier-sip",
        password: "carrier-secret",
        publicDomain: "127.0.0.1",
      },
    }, (event) => realTrunkEvents.push(event));
    const trunkInboundRegister = await waitForUdpMessage(providerSocket, (message) => message.method === "REGISTER", 1000, "trunk-inbound-register");
    const trunkRouteUri = sipContactUri(trunkInboundRegister.message);
    assert.ok(/n8n-route=/.test(trunkRouteUri));
    await sendUdp(providerSocket, buildResponse(trunkInboundRegister.message, 200, "OK", {
      Contact: `<${trunkRouteUri}>;expires=60`,
      Expires: "60",
    }), trunkInboundRegister.rinfo.port, trunkInboundRegister.rinfo.address);
    const trunkEndpoint = daemon.sipTransportService.getTrunkEndpoint("carrier-sip");
    assert.ok(trunkEndpoint);
    await sendUdp(providerSocket, buildOptions({
      requestUri: "sip:carrier.test",
      localHost: "127.0.0.1",
      localPort: providerAddress.port,
      branch: "z9hG4bK-trunk-options-1",
      from: "<sip:probe@carrier.test>;tag=probe",
      to: "<sip:carrier@carrier.test>",
      callId: "trunk-options-1",
      cseq: 1,
    }), trunkEndpoint.port, trunkEndpoint.host);
    const trunkOptionsNotImplemented = await waitForUdpMessage(providerSocket, (message) => message.statusCode === 501 && sipHeader(message, "cseq") === "1 OPTIONS", 1000, "trunk-options-not-implemented");
    assert.strictEqual(trunkOptionsNotImplemented.message.statusCode, 501);
    assert.ok(/INVITE/.test(sipHeader(trunkOptionsNotImplemented.message, "allow")));
    const trunkEventCountBeforeCancel = realTrunkEvents.filter((event) => event.branch === "Call").length;
    const trunkCancelInviteText = buildInvite({
      requestUri: trunkRouteUri,
      localHost: "127.0.0.1",
      localPort: providerAddress.port,
      branch: "z9hG4bK-trunk-cancel-invite-1",
      from: `"Provider Caller" <sip:caller@carrier.test>;tag=provider-cancel`,
      to: "<sip:ivr@carrier.test>",
      callId: "trunk-call-cancel-1",
      cseq: 1,
      contactUser: "provider",
    });
    await sendUdp(providerSocket, trunkCancelInviteText, trunkEndpoint.port, trunkEndpoint.host);
    const trunkCancelTrying = await waitForUdpMessage(providerSocket, (message) => message.statusCode === 100 && sipHeader(message, "call-id") === "trunk-call-cancel-1", 1000, "trunk-cancel-trying");
    assert.strictEqual(trunkCancelTrying.message.statusCode, 100);
    await waitForCondition(() => realTrunkEvents.filter((event) => event.branch === "Call").length === trunkEventCountBeforeCancel + 1, 1000, "trunk-cancel-event");
    const trunkCancelEvent = realTrunkEvents.filter((event) => event.branch === "Call")[trunkEventCountBeforeCancel];
    assert.ok(trunkCancelEvent);
    const trunkCancelPlayback = await runtime.playAudio(trunkCancelEvent.payload.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: playbackBinaryBase64,
    });
    assert.strictEqual(trunkCancelPlayback.status, "started");
    const trunkCancelPlaybackWaitPromise = runtime.waitMedia({
      waitMediaIds: [trunkCancelPlayback.mediaId],
      waitMediaTimeoutSeconds: 1,
    });
    await sendUdp(providerSocket, buildCancel({
      requestUri: trunkRouteUri,
      localHost: "127.0.0.1",
      localPort: providerAddress.port,
      branch: "z9hG4bK-trunk-cancel-invite-1",
      from: `"Provider Caller" <sip:caller@carrier.test>;tag=provider-cancel`,
      to: "<sip:ivr@carrier.test>",
      callId: "trunk-call-cancel-1",
      cseq: 1,
    }), trunkEndpoint.port, trunkEndpoint.host);
    const trunkCancelOk = await waitForUdpMessage(providerSocket, (message) => {
      return message.statusCode === 200
        && sipHeader(message, "call-id") === "trunk-call-cancel-1"
        && sipHeader(message, "cseq") === "1 CANCEL";
    }, 1000, "trunk-cancel-ok");
    assert.strictEqual(trunkCancelOk.message.statusCode, 200);
    const trunkInviteCancelled = await waitForUdpMessage(providerSocket, (message) => {
      return message.statusCode === 487
        && sipHeader(message, "call-id") === "trunk-call-cancel-1"
        && sipHeader(message, "cseq") === "1 INVITE";
    }, 1000, "trunk-cancel-487");
	    assert.strictEqual(trunkInviteCancelled.message.statusCode, 487);
	    await waitForCondition(() => !daemon.legService.getLeg(trunkCancelEvent.payload.legId), 1000, "trunk-cancel-leg-cleanup");
	    const trunkCancelPlaybackWait = await trunkCancelPlaybackWaitPromise;
    assert.strictEqual(trunkCancelPlaybackWait.status, "interrupted");
    assert.strictEqual(trunkCancelPlaybackWait.interruptReason, "leg_ended");
    const trunkEventCountBeforeInvite = realTrunkEvents.filter((event) => event.branch === "Call").length;
    const providerRtpSocket = dgram.createSocket("udp4");
    await new Promise((resolve) => providerRtpSocket.bind(0, "127.0.0.1", resolve));
    const providerRtpAddress = providerRtpSocket.address();
    const trunkInviteText = buildInvite({
      requestUri: trunkRouteUri,
      localHost: "127.0.0.1",
      localPort: providerAddress.port,
      branch: "z9hG4bK-trunk-1",
      from: `"Provider Caller" <sip:caller@carrier.test>;tag=provider`,
      to: "<sip:ivr@carrier.test>",
      callId: "trunk-call-1",
      cseq: 1,
      contactUser: "provider",
      body: buildAudioSdp("127.0.0.1", providerRtpAddress.port),
    });
    await sendUdp(providerSocket, trunkInviteText, trunkEndpoint.port, trunkEndpoint.host);
    const trunkTrying = await waitForUdpMessage(providerSocket, (message) => message.statusCode === 100, 1000, "trunk-trying");
    assert.strictEqual(trunkTrying.message.statusCode, 100);
    await waitForCondition(() => realTrunkEvents.filter((event) => event.branch === "Call").length === trunkEventCountBeforeInvite + 1, 1000, "trunk-invite-event");
    const realTrunkEvent = realTrunkEvents.filter((event) => event.branch === "Call")[trunkEventCountBeforeInvite];
    assert.ok(realTrunkEvent);
    assert.strictEqual(realTrunkEvent.payload.callerName, "Provider Caller");
	    const trunkRingingPromise = waitForUdpMessage(providerSocket, (message) => message.statusCode === 180, 1000, "trunk-ringing");
	    await runtime.ringing(realTrunkEvent.payload.legId);
	    const trunkRinging = await trunkRingingPromise;
	    assert.strictEqual(trunkRinging.message.statusCode, 180);
	    await sendUdp(providerSocket, trunkInviteText, trunkEndpoint.port, trunkEndpoint.host);
	    const trunkRingingRetransmit = await waitForUdpMessage(providerSocket, (message) => {
	      return message.statusCode === 180 && sipHeader(message, "call-id") === "trunk-call-1";
	    }, 1000, "trunk-ringing-retransmit");
	    assert.strictEqual(trunkRingingRetransmit.message.statusCode, 180);
	    assert.strictEqual(realTrunkEvents.filter((event) => event.branch === "Call").length, trunkEventCountBeforeInvite + 1);
	    const trunkOkPromise = waitForUdpMessage(providerSocket, (message) => message.statusCode === 200, 1000, "trunk-answer-ok");
	    await runtime.answer(realTrunkEvent.payload.legId);
	    const trunkOk = await trunkOkPromise;
    assert.strictEqual(trunkOk.message.statusCode, 200);
	    assert.ok(parseAudioPortFromSdp(trunkOk.message.body) > 0);
	    const trunkOkRetransmit = await waitForUdpMessage(providerSocket, (message) => {
	      return message.statusCode === 200 && sipHeader(message, "call-id") === "trunk-call-1";
	    }, 1200, "trunk-answer-ok-retransmit");
	    assert.strictEqual(trunkOkRetransmit.message.statusCode, 200);
	    const trunkAckRequestUri = (/<([^>]+)>/.exec(sipHeader(trunkOk.message, "contact")) || [])[1] || `sip:n8n@127.0.0.1:${trunkEndpoint.port}`;
	    const trunkAckText = [
	      `ACK ${trunkAckRequestUri} SIP/2.0`,
	      `Via: SIP/2.0/UDP 127.0.0.1:${providerAddress.port};branch=z9hG4bK-trunk-ack-1`,
	      "Max-Forwards: 70",
	      "From: \"Provider Caller\" <sip:caller@carrier.test>;tag=provider",
	      `To: ${sipHeader(trunkOk.message, "to")}`,
	      "Call-ID: trunk-call-1",
	      "CSeq: 1 ACK",
	      "Content-Length: 0",
	      "",
	      "",
	    ].join("\r\n");
	    await sendUdp(providerSocket, trunkAckText, trunkEndpoint.port, trunkEndpoint.host);
	    const trunkPlaybackRtpPromise = waitForUdpBuffer(providerRtpSocket, (buffer) => buffer.length > 12 && (buffer[0] >> 6) === 2, 1000, "trunk-rtp-playback");
	    const trunkPlayback = await runtime.playAudio(realTrunkEvent.payload.legId, {
	      mediaExecutionMode: "background",
	      sourceType: "binary",
	      binaryProperty: "audio",
	      binaryDataBase64: playbackBinaryBase64,
	    });
	    assert.strictEqual(trunkPlayback.status, "started");
	    const trunkPlaybackPacket = await trunkPlaybackRtpPromise;
	    assert.ok(trunkPlaybackPacket.buffer.length > 12);
	    await runtime.stopMedia({
	      stopMediaTarget: "mediaId",
	      stopMediaId: trunkPlayback.mediaId,
	      stopMediaReason: "trunk_playback_cleanup",
	    });
	    const byeText = [
	      `BYE sip:n8n@127.0.0.1:${trunkEndpoint.port} SIP/2.0`,
      `Via: SIP/2.0/UDP 127.0.0.1:${providerAddress.port};branch=z9hG4bK-trunk-bye`,
      "Max-Forwards: 70",
      "From: \"Provider Caller\" <sip:caller@carrier.test>;tag=provider",
      `${sipHeader(trunkOk.message, "to") ? `To: ${sipHeader(trunkOk.message, "to")}` : "To: <sip:ivr@carrier.test>;tag=remote"}`,
      "Call-ID: trunk-call-1",
      "CSeq: 2 BYE",
      "Content-Length: 0",
	      "",
	      "",
	    ].join("\r\n");
	    const trunkEndedPromise = runtime.waitForLegEvent(realTrunkEvent.payload.legId, {
	      timeoutSeconds: 1,
	      rules: [],
	      waitDtmfFallbackEnabled: false,
	    });
	    await sleep(10);
	    await sendUdp(providerSocket, byeText, trunkEndpoint.port, trunkEndpoint.host);
	    const byeOk = await waitForUdpMessage(providerSocket, (message) => message.statusCode === 200 && sipHeader(message, "cseq") === "2 BYE", 1000, "trunk-bye-ok");
	    assert.strictEqual(byeOk.message.statusCode, 200);
	    const trunkEnded = await trunkEndedPromise;
	    assert.strictEqual(trunkEnded.output, "ended");
	    providerRtpSocket.close();

    const graceEventsA = [];
    const graceEventsB = [];
    const graceStreamA = await runtime.openExtensionsTrigger({
      ref: "office-ext-grace",
      extensionsLocalBindPort: 0,
      authMode: "raw",
      authTimeoutSeconds: 0.025,
    }, (event) => graceEventsA.push(event));
    daemon.extensionService.registerEndpoint({
      ref: "office-ext-grace",
      extensionNumber: "401",
      contactUri: "sip:401@office.local",
    });
    await graceStreamA.close();
    const graceStreamB = await runtime.openExtensionsTrigger({
      ref: "office-ext-grace",
      extensionsLocalBindPort: 0,
      authMode: "raw",
      authTimeoutSeconds: 0.025,
    }, (event) => graceEventsB.push(event));
    await sleep(20);
    assert.deepStrictEqual(daemon.extensionService.listOnlineExtensionNumbers("office-ext-grace"), ["401"]);
    await graceStreamB.close();
    await sleep(5200);
    assert.deepStrictEqual(daemon.extensionService.listOnlineExtensionNumbers("office-ext-grace"), []);

    const websocketClients = new Set();
    const websocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    websocketServer.on("connection", (socket) => {
      websocketClients.add(socket);
      socket.on("close", () => websocketClients.delete(socket));
    });
    await new Promise((resolve) => websocketServer.once("listening", resolve));
    const websocketAddress = websocketServer.address();
    const websocketUrl = `ws://127.0.0.1:${websocketAddress.port}`;
    const websocketDial = await runtime.makeDial({
      callMode: "websocket",
      transportProfile: "generic",
      websocketUrl,
      websocketInitialMessagesJson: [{ type: "hello" }],
    });
    const websocketAnswered = await runtime.waitForDialEvent(websocketDial.dialId, {
      dialTimeoutSeconds: 1,
    });
    assert.strictEqual(websocketAnswered.eventType, "answered");
    assert.ok(websocketAnswered.legId);
    const websocketClient = Array.from(websocketClients)[0];
    assert.ok(websocketClient);
    const websocketPlaybackPromise = waitForWebSocketMessage(
      websocketClient,
      (payload) => payload && payload.type === "input_audio" && typeof payload.audio === "string" && payload.audio.length > 0,
      1000,
      "websocket-playback",
    );
    const websocketPlayback = await runtime.playAudio(websocketAnswered.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: playbackBinaryBase64,
    });
    assert.strictEqual(websocketPlayback.status, "started");
    const websocketPlaybackFrame = await websocketPlaybackPromise;
    assert.strictEqual(websocketPlaybackFrame.type, "input_audio");
    assert.ok(websocketPlaybackFrame.audio.length > 0);
    await runtime.stopMedia({
      stopMediaTarget: "mediaId",
      stopMediaId: websocketPlayback.mediaId,
      stopMediaReason: "websocket_cleanup",
    });
    const websocketLowPlaybackAudio = createWavConstantBase64(2000);
    const websocketHighPlaybackAudio = createWavConstantBase64(4000);
    const websocketMixedFramePromise = waitForWebSocketMessage(
      websocketClient,
      (payload) => payload && payload.type === "input_audio" && readPcmPeakFromBase64(payload.audio) > 4500,
      1000,
      "websocket-mixed-playback",
    );
    const websocketLowPlayback = await runtime.playAudio(websocketAnswered.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: websocketLowPlaybackAudio,
      duckingFactor: 1,
    });
    const websocketHighPlayback = await runtime.playAudio(websocketAnswered.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryProperty: "audio",
      binaryDataBase64: websocketHighPlaybackAudio,
      duckingFactor: 0.5,
    });
    const websocketMixedFrame = await websocketMixedFramePromise;
    const websocketMixedPeak = readPcmPeakFromBase64(websocketMixedFrame.audio);
    assert.ok(websocketMixedPeak > 4500);
    await runtime.stopMedia({
      stopMediaTarget: "mediaId",
      stopMediaId: websocketLowPlayback.mediaId,
      stopMediaReason: "websocket_mix_cleanup",
    });
    await runtime.stopMedia({
      stopMediaTarget: "mediaId",
      stopMediaId: websocketHighPlayback.mediaId,
      stopMediaReason: "websocket_mix_cleanup",
    });

    const websocketRecording = await runtime.recordAudio(websocketAnswered.legId, {
      mediaExecutionMode: "background",
      recordOutputType: "binary",
      recordFileFormat: "wav",
      recordBinaryProperty: "websocketAudio",
    });
    assert.strictEqual(websocketRecording.status, "started");
    websocketClient.send(JSON.stringify({
      type: "audio_output",
      audio: Buffer.alloc(320, 1).toString("base64"),
    }));
    await sleep(30);
    const websocketRecordingStop = await runtime.stopMedia({
      stopMediaTarget: "mediaId",
      stopMediaId: websocketRecording.mediaId,
      stopMediaReason: "websocket_recording_complete",
    });
    assert.strictEqual(websocketRecordingStop.status, "interrupted");
    assert.ok(websocketRecordingStop.outputBinaryBase64);
    assert.strictEqual(websocketRecordingStop.outputBinaryProperty, "websocketAudio");
    for (const client of Array.from(websocketClients)) {
      client.close();
    }
    await closeWebSocketServer(websocketServer);
    const websocketEnded = await runtime.waitForLegEvent(websocketAnswered.legId, {
      timeoutSeconds: 1,
      rules: [],
      waitDtmfFallbackEnabled: false,
    });
    assert.strictEqual(websocketEnded.output, "ended");

    await Promise.all([
      closeQuietly(queueStream),
      closeQuietly(callbackStream),
      closeQuietly(noOperatorStream),
      closeQuietly(disappearingOperatorStream),
      closeQuietly(trunkStream),
      closeQuietly(realTrunkStream),
      closeQuietly(extensionsStreamA),
      closeQuietly(extensionsStreamB),
      closeQuietly(staticExtensionsStream),
      closeQuietly(rawAuthStream),
      closeQuietly(digestAuthStream),
    ]);
    extensionClient.close();
    rawClient.close();
    digestClient.close();
    providerSocket.close();

    console.log(JSON.stringify({
      ok: true,
      runtime: {
        playbackStatus: playback.status,
        waitedPlaybackStatus: waitedPlayback.status,
        toneStatus: tone.status,
        mixPlaybackCount: mixDetails.playbackCount,
        voiceInterruptStatus: voiceInterruptedMedia.status,
        dtmfSent: dtmf.sent,
        dtmfInterruptStatus: dtmfInterruptedMedia.status,
        dtmfLegOutput: dtmfLegEvent.output,
        queueDispatchEvents: queueEvents.filter((event) => event.branch === "Dispatch").length,
        queueCallbackEvents: callbackEvents.filter((event) => event.branch === "Callback").length,
        offlineEvents: noOperatorEvents.filter((event) => event.branch === "Offline").length,
        disappearingOperatorOfflineEvents: disappearingOperatorEvents.filter((event) => event.branch === "Offline").length,
        trunkInviteEvents: trunkEvents.filter((event) => event.branch === "Call").length,
        realTrunkInviteEvents: realTrunkEvents.filter((event) => event.branch === "Call").length,
        extensionsAuthEvents: extensionsEventsB.filter((event) => event.branch === "Auth").length,
	        extensionsSessionEvents: extensionsEventsB.filter((event) => event.branch === "Call").length,
	        extensionGraceTakeoverOk: true,
	        websocketAnsweredEvents: websocketAnswered.eventType === "answered" ? 1 : 0,
	        websocketPlaybackSent: websocketPlayback.status === "started" ? 1 : 0,
	        websocketMixedPeak,
	        websocketRecordingBytes: Buffer.from(String(websocketRecordingStop.outputBinaryBase64 || ""), "base64").length,
	        sipRegisterOk: registerOk.message.statusCode === 200 ? 1 : 0,
	        sipRawAuthOk: rawRegisterOk.message.statusCode === 200 ? 1 : 0,
	        sipDigestAuthOk: digestRegisterOk.message.statusCode === 200 ? 1 : 0,
	        sipExtensionAnsweredEvents: extensionDialAnswered.eventType === "answered" ? 1 : 0,
	        sipDirectAnsweredEvents: directAnswered.eventType === "answered" ? 1 : 0,
	        sipDirectInviteRetransmits: 1,
	        sipDirectDtmfPackets: directDtmfPacket.buffer.length > 12 ? 1 : 0,
	        sipDirectInfoRequests: directInfoRequest.message.method === "INFO" ? 1 : 0,
	        sipDirectInbandPackets: directInbandPacket.buffer.length > 12 ? 1 : 0,
	        sipDirectInboundInfoEvents: inboundInfoEvent.output === "dtmfFallback" ? 1 : 0,
	        sipDirectRtpPlaybackPackets: directPlaybackPacket.buffer.length > 12 ? 1 : 0,
	        sipDirectRecordingBytes: Buffer.from(String(directRecordingStop.outputBinaryBase64 || ""), "base64").length,
	        sipBridgeForwardPackets: bridgeForwardPacket.buffer.length > 12 ? 1 : 0,
	        sipBridgeRtpDtmfPackets: bridgeRtpDtmfPacket.buffer.length > 12 ? 1 : 0,
	        sipBridgeInboundRtpDtmfEvents: bridgeInboundRtpDtmfEvent.output === "dtmfFallback" ? 1 : 0,
	        sipBridgeDtmfRelayEvents: bridgeDtmfEvent.output === "dtmfFallback" ? 1 : 0,
	        sipTrunkRegisterEvents: trunkRegisterAuthorized.message.method === "REGISTER" ? 1 : 0,
	        sipTrunkRegisterRetransmits: 1,
	        sipTrunkAnsweredEvents: trunkOutboundAnswered.eventType === "answered" ? 1 : 0,
	        sipInboundInviteRetransmits: 1,
	      },
	    }, null, 2));
  } finally {
    await daemon.stop();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
