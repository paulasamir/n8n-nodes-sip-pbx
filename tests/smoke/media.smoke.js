#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

if (process.platform !== "linux") {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "media smoke requires the Linux native backend",
  }, null, 2));
  process.exit(0);
}

function createWavSilenceBase64(durationMs = 120, sampleRate = 8000) {
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const data = Buffer.alloc(sampleCount * 2);
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

async function main() {
  const { MapRegistry } = require("../../dist/shared/map-registry.js");
  const { LegService } = require("../../dist/daemon/legs/leg-service.js");
  const { MediaService } = require("../../dist/daemon/media/media-service.js");

  const legService = new LegService(new MapRegistry());
  const mediaService = new MediaService(new MapRegistry(), legService);

  const leg = legService.createLeg({
    legId: "media-leg-1",
    direction: "inbound",
    transportType: "sip",
    status: "answered",
  });

  const wavBase64 = createWavSilenceBase64(200);
  const tempFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sip-pbx-media-")), "sample.wav");
  fs.writeFileSync(tempFile, Buffer.from(wavBase64, "base64"));

  const server = http.createServer((request, response) => {
    if (request.url === "/sample.wav") {
      response.writeHead(200, { "Content-Type": "audio/wav" });
      response.end(Buffer.from(wavBase64, "base64"));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const httpPort = server.address().port;

    const backgroundPlayback = await mediaService.playAudio(leg.legId, {
      mediaExecutionMode: "background",
      sourceType: "binary",
      binaryDataBase64: wavBase64,
    });
    console.error("media-smoke: background started");
    assert.strictEqual(backgroundPlayback.status, "started");

    const waitedBeforeStop = await mediaService.waitMedia({
      waitMediaIds: [backgroundPlayback.mediaId],
      waitMediaTimeoutSeconds: 0.01,
    });
    console.error("media-smoke: wait before stop");
    assert.strictEqual(waitedBeforeStop.status, "timeout");

    const stopped = await mediaService.stopMedia({
      stopMediaTarget: "mediaId",
      stopMediaId: backgroundPlayback.mediaId,
    });
    console.error("media-smoke: stopped");
    assert.strictEqual(stopped.mediaId, backgroundPlayback.mediaId);

    await assert.rejects(
      mediaService.waitMedia({
        waitMediaIds: [backgroundPlayback.mediaId],
        waitMediaTimeoutSeconds: 0.01,
      }),
    );
    console.error("media-smoke: wait after stop invalid");

    const filePlayback = await mediaService.playAudio(leg.legId, {
      mediaExecutionMode: "blocking",
      sourceType: "file",
      filePath: tempFile,
    });
    console.error("media-smoke: file playback");
    assert.strictEqual(filePlayback.status, "completed");

    const httpPlayback = await mediaService.playAudio(leg.legId, {
      mediaExecutionMode: "blocking",
      sourceType: "http",
      playbackHttpUrl: `http://127.0.0.1:${httpPort}/sample.wav`,
      playbackHttpMethod: "GET",
    });
    console.error("media-smoke: http playback");
    assert.strictEqual(httpPlayback.status, "completed");

    const tone = await mediaService.playTone(leg.legId, {
      mediaExecutionMode: "blocking",
      tone: "busy",
      toneDurationMs: 20,
    });
    console.error("media-smoke: tone playback");
    assert.strictEqual(tone.status, "completed");

    console.log(JSON.stringify({
      ok: true,
      media: {
        backgroundMediaId: backgroundPlayback.mediaId,
        stoppedStatus: waitedAfterStop.status,
        filePlaybackStatus: filePlayback.status,
        httpPlaybackStatus: httpPlayback.status,
        toneStatus: tone.status,
      },
    }, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mediaService.closeAll();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
