import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { normalizeHttpRequestAuthentication } from "../shared/credential-loading";
import {
  hasInterruptSelection,
  readBooleanParameter,
  readFixedCollectionItems,
  readHeaderLinesFromCollectionOptions,
  readInterruptSelections,
  readItemBinaryDataBase64,
  readNumberParameter,
  readOptions,
  readStringParameter,
  assertDtmfString,
  requireActionValue,
} from "../shared/input-normalization";
import {
  INTERRUPT_SELECTION_DTMF,
  INTERRUPT_SELECTION_SILENCE,
  INTERRUPT_SELECTION_VOICE,
} from "../../shared/interrupt-selections";
import { resolveMediaLegId, resolveStopMediaId, resolveStopMediaLegId } from "../shared/id-resolution";

export async function executeSendDtmf(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const legId = requireActionValue("legId", resolveMediaLegId(node, item, index));
  const options = readOptions(node, index);
  const dtmfMethod = String(options.dtmfMethod || "").trim() || readStringParameter(node, "dtmfMethod", index, OPTION_DEFAULTS.sendDtmf.method);
  const dtmfDurationMs = Number.isFinite(Number(options.dtmfDurationMs))
    ? Number(options.dtmfDurationMs)
    : readNumberParameter(node, "dtmfDurationMs", index, OPTION_DEFAULTS.sendDtmf.durationMs);
  const dtmfGapMs = Number.isFinite(Number(options.dtmfGapMs))
    ? Number(options.dtmfGapMs)
    : readNumberParameter(node, "dtmfGapMs", index, OPTION_DEFAULTS.sendDtmf.gapMs);
  return await runtime.sendDtmf(legId, assertDtmfString("dtmfDigits", readStringParameter(node, "dtmfDigits", index, OPTION_DEFAULTS.common.string)), {
    dtmfMethod,
    dtmfDurationMs,
    dtmfGapMs,
  });
}

export async function executePlayAudio(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const legId = requireActionValue("legId", resolveMediaLegId(node, item, index));
  const options = readOptions(node, index);
  const sourceType = readStringParameter(node, "sourceType", index, OPTION_DEFAULTS.playAudio.sourceType);
  const binaryProperty = readStringParameter(node, "binaryProperty", index, OPTION_DEFAULTS.playAudio.binaryProperty);
  const interruptOn = readInterruptSelections(node, "interruptOn", index, [
    INTERRUPT_SELECTION_DTMF,
    INTERRUPT_SELECTION_VOICE,
  ]);
  const interruptOnDtmf = hasInterruptSelection(interruptOn, INTERRUPT_SELECTION_DTMF);
  const interruptOnVoice = hasInterruptSelection(interruptOn, INTERRUPT_SELECTION_VOICE);
  const authentication = sourceType === "http"
    ? readStringParameter(node, "playbackHttpAuthentication", index, OPTION_DEFAULTS.playAudio.httpAuthentication)
    : OPTION_DEFAULTS.playAudio.httpAuthentication;
  const duckingFactor = Number.isFinite(Number(options.duckingFactor))
    ? Number(options.duckingFactor)
    : readNumberParameter(node, "duckingFactor", index, OPTION_DEFAULTS.playAudio.duckingFactor);
  const mediaExecutionMode = String(options.mediaExecutionMode || "").trim() || readStringParameter(node, "mediaExecutionMode", index, OPTION_DEFAULTS.mediaExecution.mode);
  const input: Record<string, unknown> = {
    sourceType,
    interruptOnDtmf,
    interruptOnVoice,
    duckingFactor,
    mediaExecutionMode,
    stopOtherMedia: options.stopOtherMedia == null
      ? OPTION_DEFAULTS.mediaExecution.stopOtherMedia
      : Boolean(options.stopOtherMedia),
  };
  if (sourceType === "binary") {
    input.binaryProperty = binaryProperty;
    input.binaryDataBase64 = readItemBinaryDataBase64(item, binaryProperty);
  } else if (sourceType === "file") {
    input.filePath = readStringParameter(node, "filePath", index, OPTION_DEFAULTS.common.string);
  } else if (sourceType === "http") {
    const playbackHttpUrl = readStringParameter(node, "playbackHttpUrl", index, OPTION_DEFAULTS.common.string);
    const playbackHttpMethod = String(options.playbackHttpMethod || "").trim()
      || readStringParameter(node, "playbackHttpMethod", index, OPTION_DEFAULTS.playAudio.httpMethod);
    let playbackHttpHeaders = readHeaderLinesFromCollectionOptions(options, "playbackHttpHeaders");
    if (authentication === "predefinedCredentialType") {
      const playbackHttpCredentialName = readStringParameter(node, "playbackHttpNodeCredentialType", index, OPTION_DEFAULTS.common.string);
      const normalizedRequest = await normalizeHttpRequestAuthentication(node, playbackHttpCredentialName, {
        method: playbackHttpMethod,
        url: playbackHttpUrl,
        headers: playbackHttpHeaders,
      });
      input.playbackHttpUrl = normalizedRequest.url;
      playbackHttpHeaders = normalizedRequest.headers;
    } else if (authentication === "genericCredentialType") {
      const playbackHttpCredentialName = readStringParameter(node, "playbackHttpGenericAuthType", index, OPTION_DEFAULTS.common.string);
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
    input.voiceThreshold = Number.isFinite(Number(options.voiceThreshold))
      ? Number(options.voiceThreshold)
      : readNumberParameter(node, "voiceThreshold", index, OPTION_DEFAULTS.playAudio.voiceThreshold);
    input.voiceDurationMs = Number.isFinite(Number(options.voiceDurationMs))
      ? Number(options.voiceDurationMs)
      : readNumberParameter(node, "voiceDurationMs", index, OPTION_DEFAULTS.playAudio.voiceDurationMs);
  }
  return await runtime.playAudio(legId, input);
}

export async function executePlayTone(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const legId = requireActionValue("legId", resolveMediaLegId(node, item, index));
  const options = readOptions(node, index);
  const tone = readStringParameter(node, "tone", index, OPTION_DEFAULTS.playTone.tone);
  if (!tone) {
    throw new Error("Tone is required");
  }
  const interruptOn = readInterruptSelections(node, "interruptOn", index, [
    INTERRUPT_SELECTION_DTMF,
    INTERRUPT_SELECTION_VOICE,
  ]);
  const interruptOnDtmf = hasInterruptSelection(interruptOn, INTERRUPT_SELECTION_DTMF);
  const interruptOnVoice = hasInterruptSelection(interruptOn, INTERRUPT_SELECTION_VOICE);
  const duckingFactor = Number.isFinite(Number(options.duckingFactor))
    ? Number(options.duckingFactor)
    : readNumberParameter(node, "duckingFactor", index, OPTION_DEFAULTS.playTone.duckingFactor);
  const mediaExecutionMode = String(options.mediaExecutionMode || "").trim() || readStringParameter(node, "mediaExecutionMode", index, OPTION_DEFAULTS.mediaExecution.mode);
  const input: Record<string, unknown> = {
    tone,
    repeatInfinite: readBooleanParameter(node, "repeatInfinite", index, OPTION_DEFAULTS.playTone.repeatInfinite),
    interruptOnDtmf,
    interruptOnVoice,
    duckingFactor,
    mediaExecutionMode,
    stopOtherMedia: options.stopOtherMedia == null
      ? OPTION_DEFAULTS.mediaExecution.stopOtherMedia
      : Boolean(options.stopOtherMedia),
  };
  if (tone === "custom") {
    input.customTone = readStringParameter(node, "customTone", index, OPTION_DEFAULTS.common.string);
  }
  if (interruptOnVoice) {
    input.voiceThreshold = Number.isFinite(Number(options.voiceThreshold))
      ? Number(options.voiceThreshold)
      : readNumberParameter(node, "voiceThreshold", index, OPTION_DEFAULTS.playTone.voiceThreshold);
    input.voiceDurationMs = Number.isFinite(Number(options.voiceDurationMs))
      ? Number(options.voiceDurationMs)
      : readNumberParameter(node, "voiceDurationMs", index, OPTION_DEFAULTS.playTone.voiceDurationMs);
  }
  return await runtime.playTone(legId, input);
}

export async function executeRecordAudio(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const legId = requireActionValue("legId", resolveMediaLegId(node, item, index));
  const options = readOptions(node, index);
  const recordFileFormat = readStringParameter(node, "recordFileFormat", index, OPTION_DEFAULTS.recordAudio.fileFormat);
  const recordOutputType = readStringParameter(node, "recordOutputType", index, OPTION_DEFAULTS.recordAudio.outputType);
  const interruptOn = readInterruptSelections(node, "interruptOn", index, [
    INTERRUPT_SELECTION_DTMF,
    INTERRUPT_SELECTION_SILENCE,
  ]);
  const interruptOnDtmf = hasInterruptSelection(interruptOn, INTERRUPT_SELECTION_DTMF);
  const interruptOnSilence = hasInterruptSelection(interruptOn, INTERRUPT_SELECTION_SILENCE);
  const authentication = recordOutputType === "http"
    ? readStringParameter(node, "recordHttpAuthentication", index, OPTION_DEFAULTS.recordAudio.httpAuthentication)
    : OPTION_DEFAULTS.recordAudio.httpAuthentication;
  const mediaExecutionMode = String(options.mediaExecutionMode || "").trim() || readStringParameter(node, "mediaExecutionMode", index, OPTION_DEFAULTS.mediaExecution.mode);
  const input: Record<string, unknown> = {
    interruptOnDtmf,
    interruptOnSilence,
    maxDurationSeconds: readNumberParameter(node, "maxDurationSeconds", index, OPTION_DEFAULTS.recordAudio.maxDurationSeconds),
    recordFileFormat,
    recordOutputType,
    mediaExecutionMode,
    stopOtherMedia: options.stopOtherMedia == null
      ? OPTION_DEFAULTS.mediaExecution.stopOtherMedia
      : Boolean(options.stopOtherMedia),
  };
  if (interruptOnSilence) {
    input.silenceThreshold = Number.isFinite(Number(options.silenceThreshold))
      ? Number(options.silenceThreshold)
      : readNumberParameter(node, "silenceThreshold", index, OPTION_DEFAULTS.recordAudio.silenceThreshold);
    input.silenceDurationMs = Number.isFinite(Number(options.silenceDurationMs))
      ? Number(options.silenceDurationMs)
      : readNumberParameter(node, "silenceDurationMs", index, OPTION_DEFAULTS.recordAudio.silenceDurationMs);
  }
  if (recordFileFormat === "wav") {
    input.recordWavSampleRate = Number.isFinite(Number(options.recordWavSampleRate))
      ? Number(options.recordWavSampleRate)
      : readNumberParameter(node, "recordWavSampleRate", index, OPTION_DEFAULTS.recordAudio.wavSampleRate);
    input.recordWavBitDepth = Number.isFinite(Number(options.recordWavBitDepth))
      ? Number(options.recordWavBitDepth)
      : readNumberParameter(node, "recordWavBitDepth", index, OPTION_DEFAULTS.recordAudio.wavBitDepth);
  } else {
    input.recordCompressedSampleRate = Number.isFinite(Number(options.recordCompressedSampleRate))
      ? Number(options.recordCompressedSampleRate)
      : readNumberParameter(node, "recordCompressedSampleRate", index, OPTION_DEFAULTS.recordAudio.compressedSampleRate);
    input.recordCompressedBitrate = Number.isFinite(Number(options.recordCompressedBitrate))
      ? Number(options.recordCompressedBitrate)
      : readNumberParameter(node, "recordCompressedBitrate", index, OPTION_DEFAULTS.recordAudio.compressedBitrateKbps);
  }
  if (recordOutputType === "binary") {
    input.recordBinaryProperty = readStringParameter(node, "recordBinaryProperty", index, OPTION_DEFAULTS.recordAudio.binaryProperty);
  } else if (recordOutputType === "file") {
    input.recordFilePath = readStringParameter(node, "recordFilePath", index, OPTION_DEFAULTS.common.string);
  } else if (recordOutputType === "http") {
    const recordHttpUrl = readStringParameter(node, "recordHttpUrl", index, OPTION_DEFAULTS.common.string);
    const recordHttpMethod = String(options.recordHttpMethod || "").trim()
      || readStringParameter(node, "recordHttpMethod", index, OPTION_DEFAULTS.recordAudio.httpMethod);
    let recordHttpHeaders = readHeaderLinesFromCollectionOptions(options, "recordHttpHeaders");
    if (authentication === "predefinedCredentialType") {
      const recordHttpCredentialName = readStringParameter(node, "recordHttpNodeCredentialType", index, OPTION_DEFAULTS.common.string);
      const normalizedRequest = await normalizeHttpRequestAuthentication(node, recordHttpCredentialName, {
        method: recordHttpMethod,
        url: recordHttpUrl,
        headers: recordHttpHeaders,
      });
      input.recordHttpUrl = normalizedRequest.url;
      recordHttpHeaders = normalizedRequest.headers;
    } else if (authentication === "genericCredentialType") {
      const recordHttpCredentialName = readStringParameter(node, "recordHttpGenericAuthType", index, OPTION_DEFAULTS.common.string);
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
  const input: Record<string, unknown> = {
    stopMediaTarget,
  };
  if (stopMediaTarget === "mediaId") {
    input.mediaId = resolveStopMediaId(node, item, index);
  } else {
    input.legId = resolveStopMediaLegId(node, item, index);
  }
  return await runtime.stopMedia(input);
}

export async function executeWaitMedia(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const mediaIds = readFixedCollectionItems(node, "mediaIds", index)
    .map((entry) => String(entry.mediaId || "").trim())
    .filter(Boolean);
  const fallbackMediaId = String((item?.json && (item.json.mediaId || item.json.sipPbx?.mediaId)) || "").trim();
  return await runtime.waitMedia({
    mediaIds: mediaIds.length > 0 ? mediaIds : (fallbackMediaId ? [fallbackMediaId] : []),
    waitMediaTimeoutSeconds: readNumberParameter(node, "waitMediaTimeoutSeconds", index, OPTION_DEFAULTS.waitMedia.timeoutSeconds),
  });
}
