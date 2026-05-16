import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { normalizeHttpRequestAuthentication } from "../shared/credential-loading";
import {
  readBooleanParameter,
  readCollectionOptions,
  readFixedCollectionItems,
  readHeaderLinesFromCollectionOptions,
  readItemBinaryDataBase64,
  readNumberParameter,
  readStringParameter,
  assertDtmfString,
  requireActionValue,
} from "../shared/input-normalization";
import { resolveMediaLegId, resolveStopMediaId, resolveStopMediaLegId } from "../shared/id-resolution";

export async function executeSendDtmf(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const legId = requireActionValue("legId", resolveMediaLegId(node, item, index));
  const mediaOptions = readCollectionOptions(node, "mediaOptions", index);
  const dtmfMethod = String(mediaOptions.dtmfMethod || "").trim() || readStringParameter(node, "dtmfMethod", index, OPTION_DEFAULTS.sendDtmf.method);
  const dtmfDurationMs = Number.isFinite(Number(mediaOptions.dtmfDurationMs))
    ? Number(mediaOptions.dtmfDurationMs)
    : readNumberParameter(node, "dtmfDurationMs", index, OPTION_DEFAULTS.sendDtmf.durationMs);
  const dtmfGapMs = Number.isFinite(Number(mediaOptions.dtmfGapMs))
    ? Number(mediaOptions.dtmfGapMs)
    : readNumberParameter(node, "dtmfGapMs", index, OPTION_DEFAULTS.sendDtmf.gapMs);
  return await runtime.sendDtmf(legId, assertDtmfString("dtmfDigits", readStringParameter(node, "dtmfDigits", index, "")), {
    dtmfMethod,
    dtmfDurationMs,
    dtmfGapMs,
  });
}

export async function executePlayAudio(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const legId = requireActionValue("legId", resolveMediaLegId(node, item, index));
  const mediaOptions = readCollectionOptions(node, "mediaOptions", index);
  const sourceType = readStringParameter(node, "sourceType", index, OPTION_DEFAULTS.playAudio.sourceType);
  const binaryProperty = readStringParameter(node, "binaryProperty", index, OPTION_DEFAULTS.playAudio.binaryProperty);
  const interruptOnVoice = readBooleanParameter(node, "interruptOnVoice", index, false);
  const authentication = sourceType === "http"
    ? readStringParameter(node, "playbackHttpAuthentication", index, OPTION_DEFAULTS.playAudio.httpAuthentication)
    : OPTION_DEFAULTS.playAudio.httpAuthentication;
  const duckingFactor = Number.isFinite(Number(mediaOptions.duckingFactor))
    ? Number(mediaOptions.duckingFactor)
    : readNumberParameter(node, "duckingFactor", index, OPTION_DEFAULTS.playAudio.duckingFactor);
  const mediaExecutionMode = String(mediaOptions.mediaExecutionMode || "").trim() || readStringParameter(node, "mediaExecutionMode", index, OPTION_DEFAULTS.mediaExecution.mode);
  const input: Record<string, unknown> = {
    sourceType,
    interruptOnDtmf: readBooleanParameter(node, "interruptOnDtmf", index, false),
    interruptOnVoice,
    duckingFactor,
    mediaExecutionMode,
    stopOtherMedia: Boolean(mediaOptions.stopOtherMedia),
  };
  if (sourceType === "binary") {
    input.binaryProperty = binaryProperty;
    input.binaryDataBase64 = readItemBinaryDataBase64(item, binaryProperty);
  } else if (sourceType === "file") {
    input.filePath = readStringParameter(node, "filePath", index, "");
  } else if (sourceType === "http") {
    const playbackHttpUrl = readStringParameter(node, "playbackHttpUrl", index, "");
    const playbackHttpMethod = String(mediaOptions.playbackHttpMethod || "").trim()
      || readStringParameter(node, "playbackHttpMethod", index, OPTION_DEFAULTS.playAudio.httpMethod);
    let playbackHttpHeaders = readHeaderLinesFromCollectionOptions(mediaOptions, "playbackHttpHeaders");
    if (authentication === "predefinedCredentialType") {
      const playbackHttpCredentialName = readStringParameter(node, "playbackHttpNodeCredentialType", index, "");
      const normalizedRequest = await normalizeHttpRequestAuthentication(node, playbackHttpCredentialName, {
        method: playbackHttpMethod,
        url: playbackHttpUrl,
        headers: playbackHttpHeaders,
      });
      input.playbackHttpUrl = normalizedRequest.url;
      playbackHttpHeaders = normalizedRequest.headers;
    } else if (authentication === "genericCredentialType") {
      const playbackHttpCredentialName = readStringParameter(node, "playbackHttpGenericAuthType", index, "");
      const normalizedRequest = await normalizeHttpRequestAuthentication(node, playbackHttpCredentialName, {
        method: playbackHttpMethod,
        url: playbackHttpUrl,
        headers: playbackHttpHeaders,
      });
      input.playbackHttpUrl = normalizedRequest.url;
      playbackHttpHeaders = normalizedRequest.headers;
    } else {
      input.playbackHttpUrl = playbackHttpUrl;
    }
    input.playbackHttpMethod = playbackHttpMethod;
    input.playbackHttpHeaders = playbackHttpHeaders;
  }
  if (interruptOnVoice) {
    input.voiceThreshold = Number.isFinite(Number(mediaOptions.voiceThreshold))
      ? Number(mediaOptions.voiceThreshold)
      : readNumberParameter(node, "voiceThreshold", index, OPTION_DEFAULTS.playAudio.voiceThreshold);
    input.voiceDurationMs = Number.isFinite(Number(mediaOptions.voiceDurationMs))
      ? Number(mediaOptions.voiceDurationMs)
      : readNumberParameter(node, "voiceDurationMs", index, OPTION_DEFAULTS.playAudio.voiceDurationMs);
  }
  return await runtime.playAudio(legId, input);
}

export async function executePlayTone(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const legId = requireActionValue("legId", resolveMediaLegId(node, item, index));
  const mediaOptions = readCollectionOptions(node, "mediaOptions", index);
  const tone = readStringParameter(node, "tone", index, "");
  if (!tone) {
    throw new Error("Tone is required");
  }
  const interruptOnVoice = readBooleanParameter(node, "interruptOnVoice", index, false);
  const duckingFactor = Number.isFinite(Number(mediaOptions.duckingFactor))
    ? Number(mediaOptions.duckingFactor)
    : readNumberParameter(node, "duckingFactor", index, OPTION_DEFAULTS.playTone.duckingFactor);
  const mediaExecutionMode = String(mediaOptions.mediaExecutionMode || "").trim() || readStringParameter(node, "mediaExecutionMode", index, OPTION_DEFAULTS.mediaExecution.mode);
  const input: Record<string, unknown> = {
    tone,
    repeatInfinite: readBooleanParameter(node, "repeatInfinite", index, false),
    interruptOnDtmf: readBooleanParameter(node, "interruptOnDtmf", index, false),
    interruptOnVoice,
    duckingFactor,
    mediaExecutionMode,
    stopOtherMedia: Boolean(mediaOptions.stopOtherMedia),
  };
  if (tone === "custom") {
    input.customTone = readStringParameter(node, "customTone", index, "");
  }
  if (interruptOnVoice) {
    input.voiceThreshold = Number.isFinite(Number(mediaOptions.voiceThreshold))
      ? Number(mediaOptions.voiceThreshold)
      : readNumberParameter(node, "voiceThreshold", index, OPTION_DEFAULTS.playTone.voiceThreshold);
    input.voiceDurationMs = Number.isFinite(Number(mediaOptions.voiceDurationMs))
      ? Number(mediaOptions.voiceDurationMs)
      : readNumberParameter(node, "voiceDurationMs", index, OPTION_DEFAULTS.playTone.voiceDurationMs);
  }
  return await runtime.playTone(legId, input);
}

export async function executeRecordAudio(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const legId = requireActionValue("legId", resolveMediaLegId(node, item, index));
  const mediaOptions = readCollectionOptions(node, "mediaOptions", index);
  const recordFileFormat = readStringParameter(node, "recordFileFormat", index, OPTION_DEFAULTS.recordAudio.fileFormat);
  const recordOutputType = readStringParameter(node, "recordOutputType", index, OPTION_DEFAULTS.recordAudio.outputType);
  const interruptOnSilence = readBooleanParameter(node, "interruptOnSilence", index, false);
  const authentication = recordOutputType === "http"
    ? readStringParameter(node, "recordHttpAuthentication", index, OPTION_DEFAULTS.recordAudio.httpAuthentication)
    : OPTION_DEFAULTS.recordAudio.httpAuthentication;
  const mediaExecutionMode = String(mediaOptions.mediaExecutionMode || "").trim() || readStringParameter(node, "mediaExecutionMode", index, OPTION_DEFAULTS.mediaExecution.mode);
  const input: Record<string, unknown> = {
    interruptOnDtmf: readBooleanParameter(node, "interruptOnDtmf", index, false),
    interruptOnSilence,
    maxDurationSeconds: readNumberParameter(node, "maxDurationSeconds", index, OPTION_DEFAULTS.recordAudio.maxDurationSeconds),
    recordFileFormat,
    recordOutputType,
    mediaExecutionMode,
    stopOtherMedia: Boolean(mediaOptions.stopOtherMedia),
  };
  if (interruptOnSilence) {
    input.silenceThreshold = Number.isFinite(Number(mediaOptions.silenceThreshold))
      ? Number(mediaOptions.silenceThreshold)
      : readNumberParameter(node, "silenceThreshold", index, OPTION_DEFAULTS.recordAudio.silenceThreshold);
    input.silenceDurationMs = Number.isFinite(Number(mediaOptions.silenceDurationMs))
      ? Number(mediaOptions.silenceDurationMs)
      : readNumberParameter(node, "silenceDurationMs", index, OPTION_DEFAULTS.recordAudio.silenceDurationMs);
  }
  if (recordFileFormat === "wav") {
    input.recordWavSampleRate = Number.isFinite(Number(mediaOptions.recordWavSampleRate))
      ? Number(mediaOptions.recordWavSampleRate)
      : readNumberParameter(node, "recordWavSampleRate", index, OPTION_DEFAULTS.recordAudio.wavSampleRate);
    input.recordWavBitDepth = Number.isFinite(Number(mediaOptions.recordWavBitDepth))
      ? Number(mediaOptions.recordWavBitDepth)
      : readNumberParameter(node, "recordWavBitDepth", index, OPTION_DEFAULTS.recordAudio.wavBitDepth);
  } else {
    input.recordCompressedSampleRate = Number.isFinite(Number(mediaOptions.recordCompressedSampleRate))
      ? Number(mediaOptions.recordCompressedSampleRate)
      : readNumberParameter(node, "recordCompressedSampleRate", index, OPTION_DEFAULTS.recordAudio.compressedSampleRate);
    input.recordCompressedBitrate = Number.isFinite(Number(mediaOptions.recordCompressedBitrate))
      ? Number(mediaOptions.recordCompressedBitrate)
      : readNumberParameter(node, "recordCompressedBitrate", index, OPTION_DEFAULTS.recordAudio.compressedBitrateKbps);
  }
  if (recordOutputType === "binary") {
    input.recordBinaryProperty = readStringParameter(node, "recordBinaryProperty", index, OPTION_DEFAULTS.recordAudio.binaryProperty);
  } else if (recordOutputType === "file") {
    input.recordFilePath = readStringParameter(node, "recordFilePath", index, "");
  } else if (recordOutputType === "http") {
    const recordHttpUrl = readStringParameter(node, "recordHttpUrl", index, "");
    const recordHttpMethod = String(mediaOptions.recordHttpMethod || "").trim()
      || readStringParameter(node, "recordHttpMethod", index, OPTION_DEFAULTS.recordAudio.httpMethod);
    let recordHttpHeaders = readHeaderLinesFromCollectionOptions(mediaOptions, "recordHttpHeaders");
    if (authentication === "predefinedCredentialType") {
      const recordHttpCredentialName = readStringParameter(node, "recordHttpNodeCredentialType", index, "");
      const normalizedRequest = await normalizeHttpRequestAuthentication(node, recordHttpCredentialName, {
        method: recordHttpMethod,
        url: recordHttpUrl,
        headers: recordHttpHeaders,
      });
      input.recordHttpUrl = normalizedRequest.url;
      recordHttpHeaders = normalizedRequest.headers;
    } else if (authentication === "genericCredentialType") {
      const recordHttpCredentialName = readStringParameter(node, "recordHttpGenericAuthType", index, "");
      const normalizedRequest = await normalizeHttpRequestAuthentication(node, recordHttpCredentialName, {
        method: recordHttpMethod,
        url: recordHttpUrl,
        headers: recordHttpHeaders,
      });
      input.recordHttpUrl = normalizedRequest.url;
      recordHttpHeaders = normalizedRequest.headers;
    } else {
      input.recordHttpUrl = recordHttpUrl;
    }
    input.recordHttpMethod = recordHttpMethod;
    input.recordHttpHeaders = recordHttpHeaders;
  }
  return await runtime.recordAudio(legId, input);
}

export async function executeStopMedia(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const stopMediaTarget = readStringParameter(node, "stopMediaTarget", index, OPTION_DEFAULTS.stopMedia.target);
  const mediaOptions = readCollectionOptions(node, "mediaOptions", index);
  const input: Record<string, unknown> = {
    stopMediaTarget,
    stopMediaReason: String(mediaOptions.stopMediaReason || "").trim() || readStringParameter(node, "stopMediaReason", index, OPTION_DEFAULTS.stopMedia.reason),
  };
  if (stopMediaTarget === "mediaId") {
    input.stopMediaId = resolveStopMediaId(node, item, index);
  } else {
    input.stopMediaLegId = resolveStopMediaLegId(node, item, index);
  }
  return await runtime.stopMedia(input);
}

export async function executeWaitMedia(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const waitMediaIds = readFixedCollectionItems(node, "waitMediaIds", index)
    .map((entry) => String(entry.mediaId || "").trim())
    .filter(Boolean);
  const fallbackMediaId = String((item?.json && (item.json.mediaId || item.json.sipPbx?.mediaId)) || "").trim();
  return await runtime.waitMedia({
    waitMediaIds: waitMediaIds.length > 0 ? waitMediaIds : (fallbackMediaId ? [fallbackMediaId] : []),
    waitMediaTimeoutSeconds: readNumberParameter(node, "waitMediaTimeoutSeconds", index, OPTION_DEFAULTS.waitMedia.timeoutSeconds),
  });
}
