import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { readBooleanParameter, readNumberParameter, readOptions, readStringParameter, requireActionValue } from "../shared/input-normalization";
import { resolveAiToolRequestId, resolveAuthRequestId, resolveRecordRequestId } from "../shared/id-resolution";

export function buildGlobalRecordingActionInput(
  node: any,
  index: number,
  includeActive = true,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (includeActive) {
    const active = readBooleanParameter(node, "active", index, OPTION_DEFAULTS.globalRecording.active);
    input.active = active;
    if (!active) {
      return input;
    }
  }
  const options = readOptions(node, index);
  const recordFilePath = requireActionValue("recordFilePath", readStringParameter(node, "recordFilePath", index, OPTION_DEFAULTS.common.string));
  const recordFileFormat = readStringParameter(node, "recordFileFormat", index, OPTION_DEFAULTS.globalRecording.fileFormat);
  input.recordFilePath = recordFilePath;
  input.recordFileFormat = recordFileFormat;
  if (recordFileFormat === "wav") {
    input.recordWavSampleRate = Number.isFinite(Number(options.recordWavSampleRate))
      ? Number(options.recordWavSampleRate)
      : readNumberParameter(node, "recordWavSampleRate", index, OPTION_DEFAULTS.globalRecording.wavSampleRate);
    input.recordWavBitDepth = Number.isFinite(Number(options.recordWavBitDepth))
      ? Number(options.recordWavBitDepth)
      : readNumberParameter(node, "recordWavBitDepth", index, OPTION_DEFAULTS.globalRecording.wavBitDepth);
  } else {
    input.recordCompressedSampleRate = Number.isFinite(Number(options.recordCompressedSampleRate))
      ? Number(options.recordCompressedSampleRate)
      : readNumberParameter(node, "recordCompressedSampleRate", index, OPTION_DEFAULTS.globalRecording.compressedSampleRate);
    input.recordCompressedBitrate = Number.isFinite(Number(options.recordCompressedBitrate))
      ? Number(options.recordCompressedBitrate)
      : readNumberParameter(node, "recordCompressedBitrate", index, OPTION_DEFAULTS.globalRecording.compressedBitrateKbps);
  }
  input.recordSplitChannels = Boolean(readBooleanParameter(node, "recordSplitChannels", index, OPTION_DEFAULTS.globalRecording.splitChannels));
  input.waitForRecordingCompletion = Boolean(readBooleanParameter(node, "waitForRecordingCompletion", index, OPTION_DEFAULTS.globalRecording.waitForCompletion));
  return input;
}

export async function executeRespondToRecord(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const recordRequestId = requireActionValue("recordRequestId", resolveRecordRequestId(node, item, index));
  const input: Record<string, unknown> = {
    recordRequestId,
    ...buildGlobalRecordingActionInput(node, index, true),
  };
  return await runtime.respondToRecord(input);
}

export async function executeRespondToAuth(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  return await runtime.respondToAuth({
    authRequestId: requireActionValue("authRequestId", resolveAuthRequestId(node, item, index)),
    authAction: readStringParameter(node, "authAction", index, OPTION_DEFAULTS.extensionsAction.authAction),
    password: readStringParameter(node, "password", index, OPTION_DEFAULTS.common.string),
    extension: readStringParameter(node, "extension", index, OPTION_DEFAULTS.common.string),
    statusCode: readNumberParameter(node, "statusCode", index, OPTION_DEFAULTS.extensionsAction.statusCode),
    reason: readStringParameter(node, "reason", index, OPTION_DEFAULTS.common.string),
  });
}

export async function executeRespondToAiTool(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  return await runtime.respondToAiTool({
    aiToolRequestId: requireActionValue("aiToolRequestId", resolveAiToolRequestId(node, item, index)),
    outputText: requireActionValue("outputText", readStringParameter(node, "outputText", index, OPTION_DEFAULTS.common.string)),
  });
}
