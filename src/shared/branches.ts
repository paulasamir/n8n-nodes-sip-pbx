/**
 * Central registry for n8n output branch names.
 *
 * Two sources of truth had been drifting apart: the UI description (string
 * literals embedded in n8n expressions for `outputs`) and the runtime emission
 * code (cursor-driven index assignments + string-keyed branch dispatching).
 * Every branch must appear here exactly once; declaration sites and emission
 * sites both read from these tables.
 */

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
 * (Recording) appended when call recording is enabled.
 */
export const TrunkTriggerBranchCall = "Call" as const;
export const TrunkTriggerBranchRecord = "Recording" as const;
export const TrunkTriggerBranchAuth = "Auth" as const;
export type TrunkTriggerBranch =
  | typeof TrunkTriggerBranchCall
  | typeof TrunkTriggerBranchRecord
  | typeof TrunkTriggerBranchAuth;

export function buildTrunkTriggerBranchOrder(
  enableRecording: boolean,
  enableAuth: boolean,
): readonly TrunkTriggerBranch[] {
  const order: TrunkTriggerBranch[] = [TrunkTriggerBranchCall];
  if (enableRecording) order.push(TrunkTriggerBranchRecord);
  if (enableAuth) order.push(TrunkTriggerBranchAuth);
  return order;
}

/**
 * Extensions trigger order: Call (always) → Recording (if recording on) → Auth
 * (if authMode !== "static"). Index of Auth depends on whether Recording is
 * present, so all consumers must derive their index via `indexOf`.
 */
export const ExtensionsTriggerBranchCall = "Call" as const;
export const ExtensionsTriggerBranchRecord = "Recording" as const;
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

export const ActionResultBranch = "Result" as const;
export const ActionResultBranches = [ActionResultBranch] as const;

export const DialMakeBranchResult = "Result" as const;
export const DialMakeBranchUnavailable = "Unavailable" as const;
export const DialMakeBranches = [DialMakeBranchResult, DialMakeBranchUnavailable] as const;

export const BridgeBranch = "Success" as const;
export const BridgeBranches = [BridgeBranch] as const;

export const UnbridgeBranchOrig = "Orig" as const;
export const UnbridgeBranchPeer = "Peer" as const;
export const UnbridgeBranches = [UnbridgeBranchOrig, UnbridgeBranchPeer] as const;

export const WaitMediaBranchInterrupted = "Interrupted" as const;
export const WaitMediaBranchCompleted = "Completed" as const;
export const WaitMediaBranchTimeout = "Timeout" as const;
export const WaitMediaBranches = [
  WaitMediaBranchInterrupted,
  WaitMediaBranchTimeout,
  WaitMediaBranchCompleted,
] as const;

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

export const DialWaitBranchRinging = "Ringing" as const;
export const DialWaitBranchProgress = "Progress" as const;
export const DialWaitBranchAnswered = "Answered" as const;
export const DialWaitBranchInterrupted = "Interrupted" as const;
export const DialWaitBranchRejected = "Rejected" as const;
export const DialWaitBranchFailed = "Failed" as const;
export const DialWaitBranchTimeout = "Timeout" as const;
export type DialWaitBranch =
  | typeof DialWaitBranchRinging
  | typeof DialWaitBranchProgress
  | typeof DialWaitBranchAnswered
  | typeof DialWaitBranchInterrupted
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
  order.push(DialWaitBranchInterrupted);
  order.push(DialWaitBranchTimeout);
  order.push(DialWaitBranchFailed);
  return order;
}

/**
 * The leading branches are dynamic — one per user-defined DTMF rule label.
 * The static tail in order: DTMF Fallback (optional), Interrupted, Timeout, Ended.
 */
export const CallWaitBranchDtmfFallback = "DTMF Fallback" as const;
export const CallWaitBranchInterrupt = "Interrupted" as const;
export const CallWaitBranchEnded = "Ended" as const;
export const CallWaitBranchTimeout = "Timeout" as const;
export type CallWaitStaticBranch =
  | typeof CallWaitBranchDtmfFallback
  | typeof CallWaitBranchInterrupt
  | typeof CallWaitBranchEnded
  | typeof CallWaitBranchTimeout;

export function buildCallWaitStaticTail(
  includeDtmfFallback: boolean,
  includeInterrupt: boolean,
): readonly CallWaitStaticBranch[] {
  const tail: CallWaitStaticBranch[] = [];
  if (includeDtmfFallback) tail.push(CallWaitBranchDtmfFallback);
  if (includeInterrupt) tail.push(CallWaitBranchInterrupt);
  tail.push(CallWaitBranchTimeout);
  tail.push(CallWaitBranchEnded);
  return tail;
}

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
