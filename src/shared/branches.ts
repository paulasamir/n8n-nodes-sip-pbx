/**
 * Central registry for n8n output branch names.
 *
 * Two sources of truth had been drifting apart: the UI description (string
 * literals embedded in n8n expressions for `outputs`) and the runtime emission
 * code (cursor-driven index assignments + string-keyed branch dispatching).
 * Every branch must appear here exactly once; declaration sites and emission
 * sites both read from these tables.
 */

// === Triggers =============================================================

export const QueueTriggerBranchPlaced = "Placed" as const;
export const QueueTriggerBranchDispatch = "Dispatch" as const;
export const QueueTriggerBranchOffline = "Offline" as const;
export const QueueTriggerBranches = [
  QueueTriggerBranchPlaced,
  QueueTriggerBranchDispatch,
  QueueTriggerBranchOffline,
] as const;
export type QueueTriggerBranch = (typeof QueueTriggerBranches)[number];

export const AiToolTriggerBranchRequest = "Request" as const;
export const AiToolTriggerBranches = [AiToolTriggerBranchRequest] as const;
export type AiToolTriggerBranch = (typeof AiToolTriggerBranches)[number];

/**
 * Internal voiceAgent stream branches: not exposed as n8n output branches,
 * but pumped over the trigger stream to ai-actions.ts. The branch field on
 * the stream event identifies the kind of event.
 */
export const VoiceAgentStreamBranchToolCall = "ToolCall" as const;
export const VoiceAgentStreamBranchMemoryTurn = "MemoryTurn" as const;
export type VoiceAgentStreamBranch =
  | typeof VoiceAgentStreamBranchToolCall
  | typeof VoiceAgentStreamBranchMemoryTurn;

/**
 * Trunk trigger has one always-present branch (Call) and one optional
 * (Record) appended when call recording is enabled.
 */
export const TrunkTriggerBranchCall = "Call" as const;
export const TrunkTriggerBranchRecord = "Record" as const;
export type TrunkTriggerBranch = typeof TrunkTriggerBranchCall | typeof TrunkTriggerBranchRecord;

export function buildTrunkTriggerBranchOrder(enableRecording: boolean): readonly TrunkTriggerBranch[] {
  return enableRecording
    ? [TrunkTriggerBranchCall, TrunkTriggerBranchRecord]
    : [TrunkTriggerBranchCall];
}

/**
 * Extensions trigger order: Call (always) → Record (if recording on) → Auth
 * (if authMode !== "static"). Index of Auth depends on whether Record is
 * present, so all consumers must derive their index via `indexOf`.
 */
export const ExtensionsTriggerBranchCall = "Call" as const;
export const ExtensionsTriggerBranchRecord = "Record" as const;
export const ExtensionsTriggerBranchAuth = "Auth" as const;
export type ExtensionsTriggerBranch =
  | typeof ExtensionsTriggerBranchCall
  | typeof ExtensionsTriggerBranchRecord
  | typeof ExtensionsTriggerBranchAuth;

export function buildExtensionsTriggerBranchOrder(
  enableRecording: boolean,
  enableAuth: boolean,
): readonly ExtensionsTriggerBranch[] {
  const order: ExtensionsTriggerBranch[] = [ExtensionsTriggerBranchCall];
  if (enableRecording) order.push(ExtensionsTriggerBranchRecord);
  if (enableAuth) order.push(ExtensionsTriggerBranchAuth);
  return order;
}

// === Action: single-output (most actions) =================================

export const ActionResultBranch = "Result" as const;
export const ActionResultBranches = [ActionResultBranch] as const;

// === Action: call.bridge ==================================================

export const BridgeBranch = "Success" as const;
export const BridgeBranches = [BridgeBranch] as const;

// === Action: call.unbridge ================================================

export const UnbridgeBranchOrig = "Orig" as const;
export const UnbridgeBranchPeer = "Peer" as const;
export const UnbridgeBranches = [UnbridgeBranchOrig, UnbridgeBranchPeer] as const;

// === Action: media.waitMedia ==============================================

export const WaitMediaBranchInterrupted = "Interrupted" as const;
export const WaitMediaBranchCompleted = "Completed" as const;
export const WaitMediaBranchTimeout = "Timeout" as const;
export const WaitMediaBranches = [
  WaitMediaBranchInterrupted,
  WaitMediaBranchTimeout,
  WaitMediaBranchCompleted,
] as const;

// === Action: media.playAudio / playTone / recordAudio =====================

export const MediaBlockingBranchInterrupted = "Interrupted" as const;
export const MediaBlockingBranchCompleted = "Completed" as const;
export const MediaBackgroundBranchResult = "Result" as const;
export const MediaInfiniteToneBranchInterrupted = "Interrupted" as const;

export const MediaBlockingBranches = [
  MediaBlockingBranchInterrupted,
  MediaBlockingBranchCompleted,
] as const;
export const MediaBackgroundBranches = [MediaBackgroundBranchResult] as const;
export const MediaInfiniteToneBranches = [MediaInfiniteToneBranchInterrupted] as const;

// === Action: dial.waitDialEvent (optional + mandatory) ====================

export const DialWaitBranchRinging = "Ringing" as const;
export const DialWaitBranchProgress = "Progress" as const;
export const DialWaitBranchAnswered = "Answered" as const;
export const DialWaitBranchRejected = "Rejected" as const;
export const DialWaitBranchFailed = "Failed" as const;
export const DialWaitBranchTimeout = "Timeout" as const;
export type DialWaitBranch =
  | typeof DialWaitBranchRinging
  | typeof DialWaitBranchProgress
  | typeof DialWaitBranchAnswered
  | typeof DialWaitBranchRejected
  | typeof DialWaitBranchFailed
  | typeof DialWaitBranchTimeout;

export function buildDialWaitBranchOrder(input: {
  includeRinging: boolean;
  includeProgress: boolean;
  includeRejected: boolean;
}): readonly DialWaitBranch[] {
  const order: DialWaitBranch[] = [];
  if (input.includeRinging) order.push(DialWaitBranchRinging);
  if (input.includeProgress) order.push(DialWaitBranchProgress);
  if (input.includeRejected) order.push(DialWaitBranchRejected);
  order.push(DialWaitBranchAnswered);
  order.push(DialWaitBranchTimeout);
  order.push(DialWaitBranchFailed);
  return order;
}

// === Action: call.waitCallEvent (DTMF labels + static tail) ===============
//
// The leading branches are dynamic — one per user-defined DTMF rule label.
// The static tail in order: DTMF Fallback (optional), Interrupt, Timeout, Ended.

export const CallWaitBranchDtmfFallback = "DTMF Fallback" as const;
export const CallWaitBranchInterrupt = "Interrupt" as const;
export const CallWaitBranchEnded = "Ended" as const;
export const CallWaitBranchTimeout = "Timeout" as const;
export type CallWaitStaticBranch =
  | typeof CallWaitBranchDtmfFallback
  | typeof CallWaitBranchInterrupt
  | typeof CallWaitBranchEnded
  | typeof CallWaitBranchTimeout;

export function buildCallWaitStaticTail(includeDtmfFallback: boolean): readonly CallWaitStaticBranch[] {
  const tail: CallWaitStaticBranch[] = [];
  if (includeDtmfFallback) tail.push(CallWaitBranchDtmfFallback);
  tail.push(CallWaitBranchInterrupt);
  tail.push(CallWaitBranchTimeout);
  tail.push(CallWaitBranchEnded);
  return tail;
}

// === Helpers ==============================================================

/**
 * Safe `indexOf` for branch orders. Returns the index, or throws — callers
 * that hit "not found" mean the call site is out of sync with the registry.
 */
export function requireBranchIndex<T extends string>(order: readonly T[], name: T): number {
  const idx = order.indexOf(name);
  if (idx < 0) {
    throw new Error(`Branch "${name}" not found in [${order.join(", ")}]`);
  }
  return idx;
}

/** Pre-sized empty output array — one [] per branch, ready to be pushed into. */
export function buildEmptyOutputs<T extends string>(order: readonly T[]): unknown[][] {
  return order.map(() => [] as unknown[]);
}
