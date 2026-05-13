import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { readBooleanParameter, readCollectionOptions, readNumberParameter, readStringParameter, requireActionValue } from "../shared/input-normalization";
import { resolveAiToolRequestId, resolveAuthRequestId, resolveRecordRequestId } from "../shared/id-resolution";

export async function executeRespondToRecord(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const recordRequestId = requireActionValue("recordRequestId", resolveRecordRequestId(node, item, index));
  const active = readBooleanParameter(node, "active", index, true);
  const respondOptions = readCollectionOptions(node, "respondOptions", index);
  const input: Record<string, unknown> = {
    recordRequestId,
    active,
  };
  if (active) {
    const recordFilePath = requireActionValue("recordFilePath", readStringParameter(node, "recordFilePath", index, ""));
    const recordFileFormat = readStringParameter(node, "recordFileFormat", index, OPTION_DEFAULTS.recordAudio.fileFormat);
    input.recordFilePath = recordFilePath;
    input.recordFileFormat = recordFileFormat;
    if (recordFileFormat === "wav") {
      input.recordWavSampleRate = Number.isFinite(Number(respondOptions.recordWavSampleRate))
        ? Number(respondOptions.recordWavSampleRate)
        : readNumberParameter(node, "recordWavSampleRate", index, OPTION_DEFAULTS.recordAudio.wavSampleRate);
      input.recordWavBitDepth = Number.isFinite(Number(respondOptions.recordWavBitDepth))
        ? Number(respondOptions.recordWavBitDepth)
        : readNumberParameter(node, "recordWavBitDepth", index, OPTION_DEFAULTS.recordAudio.wavBitDepth);
    } else {
      input.recordCompressedSampleRate = Number.isFinite(Number(respondOptions.recordCompressedSampleRate))
        ? Number(respondOptions.recordCompressedSampleRate)
        : readNumberParameter(node, "recordCompressedSampleRate", index, OPTION_DEFAULTS.recordAudio.compressedSampleRate);
      input.recordCompressedBitrate = Number.isFinite(Number(respondOptions.recordCompressedBitrate))
        ? Number(respondOptions.recordCompressedBitrate)
        : readNumberParameter(node, "recordCompressedBitrate", index, OPTION_DEFAULTS.recordAudio.compressedBitrateKbps);
    }
    input.recordSplitChannels = Boolean(readBooleanParameter(node, "recordSplitChannels", index, OPTION_DEFAULTS.autoRecording.splitChannels));
    input.waitForRecordingCompletion = Boolean(readBooleanParameter(node, "waitForRecordingCompletion", index, OPTION_DEFAULTS.autoRecording.waitForCompletion));
  }
  return await runtime.respondToRecord(input);
}

export async function executeRespondToAuth(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  return await runtime.respondToAuth({
    authRequestId: requireActionValue("authRequestId", resolveAuthRequestId(node, item, index)),
    authAction: readStringParameter(node, "authAction", index, OPTION_DEFAULTS.extensionsAction.authAction),
    password: readStringParameter(node, "password", index, ""),
    extension: readStringParameter(node, "extension", index, ""),
    statusCode: readNumberParameter(node, "statusCode", index, OPTION_DEFAULTS.extensionsAction.statusCode),
    reason: readStringParameter(node, "reason", index, ""),
  });
}

export async function executeRespondToAiTool(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  return await runtime.respondToAiTool({
    aiToolRequestId: requireActionValue("aiToolRequestId", resolveAiToolRequestId(node, item, index)),
    outputText: requireActionValue("outputText", readStringParameter(node, "outputText", index, "")),
  });
}
