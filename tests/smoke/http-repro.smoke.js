#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.env.SIP_PBX_SMOKE_FORCE_SINGLE_WORKER === "1") {
  try {
    Object.defineProperty(os, "availableParallelism", {
      configurable: true,
      value: () => 1,
    });
  } catch {}
}

if (process.platform !== "linux") {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "http media repro smoke requires the Linux native backend",
  }, null, 2));
  process.exit(0);
}

function forceExit(code) {
  const handles = (process._getActiveHandles?.() || []).map((handle) => handle?.constructor?.name || typeof handle);
  const requests = (process._getActiveRequests?.() || []).map((request) => request?.constructor?.name || typeof request);
  console.error(`[http-repro-smoke] forceExit code=${code}; handles=${JSON.stringify(handles)}; requests=${JSON.stringify(requests)}`);
  try {
    process.exit(Number(code) || 0);
  } catch {}
}

process.once("SIGTERM", () => {
  process.exit(0);
});

function createSocketPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sip-pbx-http-repro-"));
  return path.join(tempDir, "daemon.sock");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitForCondition(predicate, timeoutMs = 1000, label = "condition") {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Wait timeout: ${label}`);
}

async function waitForMinimumElapsed(startedAt, minimumMs) {
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < minimumMs) {
    await sleep(minimumMs - elapsedMs);
  }
}

async function safeHangup(runtime, legId, label) {
  try {
    await runtime.hangup(legId);
    return { ok: true };
  } catch (error) {
    if (String(error?.message || error || "").includes("Unknown leg")) {
      console.error(`[http-repro-smoke] ${label} already finalized`);
      return { ok: false, unknownLeg: true };
    }
    throw error;
  }
}

async function waitForPlaybackTerminal(playbackPromise, label) {
  const result = await playbackPromise;
  assert.ok(result && (result.status === "interrupted" || result.status === "failed"), `${label} ended with unexpected status ${result?.status}`);
  return result;
}

function md5(value) {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(value).digest("hex");
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
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`UDP wait timeout: ${label}`));
    }, timeoutMs);
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

function parseAudioPortFromSdp(body) {
  const match = String(body || "").match(/^m=audio\s+(\d+)/m);
  return match ? Number(match[1]) : 0;
}

function createAudioProfile(codecName = "opus") {
  const normalizedCodecName = String(codecName || "").trim().toLowerCase();
  if (normalizedCodecName === "pcma") {
    return {
      codecName: "g711",
      audioCodecToken: "PCMA",
      audioPayloadType: 8,
      audioClockRate: 8000,
      audioChannels: 1,
      audioFmtp: null,
      dtmfPayloadType: 101,
      dtmfClockRate: 8000,
    };
  }
  if (normalizedCodecName === "pcmu") {
    return {
      codecName: "g711",
      audioCodecToken: "PCMU",
      audioPayloadType: 0,
      audioClockRate: 8000,
      audioChannels: 1,
      audioFmtp: null,
      dtmfPayloadType: 101,
      dtmfClockRate: 8000,
    };
  }
  return {
    codecName: "opus",
    audioCodecToken: "OPUS",
    audioPayloadType: 96,
    audioClockRate: 48000,
    audioChannels: 2,
    audioFmtp: "stereo=1;sprop-stereo=1;useinbandfec=1",
    dtmfPayloadType: 101,
    dtmfClockRate: 48000,
  };
}

function buildAudioSdp(host, port, options = {}) {
  const profile = createAudioProfile(options.audioCodecName || (Number(options.audioPayloadType) === 8 ? "pcma" : (Number(options.audioPayloadType) === 96 ? "opus" : "pcmu")));
  const audioPayloadType = Number(options.audioPayloadType ?? profile.audioPayloadType);
  const audioCodec = String(options.audioCodec || profile.audioCodecToken).toUpperCase();
  const audioClockRate = Number(options.audioClockRate ?? profile.audioClockRate);
  const audioChannels = Number(options.audioChannels ?? profile.audioChannels);
  const audioFmtp = options.audioFmtp == null ? profile.audioFmtp : String(options.audioFmtp || "").trim() || null;
  const dtmfPayloadType = options.includeDtmf === false ? null : Number(options.dtmfPayloadType ?? 101);
  const dtmfClockRate = Number(options.dtmfClockRate ?? profile.dtmfClockRate);
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
    `a=rtpmap:${audioPayloadType} ${audioCodec}/${audioClockRate}${audioChannels > 1 ? `/${audioChannels}` : ""}`,
  ];
  if (audioFmtp) {
    lines.push(`a=fmtp:${audioPayloadType} ${audioFmtp}`);
  }
  if (dtmfPayloadType != null) {
    lines.push(`a=rtpmap:${dtmfPayloadType} telephone-event/${dtmfClockRate}`);
    lines.push(`a=fmtp:${dtmfPayloadType} 0-16`);
  }
  lines.push("a=ptime:20");
  lines.push("a=sendrecv");
  return lines.join("\r\n");
}

function buildAudioPayloadCodecs(profile) {
  const audioCodec = profile.audioCodecToken === "OPUS"
    ? "opus"
    : (profile.audioPayloadType === 8 ? "pcma" : "pcmu");
  return {
    [profile.audioPayloadType]: {
      codec: audioCodec,
      clockRate: profile.audioClockRate,
      channels: profile.audioChannels,
      fmtp: profile.audioFmtp || undefined,
    },
    [profile.dtmfPayloadType]: {
      codec: "telephone-event",
      clockRate: profile.dtmfClockRate,
      channels: 1,
      fmtp: "0-16",
    },
  };
}

function createRtpMonitor(legId, profile) {
  const { createCodec } = require("../../dist/daemon/media/codecs/audio-codec.js");
  const { RtpTransport } = require("../../dist/daemon/media/transports/rtp-transport.js");
  const transport = new RtpTransport({ codec: createCodec(profile.codecName) });
  const audioEvents = [];
  const unsubscribe = transport.subscribe((event) => {
    if (event && event.type === "audio") {
      audioEvents.push({
        ...event,
        receivedAt: Date.now(),
      });
    }
  });

  return transport.configure({
    localRtpBindIp: "127.0.0.1",
    localRtpHost: "127.0.0.1",
    localRtpPort: 0,
    audioPayloadType: profile.audioPayloadType,
    dtmfPayloadType: profile.dtmfPayloadType,
    payloadTypes: [profile.audioPayloadType, profile.dtmfPayloadType],
    payloadCodecs: buildAudioPayloadCodecs(profile),
  }).then((details) => {
    const waitForAudioAfter = async (markerAt, timeoutMs = 10000, label = "audio") => {
      await waitForCondition(() => {
        return audioEvents.some((event) => event.receivedAt >= markerAt);
      }, timeoutMs, label);
      return audioEvents.find((event) => event.receivedAt >= markerAt) || null;
    };

    return {
      legId,
      transport,
      details,
      audioEvents,
      waitForAudioAfter,
      close() {
        unsubscribe();
        transport.close();
      },
    };
  });
}

async function registerStaticExtension(extensionClient, extensionEndpoint, username = "401", password = "secret401", realm = "office.test") {
  const registerBase = {
    requestUri: `sip:${realm}`,
    localHost: "127.0.0.1",
    localPort: extensionClient.address().port,
    username,
    realm,
    tag: "reg-tag",
    callId: `http-repro-reg-${username}`,
    cseq: 1,
    expires: 600,
    branch: `z9hG4bK-reg-${username}-1`,
  };
  await sendUdp(extensionClient, buildRegister(registerBase), extensionEndpoint.port, extensionEndpoint.host);
  const challenge = await waitForUdpMessage(extensionClient, (message) => message.statusCode === 401 && sipHeader(message, "cseq") === "1 REGISTER", 1000, "extensions-register-challenge");
  const nonce = /nonce="([^"]+)"/.exec(sipHeader(challenge.message, "www-authenticate"))?.[1] || "";
  assert.ok(nonce, "Missing REGISTER digest nonce");
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`REGISTER:${registerBase.requestUri}`);
  const response = md5(`${ha1}:${nonce}:00000001:clientcnonce:auth:${ha2}`);
  const authorization = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${registerBase.requestUri}", response="${response}", algorithm=MD5, qop=auth, nc=00000001, cnonce="clientcnonce"`;
  const okPromise = waitForUdpMessage(extensionClient, (message) => message.statusCode === 200 && sipHeader(message, "cseq") === "2 REGISTER", 1000, "extensions-register-ok");
  await sendUdp(extensionClient, buildRegister({
    ...registerBase,
    cseq: 2,
    branch: `z9hG4bK-reg-${username}-2`,
    authorization,
  }), extensionEndpoint.port, extensionEndpoint.host);
  const ok = await okPromise;
  assert.strictEqual(ok.message.statusCode, 200);
}

async function createAnsweredInboundExtensionCall(input) {
  const {
    daemon,
    runtime,
    extensionEndpoint,
    triggerEvents,
    callId,
    callerName,
    fromUser,
    toUser,
    audioCodecName = "opus",
  } = input;
  const profile = createAudioProfile(audioCodecName);
  const callerSip = require("dgram").createSocket("udp4");
  await new Promise((resolve) => callerSip.bind(0, "127.0.0.1", resolve));
  const callerAddress = callerSip.address();
  const rtpMonitor = await createRtpMonitor(callId, profile);
  const offerSdp = buildAudioSdp("127.0.0.1", rtpMonitor.details.localRtpPort, {
    audioCodecName,
    audioPayloadType: profile.audioPayloadType,
    audioCodec: profile.audioCodecToken,
    audioClockRate: profile.audioClockRate,
    audioChannels: profile.audioChannels,
    audioFmtp: profile.audioFmtp,
    dtmfPayloadType: profile.dtmfPayloadType,
    dtmfClockRate: profile.dtmfClockRate,
  });
  const baseInvite = {
    requestUri: `sip:${toUser}@office.test`,
    localHost: "127.0.0.1",
    localPort: callerAddress.port,
    from: `"${callerName}" <sip:${fromUser}@office.test>;tag=${callId}-tag`,
    to: `<sip:${toUser}@office.test>`,
    callId,
    cseq: 1,
    branch: `z9hG4bK-${callId}-1`,
    contactUser: fromUser,
    body: offerSdp,
  };
  await sendUdp(callerSip, buildInvite(baseInvite), extensionEndpoint.port, extensionEndpoint.host);
  const inviteChallenge = await waitForUdpMessage(callerSip, (message) => message.statusCode === 401 && sipHeader(message, "call-id") === callId, 1000, `${callId}-invite-challenge`);
  const inviteNonce = /nonce="([^"]+)"/.exec(sipHeader(inviteChallenge.message, "www-authenticate"))?.[1] || "";
  assert.ok(inviteNonce, `Missing invite nonce for ${callId}`);
  const inviteHa1 = md5(`401:office.test:secret401`);
  const inviteHa2 = md5(`INVITE:${baseInvite.requestUri}`);
  const inviteResponse = md5(`${inviteHa1}:${inviteNonce}:00000001:invitecnonce:auth:${inviteHa2}`);
  const inviteAuthorization = `Digest username="401", realm="office.test", nonce="${inviteNonce}", uri="${baseInvite.requestUri}", response="${inviteResponse}", algorithm=MD5, qop=auth, nc=00000001, cnonce="invitecnonce"`;
  const tryingPromise = waitForUdpMessage(callerSip, (message) => message.statusCode === 100 && sipHeader(message, "call-id") === callId, 15000, `${callId}-trying`);
  const okPromise = waitForUdpMessage(callerSip, (message) => message.statusCode === 200 && sipHeader(message, "call-id") === callId, 15000, `${callId}-ok`);
  const sessionPromise = waitForCondition(() => triggerEvents.some((event) => event.branch === "Call" && event.payload.callId === callId), 15000, `${callId}-session`);
  await sendUdp(callerSip, buildInvite({
    ...baseInvite,
    branch: `z9hG4bK-${callId}-2`,
    extraHeaders: { Authorization: inviteAuthorization },
  }), extensionEndpoint.port, extensionEndpoint.host);
  await sessionPromise;
  const sessionEvent = triggerEvents.filter((event) => event.branch === "Call" && event.payload.callId === callId).slice(-1)[0];
  assert.ok(sessionEvent, `Missing session event for ${callId}`);
  await runtime.answer(sessionEvent.payload.legId);
  const trying = await tryingPromise;
  assert.strictEqual(trying.message.statusCode, 100);
  const ok = await okPromise;
  assert.strictEqual(ok.message.statusCode, 200);
  const answerPort = parseAudioPortFromSdp(ok.message.body);
  assert.ok(answerPort > 0, `Missing RTP answer port for ${callId}`);
  const ack = [
    `ACK ${sipContactUri(ok.message) || baseInvite.requestUri} SIP/2.0`,
    `Via: SIP/2.0/UDP 127.0.0.1:${callerAddress.port};branch=z9hG4bK-${callId}-ack`,
    "Max-Forwards: 70",
    `From: ${baseInvite.from}`,
    `To: ${sipHeader(ok.message, "to")}`,
    `Call-ID: ${callId}`,
    "CSeq: 1 ACK",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n");
  await sendUdp(callerSip, ack, extensionEndpoint.port, extensionEndpoint.host);
  const playbackStartedAt = Date.now();
  const playbackPromise = runtime.playAudio(sessionEvent.payload.legId, {
    mediaExecutionMode: "blocking",
    sourceType: "http",
    playbackHttpUrl: String(process.env.SIP_PBX_SMOKE_HTTP_URL || "https://pop.stream.laut.fm/pop").trim(),
    playbackHttpMethod: String(process.env.SIP_PBX_SMOKE_HTTP_METHOD || "GET").trim().toUpperCase() || "GET",
  });
  return {
    legId: sessionEvent.payload.legId,
    callId,
    callerSip,
    rtpMonitor,
    answerPort,
    playbackStartedAt,
    playbackPromise,
    close() {
      try {
        callerSip.close();
      } catch {}
      rtpMonitor.close();
    },
  };
}

async function main() {
  const step = (label) => {
    console.error(`[http-repro-smoke] ${label}`);
  };
  const minimumCallDurationMs = Math.max(6000, Number(process.env.SIP_PBX_SMOKE_MIN_CALL_DURATION_MS || 6000));
  const { ControllerClient } = require("../../dist/control/controller-client.js");
  const { PbxRuntime } = require("../../dist/runtime/pbx-runtime.js");
  const { SipPbxDaemon } = require("../../dist/daemon/sip-pbx-daemon.js");
  const { buildLocalAudioSdpDescription } = require("../../dist/daemon/media/codecs/audio-codec.js");
  void buildLocalAudioSdpDescription;

  const httpUrl = String(process.env.SIP_PBX_SMOKE_HTTP_URL || "https://pop.stream.laut.fm/pop").trim();
  const httpMethod = String(process.env.SIP_PBX_SMOKE_HTTP_METHOD || "GET").trim().toUpperCase() || "GET";
  const audioCodecName = String(process.env.SIP_PBX_SMOKE_AUDIO_CODEC || "opus").trim().toLowerCase() || "opus";
  const socketPath = createSocketPath();
  const daemon = new SipPbxDaemon(socketPath);
  await daemon.start();
  const monitors = [];
  let extensionRegistrar = null;
  let completed = false;

  try {
    const runtime = new PbxRuntime(new ControllerClient(socketPath));
    const health = await runtime.health();
    assert.strictEqual(health.status, "ok");

    const extensionsEvents = [];
    const extensionsStream = await runtime.openExtensionsTrigger({
      ref: "office-http-repro",
      transport: "udp",
      localBindIp: "127.0.0.1",
      localBindPort: 0,
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
    }, (event) => extensionsEvents.push(event));
    await sleep(25);
    const extensionEndpoint = daemon.sipTransportService.getExtensionsEndpoint("office-http-repro");
    assert.ok(extensionEndpoint);

    extensionRegistrar = require("dgram").createSocket("udp4");
    await new Promise((resolve) => extensionRegistrar.bind(0, "127.0.0.1", resolve));
    await registerStaticExtension(extensionRegistrar, extensionEndpoint);

    step("create first");
    const first = await createAnsweredInboundExtensionCall({
      daemon,
      runtime,
      extensionEndpoint,
      triggerEvents: extensionsEvents,
      callId: "http-repro-call-1",
      callerName: "HTTP Repro 1",
      fromUser: "caller1",
      toUser: "401",
      audioCodecName,
    });
    monitors.push(first.rtpMonitor);
    step("create second");
    const second = await createAnsweredInboundExtensionCall({
      daemon,
      runtime,
      extensionEndpoint,
      triggerEvents: extensionsEvents,
      callId: "http-repro-call-2",
      callerName: "HTTP Repro 2",
      fromUser: "caller2",
      toUser: "401",
      audioCodecName,
    });
    monitors.push(second.rtpMonitor);

    step("wait first audio");
    const firstAudio = await first.rtpMonitor.waitForAudioAfter(first.playbackStartedAt, 15000, "first audio");
    step("wait second audio");
    const secondAudio = await second.rtpMonitor.waitForAudioAfter(second.playbackStartedAt, 15000, "second audio");
    assert.ok(firstAudio);
    assert.ok(secondAudio);

    step("hangup first");
    await waitForMinimumElapsed(first.playbackStartedAt, minimumCallDurationMs);
    await safeHangup(runtime, first.legId, "first hangup");
    step("await first playback");
    const firstPlayback = await waitForPlaybackTerminal(first.playbackPromise, "first playback");
    first.close();
    await sleep(100);

    step("create fourth");
    const fourth = await createAnsweredInboundExtensionCall({
      daemon,
      runtime,
      extensionEndpoint,
      triggerEvents: extensionsEvents,
      callId: "http-repro-call-4",
      callerName: "HTTP Repro 4",
      fromUser: "caller4",
      toUser: "401",
      audioCodecName,
    });
    monitors.push(fourth.rtpMonitor);
    step("wait fourth audio");
    const fourthAudio = await fourth.rtpMonitor.waitForAudioAfter(fourth.playbackStartedAt, 15000, "fourth audio");
    assert.ok(fourthAudio);

    step("hangup fourth");
    await waitForMinimumElapsed(fourth.playbackStartedAt, minimumCallDurationMs);
    await safeHangup(runtime, fourth.legId, "fourth hangup");
    step("await fourth playback");
    const fourthPlayback = await waitForPlaybackTerminal(fourth.playbackPromise, "fourth playback");
    fourth.close();
    await sleep(100);

    step("create fifth");
    const fifth = await createAnsweredInboundExtensionCall({
      daemon,
      runtime,
      extensionEndpoint,
      triggerEvents: extensionsEvents,
      callId: "http-repro-call-5",
      callerName: "HTTP Repro 5",
      fromUser: "caller5",
      toUser: "401",
      audioCodecName,
    });
    monitors.push(fifth.rtpMonitor);

    step("wait fifth audio");
    const fifthAudioPromise = fifth.rtpMonitor.waitForAudioAfter(fifth.playbackStartedAt, 15000, "fifth audio");
    step("wait second audio after fifth");
    const secondAfterFifthPromise = second.rtpMonitor.waitForAudioAfter(fifth.playbackStartedAt, 15000, "second audio after fifth");
    step("await fifth audio");
    const fifthAudio = await fifthAudioPromise;
    step("await second audio after fifth");
    const secondAfterFifth = await secondAfterFifthPromise;
    assert.ok(fifthAudio);
    assert.ok(secondAfterFifth);

    step("hangup second");
    await Promise.all([
      waitForMinimumElapsed(second.playbackStartedAt, minimumCallDurationMs),
      waitForMinimumElapsed(fifth.playbackStartedAt, minimumCallDurationMs),
    ]);
    await safeHangup(runtime, second.legId, "second hangup");
    step("hangup fifth");
    await safeHangup(runtime, fifth.legId, "fifth hangup");

    step("await second playback");
    const secondPlayback = await waitForPlaybackTerminal(second.playbackPromise, "second playback");
    step("await fifth playback");
    const fifthPlayback = await waitForPlaybackTerminal(fifth.playbackPromise, "fifth playback");
    second.close();
    fifth.close();

    step("done");
    console.log(JSON.stringify({
      ok: true,
      httpUrl,
      sequence: {
        first: firstPlayback.status,
        second: secondPlayback.status,
        fourth: fourthPlayback.status,
        fifth: fifthPlayback.status,
        secondAudioEvents: second.rtpMonitor.audioEvents.length,
        fifthAudioEvents: fifth.rtpMonitor.audioEvents.length,
      },
    }, null, 2));
    completed = true;
  } finally {
    try {
      step("cleanup extensionsStream");
      await extensionsStream.close();
    } catch {}
    for (const monitor of monitors.reverse()) {
      try {
        step("cleanup monitor");
        monitor.close();
      } catch {}
    }
    try {
      step("cleanup extensionRegistrar");
      extensionRegistrar?.close();
    } catch {}
    step("cleanup daemon.stop");
    const daemonStop = daemon.stop();
    const stopResult = await Promise.race([
      daemonStop.then(() => "done", () => "failed"),
      sleep(5000).then(() => "timeout"),
    ]);
    if (stopResult !== "done") {
      console.error(`[http-repro-smoke] daemon.stop ${stopResult}`);
    }
    step("cleanup done");
    if (completed) {
      forceExit(0);
    }
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  forceExit(1);
});
