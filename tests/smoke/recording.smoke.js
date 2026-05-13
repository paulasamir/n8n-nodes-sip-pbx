#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

function createSocketPath() {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".smoke-recording-"));
  return path.join(tempDir, "daemon.sock");
}

function assertRecordingContainer(format, buffer, options = {}) {
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0, `${format} recording is empty`);
  if (format === "wav") {
    assert.strictEqual(buffer.subarray(0, 4).toString("ascii"), "RIFF");
    assert.strictEqual(buffer.subarray(8, 12).toString("ascii"), "WAVE");
    const riffSize = buffer.readUInt32LE(4);
    if (options.allowStreamingWavSizes && riffSize === 0xffffffff) {
      // Non-seekable sinks may use unknown-size RIFF/data sentinels.
    } else {
      assert.strictEqual(riffSize, buffer.length - 8);
    }
    let dataOffset = -1;
    for (let offset = 12; offset + 8 <= buffer.length;) {
      const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkId === "data") {
        dataOffset = offset;
        if (options.allowStreamingWavSizes && chunkSize === 0xffffffff) {
          break;
        }
        assert.strictEqual(chunkSize, buffer.length - offset - 8);
        break;
      }
      if (chunkSize === 0xffffffff) {
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    assert.notStrictEqual(dataOffset, -1, "wav recording has no data chunk");
    return;
  }
  if (format === "mp3") {
    const startsWithId3 = buffer.subarray(0, 3).toString("ascii") === "ID3";
    const startsWithFrameSync = buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
    assert.ok(startsWithId3 || startsWithFrameSync, "mp3 recording has invalid container header");
    return;
  }
  if (format === "opus" || format === "ogg") {
    assert.strictEqual(buffer.subarray(0, 4).toString("ascii"), "OggS");
    return;
  }
  throw new Error(`Unsupported recording container test format ${format}`);
}

async function main() {
  const { ControllerClient } = require("../../dist/control/controller-client.js");
  const { PbxRuntime } = require("../../dist/runtime/pbx-runtime.js");
  const { SipPbxDaemon } = require("../../dist/daemon/sip-pbx-daemon.js");

  const socketPath = createSocketPath();
  const daemon = new SipPbxDaemon(socketPath);
  await daemon.start();

  try {
    const runtime = new PbxRuntime(new ControllerClient(socketPath));
    const leg = daemon.legService.createLeg({
      legId: "record-leg-1",
      direction: "inbound",
      transportType: "sip",
      status: "answered",
    });

    const uploadBodies = [];
    const uploadServer = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        uploadBodies.push(Buffer.concat(chunks));
        response.writeHead(200);
        response.end("ok");
      });
    });
    await new Promise((resolve) => uploadServer.listen(0, "127.0.0.1", resolve));
    const uploadPort = uploadServer.address().port;

    const blockingRecording = await runtime.recordAudio(leg.legId, {
      mediaExecutionMode: "blocking",
      recordFileFormat: "wav",
      recordOutputType: "binary",
      recordBinaryProperty: "data",
      maxDurationSeconds: 0.05,
    });
    assert.strictEqual(blockingRecording.status, "completed");
    assert.ok(blockingRecording.outputBinaryBase64);

    const backgroundRecording = await runtime.recordAudio(leg.legId, {
      mediaExecutionMode: "background",
      recordFileFormat: "wav",
      recordOutputType: "binary",
      recordBinaryProperty: "data",
      maxDurationSeconds: 0,
    });
    assert.strictEqual(backgroundRecording.status, "started");

    const pauseResult = await runtime.controlRecording(leg.legId, "pause");
    const resumeResult = await runtime.controlRecording(leg.legId, "resume");
    assert.strictEqual(pauseResult.action, "pause");
    assert.strictEqual(resumeResult.action, "resume");
    assert.strictEqual(pauseResult.mediaId, backgroundRecording.mediaId);
    assert.strictEqual(resumeResult.mediaId, backgroundRecording.mediaId);

    const stoppedRecording = await runtime.stopMedia({
      stopMediaTarget: "mediaId",
      stopMediaId: backgroundRecording.mediaId,
      stopMediaReason: "record_stop",
    });
    assert.strictEqual(stoppedRecording.mediaId, backgroundRecording.mediaId);

    const waitedRecording = await runtime.waitMedia({
      waitMediaIds: [backgroundRecording.mediaId],
      waitMediaTimeoutSeconds: 0.1,
    });
    assert.strictEqual(waitedRecording.status, "interrupted");
    assert.strictEqual(waitedRecording.interruptReason, "record_stop");
    assert.ok(waitedRecording.outputBinaryBase64);

    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sip-pbx-record-")), "record.wav");
    const fileRecording = await runtime.recordAudio(leg.legId, {
      mediaExecutionMode: "blocking",
      recordFileFormat: "wav",
      recordOutputType: "file",
      recordFilePath: filePath,
      maxDurationSeconds: 0.05,
    });
    assert.strictEqual(fileRecording.status, "completed");
    assert.strictEqual(fileRecording.filePath, filePath);
    assert.ok(fs.existsSync(filePath));
    assertRecordingContainer("wav", fs.readFileSync(filePath));

    const compressedFormats = ["mp3", "opus", "ogg"];
    const compressedBinaryBytes = {};
    const compressedFileBytes = {};
    for (const format of compressedFormats) {
      const compressedBinaryRecording = await runtime.recordAudio(leg.legId, {
        mediaExecutionMode: "blocking",
        recordFileFormat: format,
        recordCompressedSampleRate: 16000,
        recordCompressedBitrate: 32,
        recordOutputType: "binary",
        recordBinaryProperty: "data",
        maxDurationSeconds: 0.05,
      });
      assert.strictEqual(compressedBinaryRecording.status, "completed");
      const compressedBinaryBuffer = Buffer.from(compressedBinaryRecording.outputBinaryBase64, "base64");
      assertRecordingContainer(format, compressedBinaryBuffer);
      compressedBinaryBytes[format] = compressedBinaryBuffer.length;

      const compressedPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `sip-pbx-record-${format}-`)), `record.${format}`);
      const compressedRecording = await runtime.recordAudio(leg.legId, {
        mediaExecutionMode: "blocking",
        recordFileFormat: format,
        recordCompressedSampleRate: 16000,
        recordCompressedBitrate: 32,
        recordOutputType: "file",
        recordFilePath: compressedPath,
        maxDurationSeconds: 0.05,
      });
      assert.strictEqual(compressedRecording.status, "completed");
      assert.strictEqual(compressedRecording.filePath, compressedPath);
      const compressedBuffer = fs.readFileSync(compressedPath);
      assertRecordingContainer(format, compressedBuffer);
      compressedFileBytes[format] = compressedBuffer.length;
    }

    const httpFormats = ["wav", "ogg"];
    const httpUploadedBytes = {};
    for (const format of httpFormats) {
      const httpRecording = await runtime.recordAudio(leg.legId, {
        mediaExecutionMode: "blocking",
        recordFileFormat: format,
        recordCompressedSampleRate: 16000,
        recordCompressedBitrate: 32,
        recordOutputType: "http",
        recordHttpUrl: `http://127.0.0.1:${uploadPort}/upload`,
        recordHttpMethod: "PUT",
        maxDurationSeconds: 0.05,
      });
      assert.strictEqual(httpRecording.status, "completed");
      assert.ok(uploadBodies.length > 0);
      const uploaded = uploadBodies[uploadBodies.length - 1];
      assertRecordingContainer(format, uploaded, { allowStreamingWavSizes: format === "wav" });
      httpUploadedBytes[format] = uploaded.length;
    }
    await new Promise((resolve) => uploadServer.close(resolve));

    console.log(JSON.stringify({
      ok: true,
      recording: {
        blockingStatus: blockingRecording.status,
        backgroundMediaId: backgroundRecording.mediaId,
        waitedStatus: waitedRecording.status,
        fileRecordingPath: fileRecording.filePath,
        compressedBinaryBytes,
        compressedFileBytes,
        httpUploadedBytes,
        pauseAction: pauseResult.action,
        resumeAction: resumeResult.action,
      },
    }, null, 2));
  } finally {
    await daemon.stop();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
