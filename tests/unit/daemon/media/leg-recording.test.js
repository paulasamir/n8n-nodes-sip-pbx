"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createConstantPcm16Frame(sampleValue, frameBytes = 320) {
  const buffer = Buffer.alloc(frameBytes);
  for (let offset = 0; offset < frameBytes; offset += 2) {
    buffer.writeInt16LE(sampleValue, offset);
  }
  return buffer;
}

function createFakeTransport() {
  let listener = null;
  return {
    transportType: "websocket",
    configure: async () => ({}),
    getDetails: () => ({}),
    subscribe(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    emit(event) {
      listener?.(event);
    },
    sendPlaybackPcm: async () => false,
    sendDtmf: async () => false,
    close() {},
  };
}

test("Leg bridge playback is ducked by higher-priority local playback", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const sentFrames = [];
  let listener = null;
  const transport = {
    transportType: "websocket",
    configure: async () => ({}),
    getDetails: () => ({}),
    subscribe(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    sendPlaybackPcm: async (pcm, _marker, bytes) => {
      sentFrames.push(Buffer.from(pcm.subarray(0, bytes)));
      return true;
    },
    sendDtmf: async () => false,
    close() {},
  };

  const leg = new Leg({
    legId: "leg-bridge-ducking",
    transportType: "websocket",
    transport,
  });

  try {
    const originalEnsurePlaybackLoop = leg.ensurePlaybackLoop.bind(leg);
    leg.ensurePlaybackLoop = () => undefined;

    leg.registerPlayback({
      mediaId: "playback-primary",
      kind: "playback",
      duckingFactor: 0.5,
      pcm: createConstantPcm16Frame(4000),
    });

    const bridgePromise = leg.sendBridgePcm(createConstantPcm16Frame(2000));
    leg.ensurePlaybackLoop = originalEnsurePlaybackLoop;
    leg.ensurePlaybackLoop();

    const bridgeResult = await bridgePromise;
    assert.strictEqual(bridgeResult, true);
    assert.ok(sentFrames.length > 0);
    assert.strictEqual(sentFrames[0].readInt16LE(0), 5000);
  } finally {
    leg.close();
  }
});

test("Leg.configureTransport forwards inbound allowed codec and DTMF filters into RTP negotiation", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");
  const { RtpTransport } = require("../../../../build-src/daemon/media/transports/rtp-transport.js");
  const {
    SIP_AUDIO_CODEC_ALAW,
    SIP_DTMF_METHOD_INFO,
  } = require("../../../../build-src/shared/sip-media-filters.js");

  const transport = new RtpTransport({
    sendPacket() {
      return false;
    },
  });
  const leg = new Leg({
    legId: "leg-inbound-filtered-negotiation",
    transportType: "sip",
    transport,
  });

  try {
    const details = await leg.configureTransport({
      payloadTypes: [9, 8, 97],
      payloadCodecs: {
        8: { codec: "pcma", clockRate: 8000, channels: 1 },
        9: { codec: "g722", clockRate: 8000, channels: 1 },
        97: { codec: "telephone-event", clockRate: 8000, channels: 1, fmtp: "0-16" },
      },
      allowedAudioCodecs: [SIP_AUDIO_CODEC_ALAW],
      allowedDtmfMethods: [SIP_DTMF_METHOD_INFO],
    });

    assert.strictEqual(details.audioPayloadType, 8);
    assert.strictEqual(details.audioCodecName, "pcma");
    assert.strictEqual(details.dtmfPayloadType, null);
    assert.deepStrictEqual(details.payloadTypes, [8]);
    assert.ok(details.localSdpAudioLines.some((line) => String(line).includes("PCMA/8000")));
    assert.ok(!details.localSdpAudioLines.some((line) => String(line).includes("G722/8000")));
    assert.ok(!details.localSdpAudioLines.some((line) => String(line).includes("telephone-event")));
  } finally {
    leg.close();
  }
});

test("Leg.startRecording prepends inbound pre-roll without duplicating pending frames", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const transport = createFakeTransport();
  const recorded = [];
  const leg = new Leg({
    legId: "leg-preroll-pending",
    transportType: "websocket",
    transport,
    onRecordingPcm: (legId, mediaId, pcm, bytes) => {
      recorded.push({
        legId,
        mediaId,
        bytes,
        pcm: Buffer.from(pcm.subarray(0, bytes)),
      });
    },
  });

  try {
    const speech = Buffer.alloc(320, 0x44);
    transport.emit({
      type: "audio",
      pcm: speech,
      bytes: speech.length,
      sampleRate: 8000,
      channels: 1,
      durationMs: 20,
      level: 0.2,
    });

    const snapshot = leg.startRecording("media-preroll", Date.now(), {
      interruptOnSilence: false,
    });
    await sleep(40);

    assert.strictEqual(snapshot.activeRecordingMediaId, "media-preroll");
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].mediaId, "media-preroll");
    assert.strictEqual(recorded[0].bytes, speech.length);
    assert.deepStrictEqual(recorded[0].pcm, speech);
  } finally {
    leg.close();
  }
});

test("Leg recording emits silence interrupt from inbound PCM levels", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const transport = createFakeTransport();
  const interrupts = [];
  const leg = new Leg({
    legId: "leg-recording-silence",
    transportType: "websocket",
    transport,
    onRecordingInterrupt: (legId, mediaId, reason, details) => {
      interrupts.push({ legId, mediaId, reason, details });
    },
  });

  try {
    leg.startRecording("media-silence", Date.now(), {
      interruptOnSilence: true,
      silenceThreshold: 0.01,
      silenceDurationMs: 40,
    });

    for (let index = 0; index < 3; index += 1) {
      transport.emit({
        type: "audio",
        pcm: Buffer.alloc(320, 0),
        bytes: 320,
        sampleRate: 8000,
        channels: 1,
        durationMs: 20,
        level: 0,
      });
    }

    await sleep(80);

    assert.strictEqual(interrupts.length, 1);
    assert.strictEqual(interrupts[0].legId, "leg-recording-silence");
    assert.strictEqual(interrupts[0].mediaId, "media-silence");
    assert.strictEqual(interrupts[0].reason, "media_silence");
    assert.ok(Number(interrupts[0].details.silenceDurationMs || 0) >= 40);
  } finally {
    leg.close();
  }
});

test("Leg recording emits silence interrupt when inbound PCM stops completely", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const transport = createFakeTransport();
  const interrupts = [];
  const leg = new Leg({
    legId: "leg-recording-silence-timeout",
    transportType: "websocket",
    transport,
    onRecordingInterrupt: (legId, mediaId, reason, details) => {
      interrupts.push({ legId, mediaId, reason, details });
    },
  });

  try {
    leg.startRecording("media-silence-timeout", Date.now(), {
      interruptOnSilence: true,
      silenceThreshold: 0.01,
      silenceDurationMs: 40,
    });

    await sleep(80);

    assert.strictEqual(interrupts.length, 1);
    assert.strictEqual(interrupts[0].legId, "leg-recording-silence-timeout");
    assert.strictEqual(interrupts[0].mediaId, "media-silence-timeout");
    assert.strictEqual(interrupts[0].reason, "media_silence");
    assert.ok(Number(interrupts[0].details.silenceDurationMs || 0) >= 40);
    assert.strictEqual(Number(interrupts[0].details.silenceLevel || 0), 0);
  } finally {
    leg.close();
  }
});

test("Leg pre-roll ring keeps prior frames until inbound PCM format actually changes", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const transport = createFakeTransport();
  const recorded = [];
  const leg = new Leg({
    legId: "leg-preroll-format-change",
    transportType: "websocket",
    transport,
    onRecordingPcm: (legId, mediaId, pcm, bytes, sampleRate, channels) => {
      recorded.push({
        legId,
        mediaId,
        bytes,
        sampleRate,
        channels,
        pcm: Buffer.from(pcm.subarray(0, bytes)),
      });
    },
  });

  try {
    const frame8000 = Buffer.alloc(320, 0x11);
    const frame16000 = Buffer.alloc(640, 0x22);

    transport.emit({
      type: "audio",
      pcm: frame8000,
      bytes: frame8000.length,
      sampleRate: 8000,
      channels: 1,
      durationMs: 20,
      level: 0.2,
    });

    leg.startRecording("media-preroll-8000", Date.now(), {
      interruptOnSilence: false,
    });
    await sleep(40);

    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].sampleRate, 8000);
    assert.deepStrictEqual(recorded[0].pcm, frame8000);

    leg.stopRecording("media-preroll-8000");
    recorded.length = 0;

    transport.emit({
      type: "audio",
      pcm: frame16000,
      bytes: frame16000.length,
      sampleRate: 16000,
      channels: 1,
      durationMs: 20,
      level: 0.2,
    });

    leg.startRecording("media-preroll-16000", Date.now(), {
      interruptOnSilence: false,
    });
    await sleep(40);

    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].sampleRate, 16000);
    assert.deepStrictEqual(recorded[0].pcm, frame16000);
  } finally {
    leg.close();
  }
});

test("Leg.stopRecording flushes pending global-call recording frames before closing", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const sent = [];
  const transport = {
    transportType: "sip",
    configure: async () => ({
      audioPayloadType: 0,
      payloadCodecs: {
        0: {
          codec: "pcmu",
          pcmSampleRate: 8000,
          channels: 1,
        },
      },
    }),
    getDetails: () => ({
      audioPayloadType: 0,
      payloadCodecs: {
        0: {
          codec: "pcmu",
          pcmSampleRate: 8000,
          channels: 1,
        },
      },
    }),
    subscribe() {
      return () => {};
    },
    sendPlaybackPcm: async (pcm, marker, bytes) => {
      sent.push(Buffer.from(pcm.subarray(0, bytes)));
      return true;
    },
    sendDtmf: async () => false,
    close() {},
  };

  const recorded = [];
  const leg = new Leg({
    legId: "leg-record-stop-flush",
    transportType: "sip",
    transport,
    onRecordingPcm: (legId, mediaId, pcm, bytes, sampleRate, channels) => {
      recorded.push({
        legId,
        mediaId,
        sampleRate,
        channels,
        pcm: Buffer.from(pcm.subarray(0, bytes)),
      });
    },
  });

  try {
    leg.refreshPlaybackFormat(transport.getDetails());
    leg.activateGlobalRecording("media-global-stop", Date.now(), {
      recordSplitChannels: true,
    });
    await leg.sendBridgePcm(Buffer.alloc(320, 0x33), 320, 8000, 1);
    leg.deactivateGlobalRecording("media-global-stop");

    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].mediaId, "media-global-stop");
    assert.strictEqual(recorded[0].sampleRate, 8000);
    assert.strictEqual(recorded[0].channels, 2);
    assert.ok(recorded[0].pcm.some((value) => value !== 0));
  } finally {
    leg.close();
  }
});

test("Leg global mono recording forwards single-sided inbound PCM without artificial remix", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const transport = createFakeTransport();
  const recorded = [];
  const leg = new Leg({
    legId: "leg-record-mono-single-sided",
    transportType: "websocket",
    transport,
    onRecordingPcm: (legId, mediaId, pcm, bytes, sampleRate, channels) => {
      recorded.push({
        legId,
        mediaId,
        sampleRate,
        channels,
        pcm: Buffer.from(pcm.subarray(0, bytes)),
      });
    },
  });

  try {
    const inbound = Buffer.alloc(320);
    for (let offset = 0; offset < inbound.length; offset += 2) {
      inbound.writeInt16LE(700, offset);
    }

    leg.activateGlobalRecording("media-mono-single-sided", Date.now(), {
      recordSplitChannels: false,
      recordFileFormat: "wav",
      recordWavSampleRate: 8000,
    });

    transport.emit({
      type: "audio",
      pcm: inbound,
      bytes: inbound.length,
      sampleRate: 8000,
      channels: 1,
      durationMs: 20,
      level: 0.2,
    });

    await sleep(40);
    leg.deactivateGlobalRecording("media-mono-single-sided");

    assert.ok(recorded.length >= 1);
    assert.strictEqual(recorded[0].mediaId, "media-mono-single-sided");
    assert.strictEqual(recorded[0].sampleRate, 8000);
    assert.strictEqual(recorded[0].channels, 1);
    assert.deepStrictEqual(recorded[0].pcm, inbound);
  } finally {
    leg.close();
  }
});

test("Leg.sendBridgePcm grows conversion scratch and retries when resampler output exceeds estimate", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const sent = [];
  const transport = {
    transportType: "sip",
    configure: async () => ({}),
    getDetails: () => ({}),
    subscribe() {
      return () => {};
    },
    sendPlaybackPcm: async (pcm, marker, bytes) => {
      sent.push({
        marker,
        bytes,
        pcm: Buffer.from(pcm.subarray(0, bytes)),
      });
      return true;
    },
    sendDtmf: async () => false,
    close() {},
  };

  const leg = new Leg({
    legId: "leg-bridge-retry",
    transportType: "sip",
    transport,
  });

  try {
    leg.playbackSampleRate = 48000;
    leg.playbackChannels = 1;
    leg.playbackFrameBytes = 1920;
    let attempts = 0;
    leg.getBridgePcmConverter = () => ({
      convertInto(input, inputOffset, inputLength, target, targetOffset, targetLength) {
        attempts += 1;
        if (targetLength < 5000) {
          throw new Error("Target buffer is smaller than converted PCM output");
        }
        const converted = 4096;
        target.fill(0x33, targetOffset, targetOffset + converted);
        return converted;
      },
    });

    const ok = await leg.sendBridgePcm(Buffer.alloc(1920, 0x11), 1920, 24000, 1);

    assert.equal(ok, true);
    assert.equal(attempts, 2);
    assert.ok(sent.length >= 1);
    assert.equal(sent.reduce((total, frame) => total + frame.bytes, 0), 4096);
    assert.ok(sent.every((frame) => frame.bytes > 0));
  } finally {
    leg.close();
  }
});

test("Leg mixes bridged PCM with local playback into one outbound transport frame", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const sent = [];
  const transport = {
    transportType: "websocket",
    configure: async () => ({}),
    getDetails: () => ({}),
    subscribe() {
      return () => {};
    },
    sendPlaybackPcm: async (pcm, marker, bytes) => {
      sent.push({
        marker,
        bytes,
        pcm: Buffer.from(pcm.subarray(0, bytes)),
      });
      return true;
    },
    sendDtmf: async () => false,
    close() {},
  };

  const leg = new Leg({
    legId: "leg-bridge-playback-mix",
    transportType: "websocket",
    transport,
  });

  try {
    leg.registerPlayback({
      mediaId: "tone-local",
      kind: "tone",
      tone: "custom",
      customTone: "440/20",
      durationMs: 20,
      loopPlayback: false,
      startedAt: Date.now(),
    });
    const bridgePcm = Buffer.alloc(320);
    for (let offset = 0; offset < bridgePcm.length; offset += 2) {
      bridgePcm.writeInt16LE(1000, offset);
    }

    const ok = await leg.sendBridgePcm(bridgePcm, bridgePcm.length, 8000, 1);
    await sleep(50);

    assert.equal(ok, true);
    assert.ok(sent.length >= 1);
    assert.equal(sent[0].bytes, 320);
    assert.notDeepStrictEqual(sent[0].pcm, bridgePcm);
  } finally {
    leg.close();
  }
});

test("Leg global split-channel recording captures RTP bridge output before paced send completes", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const recorded = [];
  let listener = null;
  let releaseSend = null;
  const sendStarted = new Promise((resolve) => {
    releaseSend = resolve;
  });
  const transport = {
    transportType: "sip",
    configure: async () => ({
      audioPayloadType: 0,
      payloadCodecs: {
        0: {
          codec: "pcmu",
          pcmSampleRate: 8000,
          channels: 1,
        },
      },
    }),
    getDetails: () => ({
      audioPayloadType: 0,
      payloadCodecs: {
        0: {
          codec: "pcmu",
          pcmSampleRate: 8000,
          channels: 1,
        },
      },
    }),
    subscribe() {
      listener = arguments[0];
      return () => {
        listener = null;
      };
    },
    emit(event) {
      listener?.(event);
    },
    sendPlaybackPcm: async () => {
      await sendStarted;
      return true;
    },
    sendDtmf: async () => false,
    close() {},
  };
  const leg = new Leg({
    legId: "leg-record-paced-bridge",
    transportType: "sip",
    transport,
    onRecordingPcm: (legId, mediaId, pcm, bytes, sampleRate, channels) => {
      recorded.push({
        legId,
        mediaId,
        sampleRate,
        channels,
        pcm: Buffer.from(pcm.subarray(0, bytes)),
      });
    },
  });

  try {
    leg.refreshPlaybackFormat(transport.getDetails());
    leg.activateGlobalRecording("media-paced-bridge", Date.now(), {
      recordSplitChannels: true,
      recordFileFormat: "wav",
      recordWavSampleRate: 8000,
    });

    const outbound = Buffer.alloc(640);
    for (let offset = 0; offset < outbound.length; offset += 2) {
      outbound.writeInt16LE(1200, offset);
    }
    const sendPromise = leg.sendBridgePcm(outbound, outbound.length, 8000, 1);

    for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
      const inbound = Buffer.alloc(320);
      for (let offset = 0; offset < inbound.length; offset += 2) {
        inbound.writeInt16LE(900, offset);
      }
      transport.emit({
        type: "audio",
        pcm: inbound,
        bytes: inbound.length,
        sampleRate: 8000,
        channels: 1,
        durationMs: 20,
        level: 0.2,
      });
    }

    await sleep(55);
    leg.deactivateGlobalRecording("media-paced-bridge");
    assert.ok(recorded.length >= 1);
    const bridgedFrames = recorded.filter((frame) => {
      let leftNonZero = false;
      let rightNonZero = false;
      for (let offset = 0; offset < frame.pcm.length; offset += 4) {
        if (frame.pcm.readInt16LE(offset) !== 0) {
          leftNonZero = true;
        }
        if (frame.pcm.readInt16LE(offset + 2) !== 0) {
          rightNonZero = true;
        }
      }
      return leftNonZero && rightNonZero;
    });
    assert.ok(bridgedFrames.length >= 1);

    releaseSend();
    await sendPromise;
  } finally {
    leg.close();
  }
});

test("Leg keeps media recording and global call recording active in parallel", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const recorded = [];
  const transport = {
    transportType: "sip",
    configure: async () => ({
      audioPayloadType: 0,
      payloadCodecs: {
        0: {
          codec: "pcmu",
          pcmSampleRate: 8000,
          channels: 1,
        },
      },
    }),
    getDetails: () => ({
      audioPayloadType: 0,
      payloadCodecs: {
        0: {
          codec: "pcmu",
          pcmSampleRate: 8000,
          channels: 1,
        },
      },
    }),
    subscribe(next) {
      this.listener = next;
      return () => {
        this.listener = null;
      };
    },
    emit(event) {
      this.listener?.(event);
    },
    sendPlaybackPcm: async () => true,
    sendDtmf: async () => false,
    close() {},
  };

  const leg = new Leg({
    legId: "leg-record-parallel",
    transportType: "sip",
    transport,
    onRecordingPcm: (legId, mediaId, pcm, bytes) => {
      recorded.push({
        legId,
        mediaId,
        pcm: Buffer.from(pcm.subarray(0, bytes)),
      });
    },
  });

  try {
    leg.refreshPlaybackFormat(transport.getDetails());
    leg.activateGlobalRecording("media-global-parallel", Date.now(), {
      recordSplitChannels: true,
      recordFileFormat: "wav",
      recordWavSampleRate: 8000,
    });

    const snapshot = leg.startRecording("media-plain-parallel", Date.now(), {
      interruptOnSilence: false,
    });
    assert.strictEqual(snapshot.activeRecordingMediaId, "media-plain-parallel");

    transport.emit({
      type: "audio",
      pcm: Buffer.alloc(320, 0x21),
      bytes: 320,
      sampleRate: 8000,
      channels: 1,
      durationMs: 20,
      level: 0.2,
    });
    await leg.sendBridgePcm(Buffer.alloc(320, 0x43), 320, 8000, 1);

    await sleep(50);
    leg.stopRecording("media-plain-parallel");
    leg.deactivateGlobalRecording("media-global-parallel");

    assert.ok(recorded.some((frame) => frame.mediaId === "media-plain-parallel"));
    assert.ok(recorded.some((frame) => frame.mediaId === "media-global-parallel"));
  } finally {
    leg.close();
  }
});

test("Leg global split-channel recording normalizes oversized outbound chunks to recording characteristics", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const transport = {
    ...createFakeTransport(),
    sendPlaybackPcm: async () => true,
  };
  const recorded = [];
  const leg = new Leg({
    legId: "leg-record-split-align",
    transportType: "websocket",
    transport,
    onRecordingPcm: (legId, mediaId, pcm, bytes, sampleRate, channels) => {
      recorded.push({
        legId,
        mediaId,
        sampleRate,
        channels,
        pcm: Buffer.from(pcm.subarray(0, bytes)),
      });
    },
  });

  try {
    leg.playbackSampleRate = 24000;
    leg.playbackChannels = 1;
    leg.playbackFrameBytes = 960;
    leg.getRecordingPcmConverter = (role, inputSampleRate, inputChannels, outputSampleRate, outputChannels) => ({
      convertInto(input, inputOffset, inputLength, target, targetOffset = 0, targetLength = target.length - targetOffset) {
        const inputSamples = Math.floor(inputLength / (Math.max(1, inputChannels) * 2));
        const outputSamples = Math.max(1, Math.floor((inputSamples * outputSampleRate) / Math.max(1, inputSampleRate)));
        const outputBytes = outputSamples * Math.max(1, outputChannels) * 2;
        assert.ok(targetLength >= outputBytes);
        target.fill(role === "outbound" ? 0x33 : 0x11, targetOffset, targetOffset + outputBytes);
        return outputBytes;
      },
      close() {},
    });
    leg.activateGlobalRecording("media-split-align", Date.now(), {
      recordSplitChannels: true,
    });

    const inbound20msA = Buffer.alloc(1920, 0x11);
    const inbound20msB = Buffer.alloc(1920, 0x22);
    const outbound40ms = Buffer.alloc(1920, 0x33);

    transport.emit({
      type: "audio",
      pcm: inbound20msA,
      bytes: inbound20msA.length,
      sampleRate: 48000,
      channels: 1,
      durationMs: 20,
      level: 0.2,
    });

    await leg.sendBridgePcm(outbound40ms, outbound40ms.length, 24000, 1);

    transport.emit({
      type: "audio",
      pcm: inbound20msB,
      bytes: inbound20msB.length,
      sampleRate: 48000,
      channels: 1,
      durationMs: 20,
      level: 0.2,
    });

    await sleep(60);
    leg.deactivateGlobalRecording("media-split-align");

    assert.ok(recorded.length >= 2);
    const framesWithAiAudio = [];
    for (const frame of recorded) {
      assert.strictEqual(frame.mediaId, "media-split-align");
      assert.strictEqual(frame.sampleRate, 8000);
      assert.strictEqual(frame.channels, 2);
      let rightChannelNonZero = false;
      for (let offset = 2; offset < frame.pcm.length; offset += 4) {
        if (frame.pcm.readInt16LE(offset) !== 0) {
          rightChannelNonZero = true;
          break;
        }
      }
      if (rightChannelNonZero) {
        framesWithAiAudio.push(frame);
      }
    }
    assert.strictEqual(framesWithAiAudio.length, 2);
    for (const frame of framesWithAiAudio) {
      assert.strictEqual(frame.pcm.length, 640);
    }
  } finally {
    leg.close();
  }
});

test("Leg global split-channel recording converts caller and AI frames to compressed recording sample rate before assembly", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const transport = {
    ...createFakeTransport(),
    sendPlaybackPcm: async () => true,
  };
  const recorded = [];
  const leg = new Leg({
    legId: "leg-record-mp3-rate-align",
    transportType: "websocket",
    transport,
    onRecordingPcm: (legId, mediaId, pcm, bytes, sampleRate, channels) => {
      recorded.push({
        legId,
        mediaId,
        sampleRate,
        channels,
        pcm: Buffer.from(pcm.subarray(0, bytes)),
      });
    },
  });

  try {
    leg.playbackSampleRate = 24000;
    leg.playbackChannels = 1;
    leg.playbackFrameBytes = 960;
    leg.getRecordingPcmConverter = (role, inputSampleRate, inputChannels, outputSampleRate, outputChannels) => ({
      convertInto(input, inputOffset, inputLength, target, targetOffset = 0, targetLength = target.length - targetOffset) {
        const inputSamples = Math.floor(inputLength / (Math.max(1, inputChannels) * 2));
        const outputSamples = Math.max(1, Math.floor((inputSamples * outputSampleRate) / Math.max(1, inputSampleRate)));
        const outputBytes = outputSamples * Math.max(1, outputChannels) * 2;
        assert.ok(targetLength >= outputBytes);
        target.fill(role === "outbound" ? 0x34 : 0x12, targetOffset, targetOffset + outputBytes);
        return outputBytes;
      },
      close() {},
    });
    leg.activateGlobalRecording("media-mp3-align", Date.now(), {
      recordSplitChannels: true,
      recordFileFormat: "mp3",
      recordCompressedSampleRate: 16000,
    });

    transport.emit({
      type: "audio",
      pcm: Buffer.alloc(1920, 0x12),
      bytes: 1920,
      sampleRate: 48000,
      channels: 1,
      durationMs: 20,
      level: 0.2,
    });

    await leg.sendBridgePcm(Buffer.alloc(1920, 0x34), 1920, 24000, 1);

    transport.emit({
      type: "audio",
      pcm: Buffer.alloc(1920, 0x56),
      bytes: 1920,
      sampleRate: 48000,
      channels: 1,
      durationMs: 20,
      level: 0.2,
    });

    await sleep(60);
    leg.deactivateGlobalRecording("media-mp3-align");

    const framesWithAiAudio = recorded.filter((frame) => {
      assert.strictEqual(frame.mediaId, "media-mp3-align");
      assert.strictEqual(frame.sampleRate, 16000);
      assert.strictEqual(frame.channels, 2);
      assert.strictEqual(frame.pcm.length, 1280);
      for (let offset = 2; offset < frame.pcm.length; offset += 4) {
        if (frame.pcm.readInt16LE(offset) !== 0) {
          return true;
        }
      }
      return false;
    });

    assert.strictEqual(framesWithAiAudio.length, 2);
  } finally {
    leg.close();
  }
});

test("Leg websocket inbound audio retains transport frame without intermediate copy and releases pooled buffer after capture", async () => {
  const { Leg } = require("../../../../build-src/daemon/media/worker/entities/leg.js");

  const transport = createFakeTransport();
  const inbound = [];
  let released = 0;
  const leg = new Leg({
    legId: "leg-websocket-direct-inbound",
    transportType: "websocket",
    transport,
    onInboundPcm: (legId, pcm, bytes) => {
      inbound.push({ legId, pcm, bytes });
    },
  });

  try {
    const pcm = Buffer.alloc(320, 0x5a);
    transport.emit({
      type: "audio",
      pcm,
      bytes: pcm.length,
      sampleRate: 8000,
      channels: 1,
      durationMs: 20,
      level: 0.2,
      releasePool: {
        release(buffer) {
          assert.strictEqual(buffer, pcm);
          released += 1;
        },
      },
    });

    await sleep(40);

    assert.strictEqual(inbound.length, 1);
    assert.strictEqual(inbound[0].pcm, pcm);
    assert.strictEqual(inbound[0].bytes, pcm.length);
    assert.strictEqual(released, 1);
  } finally {
    leg.close();
  }
});
