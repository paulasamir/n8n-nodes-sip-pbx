"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

function readPcm16LeSample(buffer, sampleIndex) {
  const offset = sampleIndex * 2;
  const low = buffer[offset] || 0;
  const high = buffer[offset + 1] || 0;
  const value = (high << 8) | low;
  return value & 0x8000 ? value - 0x10000 : value;
}

async function waitForCondition(predicate, timeoutMs = 1000, label = "condition") {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Wait timeout: ${label}`);
}

async function waitForRtpAudioEvent(transport, payloadType, timeoutMs = 1000) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for RTP audio payload ${payloadType}`));
    }, timeoutMs);
    const unsubscribe = transport.subscribe((event) => {
      if (!event || event.type !== "audio" || event.payloadType !== payloadType) {
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

async function collectRtpAudioEvents(transport, payloadType, count, timeoutMs = 1000) {
  return await new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${count} RTP audio payload ${payloadType} events`));
    }, timeoutMs);
    const unsubscribe = transport.subscribe((event) => {
      if (!event || event.type !== "audio" || event.payloadType !== payloadType) {
        return;
      }
      events.push({
        pcm: Buffer.from(event.pcm.subarray(0, event.bytes || event.pcm.length)),
        sampleRate: event.sampleRate,
        channels: event.channels,
        payloadType: event.payloadType,
        receivedAt: Date.now(),
      });
      if (events.length < count) {
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(events);
    });
  });
}

function maxAdjacentPcmDelta(buffer) {
  const sampleCount = Math.floor((buffer?.length || 0) / 2);
  if (sampleCount <= 1) {
    return 0;
  }
  let maxDelta = 0;
  let previous = readPcm16LeSample(buffer, 0);
  for (let index = 1; index < sampleCount; index += 1) {
    const current = readPcm16LeSample(buffer, index);
    const delta = Math.abs(current - previous);
    if (delta > maxDelta) {
      maxDelta = delta;
    }
    previous = current;
  }
  return maxDelta;
}

async function main() {
  const { Workflow } = require("n8n-workflow");
  const { SipPbx } = require("../../build-src/n8n/nodes/SipPbx.node.js");
  const { SipPbxTrigger } = require("../../build-src/n8n/nodes/SipPbxTrigger.node.js");
  const { SipPbxExternal } = require("../../build-src/n8n/credentials/SipPbxExternal.credentials.js");
  const { PbxRuntime } = require("../../build-src/runtime/pbx-runtime.js");
  const { getPbxRuntime } = require("../../build-src/runtime/runtime-factory.js");
  const { SipPbxDaemon } = require("../../build-src/daemon/sip-pbx-daemon.js");
  const { RequestContext } = require("../../build-src/daemon/core/request-context.js");
  const { ControllerMethod } = require("../../build-src/control/controller-protocol.js");
    const {
      buildLocalAudioSdpDescription,
      createCodec,
      getImplementedCodecDescriptors,
      mapDescriptorNameToAudioCodecName,
      loadNativeCodecBindings,
      resolveCodecForPayloadType,
    } = require("../../build-src/daemon/media/codecs/audio-codec.js");
    const { createBinaryInputEndpoint } = require("../../build-src/daemon/media/io/binary-endpoint.js");
    const { createFileInputEndpoint } = require("../../build-src/daemon/media/io/file-endpoint.js");
    const { Mixer } = require("../../build-src/daemon/media/worker/entities/mixer.js");
    const { createStream, guessMediaContainer } = require("../../build-src/daemon/media/streams/media-stream.js");
  const ffmpegStream = require("../../build-src/daemon/media/streams/ffmpeg-stream.js");
  const { buildLocalSipSdp, parseSipSdp } = require("../../build-src/daemon/signaling/sip/sip-sdp.js");
  const { RtpTransport } = require("../../build-src/daemon/media/transports/rtp-transport.js");
  const { MapRegistry } = require("../../build-src/shared/map-registry.js");
  const { LegService } = require("../../build-src/daemon/legs/leg-service.js");
	  const { Dial } = require("../../build-src/daemon/dials/types.js");
	  const { DialService } = require("../../build-src/daemon/dials/dial-service.js");
	  const { MediaWorker } = require("../../build-src/daemon/media/worker/media-worker.js");
	  const { MediaOperation } = require("../../build-src/daemon/media/operations/media-operation.js");
	  const { PlayAudioOperation } = require("../../build-src/daemon/media/operations/play-audio-operation.js");

  assert.strictEqual(typeof SipPbx, "function");
  assert.strictEqual(typeof SipPbxTrigger, "function");
  assert.strictEqual(typeof SipPbxExternal, "function");
  const sipPbxNodeType = new SipPbx();
  const workflow = new Workflow({
    id: "sip-pbx-action-smoke",
    name: "SIP PBX Action Smoke",
    active: false,
    settings: {},
    connections: {},
    nodes: [
      {
        id: "node-1",
        name: "SIP PBX",
        type: "sipPbx",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          resource: "dial",
          operation: "dial.make",
          callMode: "extension",
        },
      },
    ],
    nodeTypes: {
      getByNameAndVersion(name) {
        if (name === "sipPbx") {
          return sipPbxNodeType;
        }
        throw new Error(`Unexpected node type lookup ${name}`);
      },
    },
  });
  assert.ok(workflow);
  assert.ok(workflow.getNode("SIP PBX"));
  for (const relativePath of [
    "./dist/n8n/nodes/SipPbxTrigger.node.js",
    "./dist/n8n/nodes/SipPbx.node.js",
    "./dist/n8n/credentials/SipPbxExternal.credentials.js",
  ]) {
    assert.strictEqual(fs.existsSync(path.resolve(process.cwd(), relativePath)), true, `Missing packaged export ${relativePath}`);
  }

  assert.strictEqual(createStream({ mode: "decode", format: "mp3" }).implementationName, "ffmpeg");
  assert.strictEqual(createStream({ mode: "encode", format: "wav" }).implementationName, "ffmpeg");
  assert.throws(
    () => createStream({ mode: "encode", format: "flac" }),
    /unsupported_media_format|No media stream implementation supports/i,
  );
  assert.strictEqual(guessMediaContainer("audio/mpeg"), "mp3");
  assert.strictEqual(guessMediaContainer("https://cdn.example.test/clip.wav?download=1"), "wav");
  assert.strictEqual(typeof ffmpegStream.FfmpegStream, "function");
  assert.strictEqual(typeof ffmpegStream.guessContainerFormat, "function");
  assert.strictEqual(typeof ffmpegStream.resolveMediaMimeType, "function");

  const binaryEndpoint = createBinaryInputEndpoint({
    binaryDataBase64: Buffer.from("hello").toString("base64"),
    binaryFileName: "clip.wav",
  });
  const binarySource = binaryEndpoint.open();
  const binaryTarget = Buffer.alloc(8);
  assert.strictEqual(binarySource.readInto(binaryTarget), 5);
  assert.strictEqual(binaryTarget.subarray(0, 5).toString("utf8"), "hello");
  binarySource.close?.();
  binaryEndpoint.close?.();

  const filePath = path.join(os.tmpdir(), `sip-pbx-source-${Date.now()}.raw`);
  try {
    fs.writeFileSync(filePath, Buffer.from("world"));
    const fileEndpoint = createFileInputEndpoint({
      filePath,
    });
    const fileSource = fileEndpoint.open();
    const fileTarget = Buffer.alloc(8);
    assert.strictEqual(fileSource.readInto(fileTarget), 5);
    assert.strictEqual(fileTarget.subarray(0, 5).toString("utf8"), "world");
    fileSource.close?.();
    fileEndpoint.close?.();
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }

  const mixer = new Mixer();
  mixer.setSource("mixer-copy-tail", Buffer.from([0x01, 0x02]), false);
  const copiedFrame = mixer.mixFrame({
    activePlaybackMediaIds: ["mixer-copy-tail"],
    playbackMix: [{ mediaId: "mixer-copy-tail", effectiveGain: 1 }],
  }, 320);
  assert.ok(copiedFrame);
  assert.strictEqual(copiedFrame.length, 320);
  assert.strictEqual(copiedFrame[0], 0x01);
  assert.strictEqual(copiedFrame[1], 0x02);
  for (let index = 2; index < copiedFrame.length; index += 1) {
    assert.strictEqual(copiedFrame[index], 0);
  }

  const daemon = new SipPbxDaemon(path.join(process.cwd(), ".unused-smoke.sock"));

  try {
    const runtime = new PbxRuntime({
      async call(method, params) {
        return await daemon.dispatchUnary(new RequestContext(), { method, params });
      },
      async openStream() {
        return {
          onEvent() {
            return () => undefined;
          },
          close() {},
        };
      },
    });
    const health = await runtime.health();
    assert.strictEqual(health.status, "ok");

    const implementedAudioCodecs = getImplementedCodecDescriptors("audio").map((entry) => entry.name);
    const expectedImplementedCodecs = process.platform === "linux"
      ? ["pcmu", "pcma", "g722", "g729", "opus"]
      : ["pcmu", "pcma"];
    for (const codecName of expectedImplementedCodecs) {
      assert.ok(implementedAudioCodecs.includes(codecName), `Expected implemented RTP codec ${codecName}`);
    }

    if (process.platform === "linux") {
      const nativeCodecBindings = loadNativeCodecBindings();
      assert.ok(nativeCodecBindings);
      assert.strictEqual(typeof nativeCodecBindings.Pcm16Converter, "function");
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
      assert.strictEqual(monoToStereoTarget.length > 0, true);
      assert.strictEqual(stereoToMonoTarget.length > 0, true);
    }

    const sdpAudio = process.platform === "linux"
      ? buildLocalAudioSdpDescription(4010, [96, 97], {
          96: { codec: "opus", clockRate: 48000, channels: 1 },
          97: { codec: "telephone-event", clockRate: 8000, channels: 1, fmtp: "0-16" },
        })
      : buildLocalAudioSdpDescription(4010, [8, 101], {
          8: { codec: "pcma", clockRate: 8000, channels: 1 },
          101: { codec: "telephone-event", clockRate: 8000, channels: 1, fmtp: "0-16" },
        });
    assert.ok(sdpAudio);
    assert.strictEqual(sdpAudio.primaryAudioPayloadType, process.platform === "linux" ? 96 : 8);
    assert.strictEqual(sdpAudio.dtmfPayloadType, process.platform === "linux" ? 97 : 101);
    const dynamicOpusSdp = buildLocalSipSdp({
      connectionIp: "127.0.0.1",
      audioLines: sdpAudio.lines,
    });
    const parsedDynamicOpusSdp = parseSipSdp(dynamicOpusSdp);
    assert.deepStrictEqual(parsedDynamicOpusSdp.payloadTypes, process.platform === "linux" ? [96, 97] : [8, 101]);
    assert.strictEqual(parsedDynamicOpusSdp.payloadCodecs[process.platform === "linux" ? 96 : 8].codec, process.platform === "linux" ? "opus" : "pcma");
    assert.strictEqual(parsedDynamicOpusSdp.payloadCodecs[process.platform === "linux" ? 97 : 101].codec, "telephone-event");
    if (process.platform === "linux") {
      const stereoByFmtp = resolveCodecForPayloadType(111, {
        111: { codec: "opus", clockRate: 48000, fmtp: "stereo=1;sprop-stereo=1;useinbandfec=1" },
      });
      assert.ok(stereoByFmtp);
      assert.strictEqual(stereoByFmtp.channels, 2);
      assert.strictEqual(
        buildLocalAudioSdpDescription(4010, [111], {
          111: { codec: "opus", clockRate: 48000, fmtp: "stereo=1;sprop-stereo=1;useinbandfec=1" },
        }).lines.some((line) => line.includes("opus/48000/2")),
        true,
      );
    }

    const roundtripCodec = async (codecName, payloadType, clockRate, channels, fmtp) => {
      const expectedPcmSampleRate = codecName === "opus"
        ? 48000
        : (codecName === "g722" ? 16000 : 8000);
      const payloadCodecs = {
        [payloadType]: { codec: codecName, clockRate, channels, fmtp },
        101: { codec: "telephone-event", clockRate: 8000, channels: 1, fmtp: "0-16" },
      };
      const senderTransport = new RtpTransport({
        codec: createCodec(mapDescriptorNameToAudioCodecName(codecName)),
        config: {
          audioPayloadType: payloadType,
          dtmfPayloadType: 101,
          payloadTypes: [payloadType, 101],
          payloadCodecs,
        },
      });
      const receiverTransport = new RtpTransport({
        codec: createCodec(mapDescriptorNameToAudioCodecName(codecName)),
        config: {
          audioPayloadType: payloadType,
          dtmfPayloadType: 101,
          payloadTypes: [payloadType, 101],
          payloadCodecs,
        },
      });
      const senderDetails = await senderTransport.configure({
        localRtpBindIp: "127.0.0.1",
        localRtpAdvertisedIp: "127.0.0.1",
        audioPayloadType: payloadType,
        dtmfPayloadType: 101,
        payloadTypes: [payloadType, 101],
        payloadCodecs,
      });
      const receiverDetails = await receiverTransport.configure({
        localRtpBindIp: "127.0.0.1",
        localRtpAdvertisedIp: "127.0.0.1",
        audioPayloadType: payloadType,
        dtmfPayloadType: 101,
        payloadTypes: [payloadType, 101],
        payloadCodecs,
      });
      await senderTransport.configure({
        ...senderDetails,
        remoteRtpHost: receiverDetails.localRtpHost,
        remoteRtpPort: receiverDetails.localRtpPort,
        audioPayloadType: payloadType,
        dtmfPayloadType: 101,
        payloadTypes: [payloadType, 101],
        payloadCodecs,
      });
      await receiverTransport.configure({
        ...receiverDetails,
        remoteRtpHost: senderDetails.localRtpHost,
        remoteRtpPort: senderDetails.localRtpPort,
        audioPayloadType: payloadType,
        dtmfPayloadType: 101,
        payloadTypes: [payloadType, 101],
        payloadCodecs,
      });
      const audioPromise = waitForRtpAudioEvent(receiverTransport, payloadType);
      const pcm = channels === 2
        ? createStereoTonePcm(expectedPcmSampleRate, 20, 440)
        : createTonePcm(expectedPcmSampleRate, 20, 440);
      const sent = await senderTransport.sendPlaybackPcm(pcm, true);
      assert.strictEqual(sent, true);
      const event = await audioPromise;
      assert.strictEqual(event.sampleRate, expectedPcmSampleRate);
      assert.strictEqual(event.channels, 1);
      assert.ok(event.pcm.length > 0);
      assert.ok(event.level > 0.01);
      senderTransport.close();
      receiverTransport.close();
      return event;
    };

    const codecRoundtripPayloadTypes = [];
    if (process.platform === "linux") {
      const g722Event = await roundtripCodec("g722", 9, 8000, 1, null);
      const g729Event = await roundtripCodec("g729", 18, 8000, 1, "annexb=no");
      const opusEvent = await roundtripCodec("opus", 111, 48000, 2, "maxplaybackrate=48000;sprop-maxcapturerate=48000;stereo=1;sprop-stereo=1;useinbandfec=1");
      codecRoundtripPayloadTypes.push(g722Event.payloadType, g729Event.payloadType, opusEvent.payloadType);
    }

    const toneMixer = new Mixer();
    toneMixer.setToneSource("tone-loop", {
      tone: "custom",
      customTone: "440/20",
      durationMs: 40,
      loop: true,
    });
    const toneSnapshot = {
      activePlaybackMediaIds: ["tone-loop"],
      playbackMix: [{ mediaId: "tone-loop", effectiveGain: 1 }],
    };
    const toneFrameA = toneMixer.mixFrame(toneSnapshot, 320);
    const toneFrameB = toneMixer.mixFrame(toneSnapshot, 320);
    assert.ok(Buffer.isBuffer(toneFrameA));
    assert.ok(Buffer.isBuffer(toneFrameB));
    const expectedLoopBoundarySample = Math.round(Math.sin((2 * Math.PI * 440 * 160) / 8000) * 32767 * 0.2);
    assert.ok(Math.abs(readPcm16LeSample(toneFrameA, 0)) <= 1);
    assert.ok(Math.abs(readPcm16LeSample(toneFrameB, 0) - expectedLoopBoundarySample) <= 2);

    const reconfiguredToneMixer = new Mixer();
    reconfiguredToneMixer.setToneSource("tone-reconfigure", {
      tone: "custom",
      customTone: "440/100",
      durationMs: 100,
      loop: true,
      sampleRate: 8000,
    });
    const reconfiguredToneSnapshot = {
      activePlaybackMediaIds: ["tone-reconfigure"],
      playbackMix: [{ mediaId: "tone-reconfigure", effectiveGain: 1 }],
    };
    const reconfiguredToneFrameA = reconfiguredToneMixer.mixFrame(reconfiguredToneSnapshot, 320);
    assert.ok(Buffer.isBuffer(reconfiguredToneFrameA));
    reconfiguredToneMixer.reconfigureToneSources(16000);
    const reconfiguredToneFrameB = reconfiguredToneMixer.mixFrame(reconfiguredToneSnapshot, 640);
    assert.ok(Buffer.isBuffer(reconfiguredToneFrameB));
    const expectedReconfiguredBoundarySample = Math.round(Math.sin((2 * Math.PI * 440 * 160) / 8000) * 32767 * 0.2);
    assert.ok(Math.abs(readPcm16LeSample(reconfiguredToneFrameB, 0) - expectedReconfiguredBoundarySample) <= 2);

    const shortLoopMixer = new Mixer();
    shortLoopMixer.setToneSource("tone-short-loop", {
      tone: "custom",
      customTone: "480/1",
      durationMs: 40,
      loop: true,
    });
    const shortLoopSnapshot = {
      activePlaybackMediaIds: ["tone-short-loop"],
      playbackMix: [{ mediaId: "tone-short-loop", effectiveGain: 1 }],
    };
    const shortLoopFrameA = shortLoopMixer.mixFrame(shortLoopSnapshot, 320);
    const shortLoopFrameB = shortLoopMixer.mixFrame(shortLoopSnapshot, 320);
    assert.ok(Buffer.isBuffer(shortLoopFrameA));
    assert.ok(Buffer.isBuffer(shortLoopFrameB));
    const expectedShortLoopSample = Math.round(Math.sin((2 * Math.PI * 480 * 160) / 8000) * 32767 * 0.2);
    assert.ok(Math.abs(readPcm16LeSample(shortLoopFrameA, 0)) <= 1);
    assert.ok(Math.abs(readPcm16LeSample(shortLoopFrameB, 0) - expectedShortLoopSample) <= 2);

    const roundtripCustomTone = async (codecName, payloadType, clockRate, channels, fmtp) => {
      const expectedPcmSampleRate = codecName === "opus"
        ? 48000
        : (codecName === "g722" ? 16000 : 8000);
      const payloadCodecs = {
        [payloadType]: { codec: codecName, clockRate, channels, fmtp },
        101: { codec: "telephone-event", clockRate: 8000, channels: 1, fmtp: "0-16" },
      };
      const senderTransport = new RtpTransport({
        codec: createCodec(mapDescriptorNameToAudioCodecName(codecName)),
        config: {
          audioPayloadType: payloadType,
          dtmfPayloadType: 101,
          payloadTypes: [payloadType, 101],
          payloadCodecs,
        },
      });
      const receiverTransport = new RtpTransport({
        codec: createCodec(mapDescriptorNameToAudioCodecName(codecName)),
        config: {
          audioPayloadType: payloadType,
          dtmfPayloadType: 101,
          payloadTypes: [payloadType, 101],
          payloadCodecs,
        },
      });
      const senderDetails = await senderTransport.configure({
        localRtpBindIp: "127.0.0.1",
        localRtpAdvertisedIp: "127.0.0.1",
        audioPayloadType: payloadType,
        dtmfPayloadType: 101,
        payloadTypes: [payloadType, 101],
        payloadCodecs,
      });
      const receiverDetails = await receiverTransport.configure({
        localRtpBindIp: "127.0.0.1",
        localRtpAdvertisedIp: "127.0.0.1",
        audioPayloadType: payloadType,
        dtmfPayloadType: 101,
        payloadTypes: [payloadType, 101],
        payloadCodecs,
      });
      await senderTransport.configure({
        ...senderDetails,
        remoteRtpHost: receiverDetails.localRtpHost,
        remoteRtpPort: receiverDetails.localRtpPort,
        audioPayloadType: payloadType,
        dtmfPayloadType: 101,
        payloadTypes: [payloadType, 101],
        payloadCodecs,
      });
      await receiverTransport.configure({
        ...receiverDetails,
        remoteRtpHost: senderDetails.localRtpHost,
        remoteRtpPort: senderDetails.localRtpPort,
        audioPayloadType: payloadType,
        dtmfPayloadType: 101,
        payloadTypes: [payloadType, 101],
        payloadCodecs,
      });
      const diagnosticMixer = new Mixer();
      diagnosticMixer.setToneSource(`tone-roundtrip-${codecName}`, {
        tone: "custom",
        customTone: "480/1",
        durationMs: 400,
        loop: true,
        sampleRate: expectedPcmSampleRate,
      });
      const diagnosticSnapshot = {
        activePlaybackMediaIds: [`tone-roundtrip-${codecName}`],
        playbackMix: [{ mediaId: `tone-roundtrip-${codecName}`, effectiveGain: 1 }],
      };
      const monoFrameBytes = Math.max(2, Math.round(expectedPcmSampleRate / 50) * 2);
      const monoFrames = [];
      for (let index = 0; index < 20; index += 1) {
        const frame = diagnosticMixer.mixFrame(diagnosticSnapshot, monoFrameBytes);
        assert.ok(Buffer.isBuffer(frame), `Expected diagnostic tone frame for ${codecName}`);
        monoFrames.push(Buffer.from(frame));
      }
      const monoPcm = Buffer.concat(monoFrames);
      const localMaxDelta = maxAdjacentPcmDelta(monoPcm);
      let outboundPcm = monoPcm;
      let converter = null;
      try {
        if (channels === 2) {
          converter = new nativeCodecBindings.Pcm16Converter(expectedPcmSampleRate, 1, expectedPcmSampleRate, 2);
          outboundPcm = Buffer.allocUnsafe(monoPcm.length * 2);
          const convertedBytes = converter.convertInto(monoPcm, 0, monoPcm.length, outboundPcm, 0, outboundPcm.length);
          assert.strictEqual(convertedBytes, outboundPcm.length);
        }
        const audioPromise = collectRtpAudioEvents(receiverTransport, payloadType, 20, 2000);
        const sent = await senderTransport.sendPlaybackPcm(outboundPcm, true);
        assert.strictEqual(sent, true);
        const events = await audioPromise;
        const receivedPcm = Buffer.concat(events.map((event) => event.pcm));
        assert.ok(receivedPcm.length > 0);
        assert.ok(events[events.length - 1].receivedAt - events[0].receivedAt >= 250, `Expected paced ${codecName} RTP playback spread, got ${events[events.length - 1].receivedAt - events[0].receivedAt}ms`);
        const receivedMaxDelta = maxAdjacentPcmDelta(receivedPcm);
        assert.ok(
          receivedMaxDelta <= Math.max(28000, (localMaxDelta * 8) + 1024),
          `Unexpected ${codecName} RTP tone discontinuity: localMaxDelta=${localMaxDelta}, receivedMaxDelta=${receivedMaxDelta}`,
        );
      } finally {
        try {
          converter?.close();
        } catch {}
        senderTransport.close();
        receiverTransport.close();
      }
    };
    await roundtripCustomTone("pcmu", 0, 8000, 1, null);
    if (process.platform === "linux") {
      await roundtripCustomTone("opus", 111, 48000, 2, "maxplaybackrate=48000;sprop-maxcapturerate=48000;stereo=1;sprop-stereo=1;useinbandfec=1");
    }

    const finiteToneMixer = new Mixer();
    finiteToneMixer.setToneSource("tone-finite", {
      tone: "custom",
      customTone: "440/100",
      durationMs: 100,
      loop: false,
    });
    const finiteToneSnapshot = {
      activePlaybackMediaIds: ["tone-finite"],
      playbackMix: [{ mediaId: "tone-finite", effectiveGain: 1 }],
    };
    const finiteToneFrameA = finiteToneMixer.mixFrame(finiteToneSnapshot, 320);
    const finiteToneFrameB = finiteToneMixer.mixFrame(finiteToneSnapshot, 320);
    assert.ok(Buffer.isBuffer(finiteToneFrameA));
    assert.ok(Buffer.isBuffer(finiteToneFrameB));
    const expectedContinuousSample = Math.round(Math.sin((2 * Math.PI * 440 * 160) / 8000) * 32767 * 0.2);
    assert.ok(Math.abs(readPcm16LeSample(finiteToneFrameB, 0) - expectedContinuousSample) <= 2);

    const releaseMixer = new Mixer();
    let releaseCount = 0;
    releaseMixer.addMedia({ mediaId: "release-chunk" });
    releaseMixer.appendChunk("release-chunk", Buffer.alloc(320), 320, {
      release() {
        releaseCount += 1;
      },
    });
    const releaseSnapshot = {
      activePlaybackMediaIds: ["release-chunk"],
      playbackMix: [{ mediaId: "release-chunk", effectiveGain: 1 }],
    };
    const releaseFrame = releaseMixer.mixFrame(releaseSnapshot, 320);
    assert.ok(Buffer.isBuffer(releaseFrame));
    assert.strictEqual(releaseCount, 1);

    const fastPathMixer = new Mixer();
    fastPathMixer.addMedia({ mediaId: "fast-path" });
    const fastPathPcm = Buffer.from([0x01, 0x00, 0x02, 0x00]);
    fastPathMixer.appendChunk("fast-path", fastPathPcm, fastPathPcm.length);
    const fastPathTarget = Buffer.alloc(320, 0x7f);
    const fastPathSnapshot = {
      activePlaybackMediaIds: ["fast-path"],
      playbackMix: [{ mediaId: "fast-path", effectiveGain: 1 }],
    };
    const fastPathFrame = fastPathMixer.mixFrame(fastPathSnapshot, 320, fastPathTarget);
    assert.ok(Buffer.isBuffer(fastPathFrame));
    assert.strictEqual(readPcm16LeSample(fastPathFrame, 0), 1);
    assert.strictEqual(readPcm16LeSample(fastPathFrame, 1), 2);
    assert.strictEqual(fastPathFrame.subarray(4).every((byte) => byte === 0), true);

    daemon.registerTriggerStream({
      kind: "queue",
      config: {
        ref: "support",
        queueExtensions: [],
        queueRetryPauseSeconds: 0.01,
      },
      socket: {
        end() {},
        on() {},
        once() {},
        off() {},
        removeListener() {},
      },
      write() {},
    });

    const leg = daemon.legService.createLeg({
      legId: "leg-build-src-queue",
      direction: "inbound",
      transportType: "sip",
      status: "created",
    });

    const queueResult = await runtime.enqueueLeg("support", leg.legId, "back");
    assert.strictEqual(queueResult.legId, leg.legId);

    const queueStats = await runtime.getQueueStats({
      queueStatsTarget: "legId",
      legId: leg.legId,
    });
    assert.strictEqual(queueStats.ref, "support");
    assert.strictEqual(queueStats.position, 1);
    await runtime.hangup(leg.legId);
    await assert.rejects(
      runtime.getQueueStats({
        queueStatsTarget: "legId",
        legId: leg.legId,
      }),
      /invalid_queue_stats_target|Unknown queue target|not in queue/i,
    );
    await assert.rejects(
      runtime.getQueueStats({
        queueStatsTarget: "ref",
        ref: "missing-support",
      }),
      /invalid_queue_stats_target|Unknown queue ref/i,
    );

    daemon.extensionService.registerEndpoint({
      ref: "office-ext",
      extensionNumber: "100",
      contactUri: "sip:100@office.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "office-ext",
      extensionNumber: "101",
      contactUri: "sip:101@office.local",
    });

    const extensionDialResult = await runtime.makeDial({
      callMode: "extension",
      callStrategy: "parallel",
      extensionNumbers: ["100", "101"],
    });
    assert.ok(extensionDialResult.dialId);
    assert.deepStrictEqual(daemon.extensionService.listAvailableExtensionTargets(["100", "101"]), [
      { ref: "office-ext", extensionNumber: "100", endpointId: "contact:sip:100@office.local" },
      { ref: "office-ext", extensionNumber: "101", endpointId: "contact:sip:101@office.local" },
    ]);

    daemon.extensionService.registerEndpoint({
      ref: "office-ext-list-a",
      extensionNumber: "300",
      contactUri: "sip:300@office-a.local",
    });
    daemon.extensionService.registerEndpoint({
      ref: "office-ext-list-b",
      extensionNumber: "300",
      contactUri: "sip:300@office-b.local",
    });
    assert.deepStrictEqual(daemon.extensionService.listAvailableExtensionTargets(["300"]), [
      { ref: "office-ext-list-a", extensionNumber: "300", endpointId: "contact:sip:300@office-a.local" },
      { ref: "office-ext-list-b", extensionNumber: "300", endpointId: "contact:sip:300@office-b.local" },
    ]);

    const sequentialDialResult = await runtime.makeDial({
      callMode: "direct",
      callStrategy: "sequential",
      destination: ["200", "201"],
      sequentialAttemptTimeoutSeconds: 1,
      sequentialGapSeconds: 0.005,
      callerNumber: "+12025550100",
      callerName: "Source Build",
      sipCredentials: {
        sipServer: "sip.example.test",
        port: 5061,
        transport: "tls",
        username: "alice",
      },
    });
    const sequentialDialRecord = daemon.dialRegistry.get(sequentialDialResult.dialId).dial;
    assert.strictEqual(sequentialDialRecord.attemptLegIds.length, 1);
    const sequentialAttemptLeg = daemon.legService.getLeg(sequentialDialRecord.attemptLegIds[0]);
    assert.strictEqual(sequentialAttemptLeg.signalingDetails.callerNumber, "+12025550100");
    assert.strictEqual(sequentialAttemptLeg.signalingDetails.callerName, "Source Build");
    assert.strictEqual(sequentialAttemptLeg.signalingDetails.sipCredentials.username, "alice");
    if (daemon.dialRegistry.get(sequentialDialResult.dialId)) {
      daemon.dialService.breakDial(sequentialDialResult.dialId, "smoke_cleanup");
    }

    const bridgeLegA = daemon.legService.createLeg({
      legId: "leg-bridge-a",
      direction: "inbound",
      transportType: "sip",
      status: "answered",
    });
    const bridgeLegB = daemon.legService.createLeg({
      legId: "leg-bridge-b",
      direction: "outbound",
      transportType: "sip",
      status: "answered",
    });
    const bridgeResult = await runtime.bridge(bridgeLegA.legId, bridgeLegB.legId, {
      emitDtmfEvents: true,
      relayDtmf: "auto",
    });
    assert.strictEqual(bridgeResult.legAId, bridgeLegA.legId);
    assert.strictEqual(bridgeResult.legBId, bridgeLegB.legId);
    assert.ok(daemon.legService.getLeg(bridgeLegA.legId));
    assert.ok(daemon.legService.getLeg(bridgeLegB.legId));
    const bridgeInterruptPromise = runtime.waitForLegEvent(bridgeLegB.legId, {
      timeoutSeconds: 1,
    });
    await runtime.hangup(bridgeLegA.legId);
    const bridgeInterruptEvent = await bridgeInterruptPromise;
    assert.strictEqual(bridgeInterruptEvent.output, "interrupt");
    assert.strictEqual(bridgeInterruptEvent.reason, "bridge");
    const survivingLeg = daemon.legService.getLeg(bridgeLegB.legId);
    assert.ok(survivingLeg);
    assert.strictEqual(survivingLeg.bridgePeerLegId, undefined);

    const orphanRuntimeWorker = new MediaWorker("orphan-worker");
    const orphanLegA = orphanRuntimeWorker.ensureLeg({ legId: "orphan-leg-a", transportType: "sip" });
    const orphanLegB = orphanRuntimeWorker.ensureLeg({ legId: "orphan-leg-b", transportType: "sip" });
    const orphanMergedBridge = orphanRuntimeWorker.mergeLegs(orphanLegA.legId, orphanLegB.legId);
    orphanRuntimeWorker.removeLeg(orphanLegA.legId);
    const orphanSurvivingLeg = orphanRuntimeWorker.getLeg(orphanLegB.legId);
    assert.ok(orphanSurvivingLeg);
    assert.strictEqual(orphanSurvivingLeg.bridge, orphanMergedBridge);
    assert.strictEqual(orphanMergedBridge.size(), 1);
    assert.strictEqual(orphanRuntimeWorker.listBridges().length, 1);
    assert.strictEqual(orphanRuntimeWorker.listBridges()[0], orphanMergedBridge);
    orphanRuntimeWorker.clear();

    const dialResult = await runtime.makeDial({
      callMode: "direct",
      callStrategy: "parallel",
      destination: ["100", "101"],
      sipCredentials: {
        sipServer: "sip.example.test",
        port: 5060,
        transport: "udp",
        username: "alice",
      },
    });
    assert.ok(dialResult.dialId);

    const dialRecord = daemon.dialRegistry.get(dialResult.dialId).dial;
    assert.strictEqual(dialRecord.attemptLegIds.length, 2);

    const firstAttemptLegId = dialRecord.attemptLegIds[0];
    await runtime.ringing(firstAttemptLegId);
    const ringingEvent = await runtime.waitForDialEvent(dialResult.dialId, {
      dialTimeoutSeconds: 1,
      waitEventOutputs: ["ringing"],
    });
    assert.strictEqual(ringingEvent.eventType, "ringing");
    assert.strictEqual(ringingEvent.legId, firstAttemptLegId);

    const answeredPromise = runtime.waitForDialEvent(dialResult.dialId, {
      dialTimeoutSeconds: 1,
      waitEventOutputs: ["answered"],
    });
    await runtime.answer(firstAttemptLegId);
    const answeredEvent = await answeredPromise;
    assert.strictEqual(answeredEvent.eventType, "answered");
    assert.strictEqual(answeredEvent.legId, firstAttemptLegId);

    const originalTtl = process.env.SIP_PBX_FREE_TTL_MS;
    process.env.SIP_PBX_FREE_TTL_MS = "30";
    try {
      const isolatedLegService = new LegService(new MapRegistry());
      const isolatedDialRegistry = new MapRegistry();
      const isolatedDialService = new DialService(isolatedDialRegistry, isolatedLegService);
      isolatedDialService.setOnAttemptStarted(() => undefined);
      const sequentialRetryDial = isolatedDialService.createDial({
        strategy: "sequential",
        targets: ["sip:retry-a@example.test", "sip:retry-b@example.test"],
        mode: "sip",
        sequentialGapSeconds: 0.005,
      });
      isolatedDialService.markAttemptRejected(sequentialRetryDial.dialId, sequentialRetryDial.attemptLegIds[0], "hangup");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(isolatedDialRegistry.get(sequentialRetryDial.dialId).attemptLegIds.length, 2);
      isolatedDialService.breakDial(sequentialRetryDial.dialId, "smoke_cleanup");
      const retainedDial = isolatedDialService.createDial({
        strategy: "parallel",
        targets: ["sip:ttl@example.test"],
        mode: "sip",
      });
      const retainedDialAttemptLegId = retainedDial.attemptLegIds[0];
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.strictEqual(isolatedDialRegistry.get(retainedDial.dialId), null);
      assert.strictEqual(isolatedLegService.getLeg(retainedDialAttemptLegId), null);

      const retainedDialWithOwner = isolatedDialService.createDial({
        strategy: "parallel",
        targets: ["sip:ttl-retained@example.test"],
        mode: "sip",
      });
      const retainedAttemptLegId = retainedDialWithOwner.attemptLegIds[0];
      const retainedDialTicket = retainedDialWithOwner.retain("smoke-test");
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.ok(isolatedDialRegistry.get(retainedDialWithOwner.dialId));
      retainedDialTicket.release();
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.strictEqual(isolatedDialRegistry.get(retainedDialWithOwner.dialId), null);
      assert.strictEqual(isolatedLegService.getLeg(retainedAttemptLegId), null);

      const orphanInboundLeg = isolatedLegService.createLeg({
        direction: "inbound",
        transportType: "sip",
      });
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.strictEqual(isolatedLegService.getLeg(orphanInboundLeg.legId), null);

      const retainedInboundLeg = isolatedLegService.createLeg({
        direction: "inbound",
        transportType: "sip",
      });
      const retainedInboundTicket = retainedInboundLeg.retain("smoke-test");
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.ok(isolatedLegService.getLeg(retainedInboundLeg.legId));
      retainedInboundTicket.release();
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.strictEqual(isolatedLegService.getLeg(retainedInboundLeg.legId), null);

      const isolatedMediaRegistry = new MapRegistry();
      {
        const orphanMedia = PlayAudioOperation.create(isolatedMediaRegistry, {
          mediaId: "media-orphan",
          legId: "leg-orphan",
          sourceRef: "https://example.test/audio.mp3",
          options: {},
          onDestroy: async () => {
            return { reason: "free_ttl" };
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 45));
        assert.strictEqual(isolatedMediaRegistry.get(orphanMedia.mediaId), null);

        const retainedMedia = PlayAudioOperation.create(isolatedMediaRegistry, {
          mediaId: "media-retained",
          legId: "leg-retained",
          sourceRef: "https://example.test/audio.mp3",
          options: {},
          onDestroy: async () => {
            return { reason: "free_ttl" };
          },
        });
        const retainedMediaTicket = retainedMedia.retain("smoke-test");
        await new Promise((resolve) => setTimeout(resolve, 45));
        assert.strictEqual(isolatedMediaRegistry.get(retainedMedia.mediaId)?.finalized, false);
        retainedMediaTicket.release();
        await new Promise((resolve) => setTimeout(resolve, 45));
        assert.strictEqual(isolatedMediaRegistry.get(retainedMedia.mediaId), null);
      }
    } finally {
      if (originalTtl == null) {
        delete process.env.SIP_PBX_FREE_TTL_MS;
      } else {
        process.env.SIP_PBX_FREE_TTL_MS = originalTtl;
      }
    }

    const authRequest = daemon.authService.createRequest({
      triggerKey: "wf:ext-trigger",
      triggerKind: "extensions",
      ref: "office-ext",
      requestContext: {
        requestType: "register",
        method: "REGISTER",
        username: "100",
        endpointExtension: "100",
        realm: "office.local",
        hasAuthorization: true,
        authorization: { scheme: "Digest", params: { username: "100" } },
        sourceIp: "203.0.113.5",
      },
    });
    const authResponse = await daemon.dispatchUnary(new RequestContext(), {
      method: ControllerMethod.executeAction,
      params: {
        operation: "respond.toAuth",
        authRequestId: authRequest.authRequestId,
        authAction: "allow",
      },
    });
    assert.strictEqual(authResponse.emissions[0].payload.authRequestId, authRequest.authRequestId);

    const timedAuthRequest = daemon.authService.createRequest({
      triggerKey: "wf:ext-trigger",
      triggerKind: "extensions",
      ref: "office-ext",
      timeout: 10,
      requestContext: {
        requestType: "register",
        method: "REGISTER",
        username: "101",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await assert.rejects(
      daemon.dispatchUnary(new RequestContext(), {
      method: ControllerMethod.executeAction,
      params: {
        operation: "respond.toAuth",
        authRequestId: timedAuthRequest.authRequestId,
        authAction: "allow",
      },
      }),
      /Unknown auth request/,
    );

    const runtimeA = getPbxRuntime({
      getWorkflow() {
        return { id: "wf-a" };
      },
    });
    const runtimeASame = getPbxRuntime({
      getWorkflow() {
        return { id: "wf-a" };
      },
    });
    const runtimeB = getPbxRuntime({
      getWorkflow() {
        return { id: "wf-b" };
      },
    });
    assert.strictEqual(runtimeA, runtimeASame);
    assert.notStrictEqual(runtimeA, runtimeB);

    const executionPlane = daemon.mediaService.executionPlane;
    const expectedWorkerCapacity = Math.max(
      1,
      Math.min(8, typeof os.availableParallelism === "function" ? os.availableParallelism() : (os.cpus().length || 1)),
    );
    const scalingLegIds = [];
    for (let index = 0; index < 40; index += 1) {
      const leg = daemon.legService.createLeg({
        legId: `leg-scale-${index}`,
        direction: index % 2 === 0 ? "inbound" : "outbound",
        transportType: "sip",
        status: "created",
      });
      scalingLegIds.push(leg.legId);
      await daemon.mediaService.ensureTransportEndpoint(leg.legId);
    }
    const workerCount = typeof executionPlane.getWorkerCount === "function"
      ? executionPlane.getWorkerCount()
      : executionPlane.workers.size;
    assert.ok(workerCount >= 1);
    if (expectedWorkerCapacity > 1) {
      assert.ok(workerCount > 1, `Expected multiple media workers, got ${workerCount}`);
    }
    const workerCountBeforeCleanup = workerCount;
    for (const legId of scalingLegIds) {
      daemon.legService.hangupLeg(legId, "test_cleanup");
    }
    await waitForCondition(
      () => executionPlane.getWorkerCount() <= workerCountBeforeCleanup,
      15000,
      "media-worker-reap",
    );

    console.log(JSON.stringify({
      ok: true,
      sourceBuild: {
        healthOk: health.ok,
        codecs: implementedAudioCodecs,
        codecRoundtripPayloadTypes,
        queuePosition: queueStats.position,
        extensionDialId: extensionDialResult.dialId,
        sequentialDialId: sequentialDialResult.dialId,
        bridgeLegAId: bridgeResult.legAId,
        bridgeLegBId: bridgeResult.legBId,
        dialId: dialResult.dialId,
        answeredLegId: answeredEvent.legId,
        authRequestId: authRequest.authRequestId,
        timedOutAuthRequestId: timedAuthRequest.authRequestId,
        mediaWorkerCount: workerCount,
        runtimeScopesOk: true,
      },
    }, null, 2));
  } finally {
    try {
      await daemon.stop();
    } catch {}
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
