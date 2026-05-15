import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { normalizeStringList } from "../../shared/string-utils";
import {
  buildCallWaitStaticTail,
  DialMakeBranches,
  buildDialWaitBranchOrder,
  CallWaitBranchDtmfFallback,
  CallWaitBranchEnded,
  CallWaitBranchInterrupt,
  CallWaitBranchTimeout,
  DialWaitBranchAnswered,
  DialWaitBranchFailed,
  DialWaitBranchProgress,
  DialWaitBranchRejected,
  DialWaitBranchRinging,
  DialWaitBranchTimeout,
  requireBranchIndex,
  WaitMediaBranchCompleted,
  WaitMediaBranchInterrupted,
  WaitMediaBranches,
  WaitMediaBranchTimeout,
} from "../../shared/branches";
import {
  CALL_EVENT_DTMF,
  CALL_EVENT_ENDED,
  CALL_EVENT_INTERRUPT,
  CALL_EVENT_TIMEOUT,
  CALL_WAIT_OUTPUT_DTMF_FALLBACK,
  CALL_WAIT_OUTPUT_ENDED,
  CALL_WAIT_OUTPUT_INTERRUPT,
  CALL_WAIT_OUTPUT_MATCHED,
  DIAL_EVENT_ANSWERED,
  DIAL_EVENT_PROGRESS,
  DIAL_EVENT_REJECTED,
  DIAL_EVENT_RINGING,
  DIAL_EVENT_TIMEOUT,
  DIAL_WAIT_SELECTION_PROGRESS,
  DIAL_WAIT_SELECTION_REJECTED,
  DIAL_WAIT_SELECTION_RINGING,
  MEDIA_EVENT_COMPLETED,
  MEDIA_EVENT_FAILED,
  MEDIA_EVENT_INTERRUPTED,
  MEDIA_EVENT_TIMEOUT,
} from "../../shared/result-events";
import {
  assertUniqueRuleLabels,
  getInputItems,
  normalizeDtmfRules,
  readBooleanParameter,
  readCollectionOptions,
  readNodeParameter,
} from "../shared/input-normalization";
import {
  resolveAuthRequestId,
  resolveAiToolRequestId,
  resolveDialId,
  resolveLegId,
  resolveMediaLegId,
  resolveRecordRequestId,
} from "../shared/id-resolution";
import { buildNodeItem } from "../shared/output-builders";
import {
  executeAnswer,
  executeBridge,
  executeControlRecording,
  executeHangup,
  executeRing,
  executeUnbridge,
  executeWaitLegEvent,
  resolveWaitLegIds,
} from "./call-actions";
import { executeAttachVoiceAgent } from "./ai-actions";
import { executeBreakDial, executeMakeCall, executeWaitDial, resolveWaitDialIds } from "./dial-actions";
import {
  executePlayAudio,
  executePlayTone,
  executeRecordAudio,
  executeSendDtmf,
  executeStopMedia,
  executeWaitMedia,
} from "./media-actions";
import {
  executeEnqueueLeg,
  executeGetQueueStats,
  executeSetQueueCallback,
} from "./queue-actions";
import {
  executeRespondToAiTool,
  executeRespondToAuth,
  executeRespondToRecord,
} from "./respond-actions";
import { executeStartGlobalRecording } from "./recording-actions";
import { requireActionValue } from "../shared/input-normalization";
import type { PbxMetadata } from "../shared/pbx-payload-context";

type OutputMatrix = any[][];

type CallWaitPlan = {
  rules: Array<{ pattern: string; label: string }>;
  dtmfFallbackIndex: number | null;
  interruptIndex: number;
  endedIndex: number;
  timeoutIndex: number;
  branchIndexByLabel: Map<string, number>;
  branchCount: number;
};

type DialWaitPlan = {
  selectedOutputs: string[];
  ringingIndex: number | null;
  progressIndex: number | null;
  answeredIndex: number;
  rejectedIndex: number | null;
  failedIndex: number;
  timeoutIndex: number;
  branchCount: number;
};

type MediaPlan = {
  operation: string;
  background: boolean;
  infiniteTone: boolean;
  branchCount: number;
};

type ExecutionPlan = {
  branchCount: number;
  callWaitPlan: CallWaitPlan | null;
  dialWaitPlan: DialWaitPlan | null;
  mediaPlan: MediaPlan | null;
};

type NodeEmission = {
  branchIndex: number;
  item: any;
};

type ItemExecutionContext = {
  node: any;
  runtime: PbxRuntime;
  item: any;
  index: number;
  operation: string;
  plan: ExecutionPlan;
};

function readOperation(node: any, index: number): string {
  const operation = String(readNodeParameter(node, "operation", index, "") || "").trim();
  if (operation) {
    return operation;
  }
  throw new Error("Operation is required");
}

function resolvePlanGroup(operation: string): "call" | "dial" | "ai" | "media" | "respond" | "queue" | "recording" {
  switch (operation) {
    case "call.ringing":
    case "call.answer":
    case "call.hangup":
    case "call.bridge":
    case "call.unbridge":
    case "call.wait":
      return "call";
    case "ai.invokeAiTool":
    case "ai.attachVoiceAgent":
      return "ai";
    case "dial.make":
    case "dial.break":
    case "dial.wait":
      return "dial";
    case "media.playAudio":
    case "media.playTone":
    case "media.recordAudio":
    case "media.stopMedia":
    case "media.wait":
    case "media.sendDtmf":
      return "media";
    case "respond.toRecord":
    case "respond.toAuth":
    case "respond.toAiTool":
      return "respond";
    case "queue.putLeg":
    case "queue.setCallback":
    case "queue.getStats":
      return "queue";
    case "recording.control":
    case "recording.start":
      return "recording";
    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }
}

function resolveExecutionGroup(context: ItemExecutionContext): "call" | "dial" | "ai" | "media" | "respond" | "queue" | "recording" {
  return resolvePlanGroup(context.operation);
}

function createOutputMatrix(size: number): OutputMatrix {
  return Array.from({ length: Math.max(1, size) }, () => []);
}

function pushOutput(outputs: OutputMatrix, branchIndex: number, item: any): void {
  while (outputs.length <= branchIndex) {
    outputs.push([]);
  }
  outputs[branchIndex].push(item);
}

function emit(branchIndex: number, item: any): NodeEmission[] {
  return [{ branchIndex, item }];
}

function emitMany(...emissions: NodeEmission[]): NodeEmission[] {
  return emissions;
}

function buildOutputItem(
  sourceItem: any,
  payload: Record<string, unknown>,
  metadata?: PbxMetadata,
): any {
  return buildNodeItem(sourceItem, payload, metadata);
}

function resultString(result: Record<string, unknown>, key: string, fallback = ""): string {
  return String(result[key] || fallback).trim();
}

function resultNumber(result: Record<string, unknown>, key: string, fallback = 0): number {
  return Number(result[key] || fallback);
}

function resultDefined(result: Record<string, unknown>, key: string): boolean {
  return result[key] != null;
}

function normalizeWaitEventOutputs(node: any, index: number): string[] {
  const raw = readNodeParameter(node, "waitEventOutputs", index, [...OPTION_DEFAULTS.dial.waitEventOutputs]);
  return Array.isArray(raw) ? normalizeStringList(raw) : [];
}

function isExtensionNoAvailableEndpointsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = String((error as { code?: unknown }).code || "").trim();
  const message = String((error as { message?: unknown }).message || "").trim();
  return (code === "" || code === "invalid_dial_targets") && message === "Extension dial requires active registrations";
}

function createCallWaitPlan(node: any, index: number): CallWaitPlan {
  const rules = normalizeDtmfRules(node, index);
  assertUniqueRuleLabels(rules);
  const dtmfFallbackEnabled = readBooleanParameter(node, "waitDtmfFallbackEnabled", index, false);
  const branchIndexByLabel = new Map<string, number>();
  for (let i = 0; i < rules.length; i += 1) {
    branchIndexByLabel.set(rules[i]!.label, i);
  }
  const tail = buildCallWaitStaticTail(dtmfFallbackEnabled);
  const tailOffset = rules.length;
  const dtmfFallbackIndex = dtmfFallbackEnabled
    ? tailOffset + requireBranchIndex(tail, CallWaitBranchDtmfFallback)
    : null;
  const interruptIndex = tailOffset + requireBranchIndex(tail, CallWaitBranchInterrupt);
  const endedIndex = tailOffset + requireBranchIndex(tail, CallWaitBranchEnded);
  const timeoutIndex = tailOffset + requireBranchIndex(tail, CallWaitBranchTimeout);
  return {
    rules,
    dtmfFallbackIndex,
    interruptIndex,
    endedIndex,
    timeoutIndex,
    branchIndexByLabel,
    branchCount: tailOffset + tail.length,
  };
}

function createDialWaitPlan(node: any, index: number): DialWaitPlan {
  const selectedOutputs = normalizeWaitEventOutputs(node, index);
  const includeRinging = selectedOutputs.includes(DIAL_WAIT_SELECTION_RINGING);
  const includeProgress = selectedOutputs.includes(DIAL_WAIT_SELECTION_PROGRESS);
  const includeRejected = selectedOutputs.includes(DIAL_WAIT_SELECTION_REJECTED);
  const order = buildDialWaitBranchOrder({ includeRinging, includeProgress, includeRejected });
  return {
    selectedOutputs,
    ringingIndex: includeRinging ? requireBranchIndex(order, DialWaitBranchRinging) : null,
    progressIndex: includeProgress ? requireBranchIndex(order, DialWaitBranchProgress) : null,
    answeredIndex: requireBranchIndex(order, DialWaitBranchAnswered),
    rejectedIndex: includeRejected ? requireBranchIndex(order, DialWaitBranchRejected) : null,
    failedIndex: requireBranchIndex(order, DialWaitBranchFailed),
    timeoutIndex: requireBranchIndex(order, DialWaitBranchTimeout),
    branchCount: order.length,
  };
}

function createMediaPlan(node: any, index: number, operation: string): MediaPlan {
  const mediaOptions = readCollectionOptions(node, "mediaOptions", index);
  const mediaExecutionMode = String(mediaOptions.mediaExecutionMode || "").trim()
    || String(readNodeParameter(node, "mediaExecutionMode", index, OPTION_DEFAULTS.mediaExecution.mode) || "").trim()
    || OPTION_DEFAULTS.mediaExecution.mode;
  const background = mediaExecutionMode === "background";
  const infiniteTone = operation === "media.playTone" && readBooleanParameter(node, "repeatInfinite", index, false);
  if (operation === "media.wait") {
    return { operation, background: false, infiniteTone: false, branchCount: WaitMediaBranches.length };
  }
  if (operation === "media.playAudio" || operation === "media.playTone" || operation === "media.recordAudio") {
    if (background || infiniteTone) {
      return { operation, background, infiniteTone, branchCount: 1 };
    }
    return { operation, background, infiniteTone, branchCount: 2 };
  }
  return { operation, background, infiniteTone, branchCount: 1 };
}

function createExecutionPlan(node: any, operation: string): ExecutionPlan {
  const planGroup = resolvePlanGroup(operation);
  if (planGroup === "call" && operation === "call.wait") {
    const callWaitPlan = createCallWaitPlan(node, 0);
    return { branchCount: callWaitPlan.branchCount, callWaitPlan, dialWaitPlan: null, mediaPlan: null };
  }
  if (planGroup === "ai" && operation !== "ai.invokeAiTool") {
    return { branchCount: 1, callWaitPlan: null, dialWaitPlan: null, mediaPlan: null };
  }
  if (planGroup === "dial" && operation === "dial.wait") {
    const dialWaitPlan = createDialWaitPlan(node, 0);
    return { branchCount: dialWaitPlan.branchCount, callWaitPlan: null, dialWaitPlan, mediaPlan: null };
  }
  if (planGroup === "dial" && operation === "dial.make") {
    const callMode = String(readNodeParameter(node, "callMode", 0, "") || "").trim();
    const branchCount = callMode === "extension" ? DialMakeBranches.length : 1;
    return { branchCount, callWaitPlan: null, dialWaitPlan: null, mediaPlan: null };
  }
  if (planGroup === "call" && operation === "call.unbridge") {
    return { branchCount: 2, callWaitPlan: null, dialWaitPlan: null, mediaPlan: null };
  }
  if (planGroup === "media") {
    const mediaPlan = createMediaPlan(node, 0, operation);
    return { branchCount: mediaPlan.branchCount, callWaitPlan: null, dialWaitPlan: null, mediaPlan };
  }
  return { branchCount: 1, callWaitPlan: null, dialWaitPlan: null, mediaPlan: null };
}

function attachMediaMaterializedOutput(outputItem: any, result: Record<string, unknown>): any {
  const base64 = resultString(result, "outputBinaryBase64");
  const property = resultString(result, "outputBinaryProperty");
  if (property && base64) {
    if (!outputItem.binary || typeof outputItem.binary !== "object") {
      outputItem.binary = {};
    }
    outputItem.binary[property] = {
      data: base64,
      mimeType: resultString(result, "outputBinaryMimeType", "application/octet-stream"),
    };
  }
  return outputItem;
}

function maybeAttachFilePath(payload: Record<string, unknown>, result: Record<string, unknown>): void {
  const filePath = resultString(result, "filePath");
  if (filePath) {
    payload.filePath = filePath;
  }
}

function isInterruptedResult(result: Record<string, unknown>): boolean {
  return result.eventType === MEDIA_EVENT_INTERRUPTED || result.status === MEDIA_EVENT_INTERRUPTED;
}

function isTimeoutResult(result: Record<string, unknown>): boolean {
  return result.eventType === MEDIA_EVENT_TIMEOUT || result.status === MEDIA_EVENT_TIMEOUT;
}

function isFailedMediaResult(result: Record<string, unknown>): boolean {
  return result.failed === true || result.status === MEDIA_EVENT_FAILED || result.eventType === MEDIA_EVENT_FAILED;
}

type MediaBranchKind =
  | typeof MEDIA_EVENT_COMPLETED
  | typeof MEDIA_EVENT_INTERRUPTED
  | typeof MEDIA_EVENT_FAILED
  | typeof MEDIA_EVENT_TIMEOUT;

function buildMediaBlockingPayload(
  branchKind: MediaBranchKind,
  result: Record<string, unknown>,
  fallbackLegId: string,
): Record<string, unknown> {
  if (branchKind === MEDIA_EVENT_TIMEOUT) {
    return {};
  }
  const payload: Record<string, unknown> = {
    mediaId: resultString(result, "mediaId"),
    legId: resultString(result, "legId", fallbackLegId),
  };
  if (branchKind === MEDIA_EVENT_COMPLETED && isFailedMediaResult(result)) {
    payload.failed = true;
  }
  if (branchKind === MEDIA_EVENT_INTERRUPTED) {
    const interruptReason = resultString(result, "interruptReason");
    const digit = resultString(result, "digit");
    if (interruptReason) {
      payload.interruptReason = interruptReason;
    }
    if (digit) {
      payload.digit = digit;
    }
  }
  maybeAttachFilePath(payload, result);
  return payload;
}

async function executeCallItem(context: ItemExecutionContext): Promise<NodeEmission[]> {
  const { node, runtime, item, index, operation, plan } = context;
  switch (operation) {
    case "call.ringing": {
      const legId = requireActionValue("legId", resolveLegId(node, item, index));
      const result = await executeRing(node, runtime, item, index);
      return emit(0, buildOutputItem(item, { legId: result.legId || legId }, { legId: result.legId || legId }));
    }
    case "call.answer": {
      const legId = requireActionValue("legId", resolveLegId(node, item, index));
      const result = await executeAnswer(node, runtime, item, index);
      return emit(0, buildOutputItem(item, { legId: result.legId || legId }, { legId: result.legId || legId }));
    }
    case "call.hangup": {
      const legId = requireActionValue("legId", resolveLegId(node, item, index));
      const result = await executeHangup(node, runtime, item, index);
      return emit(0, buildOutputItem(item, { legId: result.legId || legId }, { legId: result.legId || legId }));
    }
    case "call.bridge": {
      const legAId = requireActionValue("legAId", String(readNodeParameter(node, "legAId", index, "")));
      const legBId = requireActionValue("legBId", String(readNodeParameter(node, "legBId", index, "")));
      const result = await executeBridge(node, runtime, item, index);
      return emit(0, buildOutputItem(item, {
        legIdA: result.legAId || legAId,
        legIdB: result.legBId || legBId,
      }));
    }
    case "call.unbridge": {
      const legId = requireActionValue("legId", resolveLegId(node, item, index));
      const result = await executeUnbridge(node, runtime, item, index);
      const origLegId = String(result.origLegId || legId);
      const emissions = emit(0, buildOutputItem(item, { legId: origLegId }, { legId: origLegId }));
      const peerLegId = String(result.peerLegId || "").trim();
      if (!peerLegId) {
        return emissions;
      }
      return emitMany(
        emissions[0]!,
        { branchIndex: 1, item: buildOutputItem(item, { legId: peerLegId }, { legId: peerLegId }) },
      );
    }
    case "call.wait": {
      const callWaitPlan = plan.callWaitPlan!;
      const fallbackLegIds = resolveWaitLegIds(node, item, index);
      const fallbackLegId = fallbackLegIds[0] || "";
      const result = await executeWaitLegEvent(node, runtime, item, index, callWaitPlan.rules);
      const resultLegId = resultString(result, "legId", fallbackLegId);
      let payload: Record<string, unknown> = { legId: resultLegId };
      let branchIndex = callWaitPlan.timeoutIndex;

      if (result.output === CALL_WAIT_OUTPUT_MATCHED) {
        payload = { legId: resultLegId, eventType: CALL_EVENT_DTMF };
        branchIndex = callWaitPlan.branchIndexByLabel.get(String(result.matchedLabel || "")) ?? callWaitPlan.timeoutIndex;
      } else if (result.output === CALL_WAIT_OUTPUT_DTMF_FALLBACK) {
        payload = { legId: resultLegId, eventType: CALL_EVENT_DTMF, digits: result.digits };
        branchIndex = callWaitPlan.dtmfFallbackIndex ?? callWaitPlan.timeoutIndex;
      } else if (result.output === CALL_WAIT_OUTPUT_INTERRUPT) {
        payload = { legId: resultLegId, eventType: CALL_EVENT_INTERRUPT, reason: result.reason };
        branchIndex = callWaitPlan.interruptIndex;
      } else if (result.output === CALL_WAIT_OUTPUT_ENDED) {
        payload = { legId: resultLegId, eventType: CALL_EVENT_ENDED, reason: result.reason };
        branchIndex = callWaitPlan.endedIndex;
      } else {
        payload = { legId: resultLegId, eventType: CALL_EVENT_TIMEOUT };
      }

      return emit(branchIndex, buildOutputItem(item, payload, { legId: resultLegId || undefined }));
    }
    default:
      throw new Error(`Unsupported call operation: ${operation}`);
  }
}

async function executeAiItem(context: ItemExecutionContext): Promise<NodeEmission[]> {
  const { node, runtime, item, index, operation } = context;
  switch (operation) {
    case "ai.invokeAiTool":
      throw new Error("ai.invokeAiTool is tool-only and cannot be executed as a normal action");
    case "ai.attachVoiceAgent": {
      const result = await executeAttachVoiceAgent(node, runtime, item, index);
      const legId = String((result && result.legId) || "").trim();
      const payload: Record<string, unknown> = {
        legId,
        eventType: String((result && result.eventType) || CALL_EVENT_ENDED).trim() || CALL_EVENT_ENDED,
      };
      if (!legId) {
        throw new Error("legId is required");
      }
      const reason = String((result && result.reason) || "").trim();
      if (reason) {
        payload.reason = reason;
      }
      return emit(0, buildOutputItem(item, payload, { legId }));
    }
    default:
      throw new Error(`Unsupported ai operation: ${operation}`);
  }
}

async function executeDialItem(context: ItemExecutionContext): Promise<NodeEmission[]> {
  const { node, runtime, item, index, operation, plan } = context;
  switch (operation) {
    case "dial.make": {
      try {
        const result = await executeMakeCall(node, runtime, index);
        const legId = resultString(result, "legId");
        const payload: Record<string, unknown> = { dialId: result.dialId };
        if (legId) {
          payload.legId = legId;
        }
        return emit(0, buildOutputItem(item, payload, { dialId: result.dialId, legId: legId || undefined }));
      } catch (error) {
        const callMode = String(readNodeParameter(node, "callMode", index, "") || "").trim();
        if (callMode === "extension" && isExtensionNoAvailableEndpointsError(error)) {
          const payload = {
            reason: "no_available_endpoints",
            message: "No registered endpoints matched the requested extension list.",
            extensionNumbers: normalizeStringList(String(readNodeParameter(node, "extensionNumbers", index, "") || "")),
          };
          return emit(1, buildOutputItem(item, payload));
        }
        if (callMode !== "extension") {
          throw error;
        }
        throw error;
      }
    }
    case "dial.break": {
      const dialId = requireActionValue("dialId", resolveDialId(node, item, index));
      const result = await executeBreakDial(node, runtime, item, index);
      return emit(0, buildOutputItem(item, { dialId: result.dialId || dialId }, { dialId: result.dialId || dialId }));
    }
    case "dial.wait": {
      const dialWaitPlan = plan.dialWaitPlan!;
      const fallbackDialIds = resolveWaitDialIds(node, item, index);
      const fallbackDialId = fallbackDialIds[0] || "";
      const result = await executeWaitDial(node, runtime, item, index, dialWaitPlan.selectedOutputs);
      const resultDialId = resultString(result, "dialId", fallbackDialId);
      const legId = resultString(result, "legId");
      const payload: Record<string, unknown> = {
        dialId: resultDialId,
        stillDialingLegCount: resultNumber(result, "stillDialingLegCount", 0),
      };
      let branchIndex = dialWaitPlan.failedIndex;

      if (result.eventType === DIAL_EVENT_RINGING) {
        if (legId) {
          payload.legId = legId;
        }
        branchIndex = dialWaitPlan.ringingIndex ?? dialWaitPlan.failedIndex;
      } else if (result.eventType === DIAL_EVENT_PROGRESS) {
        if (legId) {
          payload.legId = legId;
        }
        branchIndex = dialWaitPlan.progressIndex ?? dialWaitPlan.failedIndex;
      } else if (result.eventType === DIAL_EVENT_ANSWERED) {
        if (legId) {
          payload.legId = legId;
        }
        branchIndex = dialWaitPlan.answeredIndex;
      } else if (result.eventType === DIAL_EVENT_REJECTED) {
        if (legId) {
          payload.legId = legId;
        }
        branchIndex = dialWaitPlan.rejectedIndex ?? dialWaitPlan.failedIndex;
      } else if (result.eventType === DIAL_EVENT_TIMEOUT) {
        branchIndex = dialWaitPlan.timeoutIndex;
      } else {
        payload.reason = resultString(result, "reason");
        branchIndex = dialWaitPlan.failedIndex;
      }

      return emit(branchIndex, buildOutputItem(item, payload, {
        dialId: resultDialId || undefined,
        legId: legId || undefined,
      }));
    }
    default:
      throw new Error(`Unsupported dial operation: ${operation}`);
  }
}

async function executeRespondItem(context: ItemExecutionContext): Promise<NodeEmission[]> {
  const { node, runtime, item, index, operation } = context;
  switch (operation) {
    case "respond.toRecord": {
      const recordRequestId = requireActionValue("recordRequestId", resolveRecordRequestId(node, item, index));
      const result = await executeRespondToRecord(node, runtime, item, index);
      const payload = {
        ...(result || {}),
        recordRequestId: result.recordRequestId || recordRequestId,
      };
      return emit(0, buildOutputItem(item, {
        ...payload,
      }, {
        recordRequestId: result.recordRequestId || recordRequestId,
        legId: resultString(result, "legId") || undefined,
      }));
    }
    case "respond.toAuth": {
      const authRequestId = requireActionValue("authRequestId", resolveAuthRequestId(node, item, index));
      const result = await executeRespondToAuth(node, runtime, item, index);
      return emit(0, buildOutputItem(item, {
        authRequestId: result.authRequestId || authRequestId,
      }, {
        authRequestId: result.authRequestId || authRequestId,
      }));
    }
    case "respond.toAiTool": {
      const aiToolRequestId = requireActionValue("aiToolRequestId", resolveAiToolRequestId(node, item, index));
      const result = await executeRespondToAiTool(node, runtime, item, index);
      return emit(0, buildOutputItem(item, {
        aiToolRequestId: result.aiToolRequestId || aiToolRequestId,
      }, {
        aiToolRequestId: result.aiToolRequestId || aiToolRequestId,
      }));
    }
    default:
      throw new Error(`Unsupported respond operation: ${operation}`);
  }
}

async function executeQueueItem(context: ItemExecutionContext): Promise<NodeEmission[]> {
  const { node, runtime, item, index, operation } = context;
  switch (operation) {
    case "queue.putLeg": {
      const legId = requireActionValue("legId", resolveLegId(node, item, index, "legId", "queueOptions"));
      const result = await executeEnqueueLeg(node, runtime, item, index);
      return emit(0, buildOutputItem(item, { legId: result.legId || legId }, { legId: result.legId || legId }));
    }
    case "queue.setCallback": {
      const legId = requireActionValue("legId", resolveLegId(node, item, index, "legId", "queueOptions"));
      const result = await executeSetQueueCallback(node, runtime, item, index);
      return emit(0, buildOutputItem(item, { legId: result.legId || legId }, { legId: result.legId || legId }));
    }
    case "queue.getStats": {
      const ref =
        String(readNodeParameter(node, "ref", index, ""))
        || String((item?.json && item.json.ref) || (item?.json?.sipPbx && item.json.sipPbx.ref) || "").trim();
      const result = await executeGetQueueStats(node, runtime, item, index);
      const payload: Record<string, unknown> = {
        ref: resultString(result, "ref", ref),
        size: resultNumber(result, "size", 0),
        averageWaitSeconds: resultNumber(result, "averageWaitSeconds", 0),
        completedCount: resultNumber(result, "completedCount", 0),
        updatedAt: resultNumber(result, "updatedAt", 0),
      };
      if (resultDefined(result, "legId")) {
        payload.legId = resultString(result, "legId", "");
      }
      if (resultDefined(result, "position")) {
        payload.position = resultNumber(result, "position", 0);
      }
      if (resultDefined(result, "estimatedAnswerSeconds")) {
        payload.estimatedAnswerSeconds = resultNumber(result, "estimatedAnswerSeconds", 0);
      }
      return emit(0, buildOutputItem(item, payload, {
        ref: resultString(result, "ref", ref),
        ...(resultDefined(result, "legId") ? { legId: resultString(result, "legId", "") } : {}),
      }));
    }
    default:
      throw new Error(`Unsupported queue operation: ${operation}`);
  }
}

async function executeRecordingItem(context: ItemExecutionContext): Promise<NodeEmission[]> {
  const { node, runtime, item, index, operation } = context;
  switch (operation) {
    case "recording.control": {
      const legId = requireActionValue("legId", resolveLegId(node, item, index));
      const result = await executeControlRecording(node, runtime, item, index);
      return emit(0, buildOutputItem(item, { legId: result.legId || legId }, { legId: result.legId || legId }));
    }
    case "recording.start": {
      const legId = requireActionValue("legId", resolveLegId(node, item, index, "legId", "recordingOptions"));
      const result = await executeStartGlobalRecording(node, runtime, item, index);
      const payload = {
        ...(result || {}),
        legId: resultString(result, "legId", legId),
      };
      return emit(0, buildOutputItem(item, payload, {
        legId: resultString(result, "legId", legId) || undefined,
      }));
    }
    default:
      throw new Error(`Unsupported recording operation: ${operation}`);
  }
}

async function executeMediaItem(context: ItemExecutionContext): Promise<NodeEmission[]> {
  const { node, runtime, item, index, operation, plan } = context;
  const mediaPlan = plan.mediaPlan!;
  const fallbackLegId = resolveMediaLegId(node, item, index);

  let result: Record<string, unknown>;
  switch (operation) {
    case "media.playAudio":
      result = await executePlayAudio(node, runtime, item, index);
      break;
    case "media.playTone":
      result = await executePlayTone(node, runtime, item, index);
      break;
    case "media.recordAudio":
      result = await executeRecordAudio(node, runtime, item, index);
      break;
    case "media.stopMedia":
      result = await executeStopMedia(node, runtime, item, index);
      break;
    case "media.wait":
      result = await executeWaitMedia(node, runtime, item, index);
      break;
    case "media.sendDtmf":
      result = await executeSendDtmf(node, runtime, item, index);
      break;
    default:
      throw new Error(`Unsupported media operation: ${operation}`);
  }

  if (operation === "media.stopMedia") {
    const mediaId = resultString(result, "mediaId");
    const legId = resultString(result, "legId", fallbackLegId);
    const payload = mediaId ? { mediaId, legId } : { legId };
    return emit(0, buildOutputItem(item, payload, {
      mediaId: mediaId || undefined,
      legId: legId || undefined,
    }));
  }

  if (operation === "media.sendDtmf") {
    const legId = resultString(result, "legId", fallbackLegId);
    return emit(0, buildOutputItem(item, { legId }, { legId: legId || undefined }));
  }

  const resolvedMediaId = resultString(result, "mediaId");
  const resolvedLegId = resultString(result, "legId", fallbackLegId);
  let branchIndex = 0;
  let branchKind: MediaBranchKind = MEDIA_EVENT_COMPLETED;

  if (operation === "media.wait") {
    if (isInterruptedResult(result)) {
      branchIndex = requireBranchIndex(WaitMediaBranches, WaitMediaBranchInterrupted);
      branchKind = MEDIA_EVENT_INTERRUPTED;
    } else if (isTimeoutResult(result)) {
      branchIndex = requireBranchIndex(WaitMediaBranches, WaitMediaBranchTimeout);
      branchKind = MEDIA_EVENT_TIMEOUT;
    } else {
      branchIndex = requireBranchIndex(WaitMediaBranches, WaitMediaBranchCompleted);
      branchKind = MEDIA_EVENT_COMPLETED;
    }
  } else if (mediaPlan.background) {
    branchIndex = 0;
    branchKind = MEDIA_EVENT_COMPLETED;
  } else if (operation === "media.playTone" && mediaPlan.infiniteTone) {
    if (!isInterruptedResult(result)) {
      throw new Error("media.playTone with repeatInfinite=true must terminate only with interrupted result");
    }
    branchIndex = 0;
    branchKind = MEDIA_EVENT_INTERRUPTED;
  } else if (isInterruptedResult(result)) {
    branchIndex = 0;
    branchKind = MEDIA_EVENT_INTERRUPTED;
  } else {
    branchIndex = 1;
    branchKind = MEDIA_EVENT_COMPLETED;
  }

  const payload = buildMediaBlockingPayload(branchKind, result, resolvedLegId);
  const outputItem = attachMediaMaterializedOutput(buildOutputItem(item, payload, {
    mediaId: branchKind === MEDIA_EVENT_TIMEOUT ? undefined : (resolvedMediaId || undefined),
    legId: branchKind === MEDIA_EVENT_TIMEOUT ? undefined : (resolvedLegId || undefined),
  }), result);
  return emit(branchIndex, outputItem);
}

async function executeActionItem(context: ItemExecutionContext): Promise<NodeEmission[]> {
  switch (resolveExecutionGroup(context)) {
    case "call":
      return await executeCallItem(context);
    case "dial":
      return await executeDialItem(context);
    case "ai":
      return await executeAiItem(context);
    case "respond":
      return await executeRespondItem(context);
    case "queue":
      return await executeQueueItem(context);
    case "recording":
      return await executeRecordingItem(context);
    case "media":
      return await executeMediaItem(context);
    default:
      throw new Error(`Unsupported operation: ${context.operation}`);
  }
}

export async function executeSipPbxActionNode(node: any, runtime: PbxRuntime): Promise<any> {
  const items = getInputItems(node);
  const operation = readOperation(node, 0);
  const plan = createExecutionPlan(node, operation);
  const outputs = createOutputMatrix(plan.branchCount);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const emissions = await executeActionItem({
      node,
      runtime,
      item,
      index,
      operation,
      plan,
    });
    for (const emission of emissions) {
      pushOutput(outputs, emission.branchIndex, emission.item);
    }
  }

  return outputs;
}
