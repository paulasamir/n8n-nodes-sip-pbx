/**
 * Daemon↔n8n result payload vocabulary.
 *
 * Every `eventType`, `status`, and `output` string that the daemon writes
 * into action result envelopes (and that the n8n side later branches on)
 * must come from here. The strings are intentionally short/lowercase — they
 * are an internal wire format, not user-visible — but they're typo-sensitive
 * across process boundaries, so constants prevent silent drift between
 * producer and consumer.
 */

export const MEDIA_EVENT_STARTED = "started" as const;
export const MEDIA_EVENT_COMPLETED = "completed" as const;
export const MEDIA_EVENT_INTERRUPTED = "interrupted" as const;
export const MEDIA_EVENT_TIMEOUT = "timeout" as const;
export const MEDIA_EVENT_FAILED = "failed" as const;
export const MEDIA_EVENTS = [
  MEDIA_EVENT_STARTED,
  MEDIA_EVENT_COMPLETED,
  MEDIA_EVENT_INTERRUPTED,
  MEDIA_EVENT_TIMEOUT,
  MEDIA_EVENT_FAILED,
] as const;
export type MediaEventType = (typeof MEDIA_EVENTS)[number];

export const DIAL_EVENT_RINGING = "ringing" as const;
export const DIAL_EVENT_PROGRESS = "progress" as const;
export const DIAL_EVENT_ANSWERED = "answered" as const;
export const DIAL_EVENT_INTERRUPTED = "interrupted" as const;
export const DIAL_EVENT_REJECTED = "rejected" as const;
export const DIAL_EVENT_TIMEOUT = "timeout" as const;
export const DIAL_EVENT_FAILED = "failed" as const;
export const DIAL_EVENTS = [
  DIAL_EVENT_RINGING,
  DIAL_EVENT_PROGRESS,
  DIAL_EVENT_ANSWERED,
  DIAL_EVENT_INTERRUPTED,
  DIAL_EVENT_REJECTED,
  DIAL_EVENT_TIMEOUT,
  DIAL_EVENT_FAILED,
] as const;
export type DialEventType = (typeof DIAL_EVENTS)[number];

export const CALL_EVENT_DTMF = "dtmf" as const;
export const CALL_EVENT_INTERRUPT = "interrupt" as const;
export const CALL_EVENT_ENDED = "ended" as const;
export const CALL_EVENT_TIMEOUT = "timeout" as const;
export const CALL_EVENTS = [
  CALL_EVENT_DTMF,
  CALL_EVENT_INTERRUPT,
  CALL_EVENT_ENDED,
  CALL_EVENT_TIMEOUT,
] as const;
export type CallEventType = (typeof CALL_EVENTS)[number];

export const CALL_WAIT_OUTPUT_MATCHED = "matched" as const;
export const CALL_WAIT_OUTPUT_DTMF_FALLBACK = "dtmfFallback" as const;
export const CALL_WAIT_OUTPUT_INTERRUPT = "interrupt" as const;
export const CALL_WAIT_OUTPUT_ENDED = "ended" as const;
export const CALL_WAIT_OUTPUT_TIMEOUT = "timeout" as const;
export const CALL_WAIT_OUTPUTS = [
  CALL_WAIT_OUTPUT_MATCHED,
  CALL_WAIT_OUTPUT_DTMF_FALLBACK,
  CALL_WAIT_OUTPUT_INTERRUPT,
  CALL_WAIT_OUTPUT_ENDED,
  CALL_WAIT_OUTPUT_TIMEOUT,
] as const;
export type CallWaitOutput = (typeof CALL_WAIT_OUTPUTS)[number];

/**
 * These belong to the daemon's domain (Leg.status, Dial.status, Media.status)
 * but several callers compare against literal values; promoting them to
 * constants keeps "stringly-typed" comparisons typo-safe.
 */
export const LEG_STATUS_CREATED = "created" as const;
export const LEG_STATUS_RINGING = "ringing" as const;
export const LEG_STATUS_ANSWERED = "answered" as const;
export const LEG_STATUS_QUEUED = "queued" as const;
export const LEG_STATUS_CALLBACK = "callback" as const;
export const LEG_STATUS_ENDED = "ended" as const;
export type LegStatusName =
  | typeof LEG_STATUS_CREATED
  | typeof LEG_STATUS_RINGING
  | typeof LEG_STATUS_ANSWERED
  | typeof LEG_STATUS_QUEUED
  | typeof LEG_STATUS_CALLBACK
  | typeof LEG_STATUS_ENDED;

export const DIAL_STATUS_CREATED = "created" as const;
export const DIAL_STATUS_DIALING = "dialing" as const;
export const DIAL_STATUS_ANSWERED = "answered" as const;
export const DIAL_STATUS_REJECTED = "rejected" as const;
export const DIAL_STATUS_FAILED = "failed" as const;
export const DIAL_STATUS_TIMEOUT = "timeout" as const;
export type DialStatusName =
  | typeof DIAL_STATUS_CREATED
  | typeof DIAL_STATUS_DIALING
  | typeof DIAL_STATUS_ANSWERED
  | typeof DIAL_STATUS_REJECTED
  | typeof DIAL_STATUS_FAILED
  | typeof DIAL_STATUS_TIMEOUT;

export const DIAL_WAIT_SELECTION_RINGING = "ringing" as const;
export const DIAL_WAIT_SELECTION_PROGRESS = "progress" as const;
export const DIAL_WAIT_SELECTION_REJECTED = "rejected" as const;
export const DIAL_WAIT_SELECTIONS = [
  DIAL_WAIT_SELECTION_RINGING,
  DIAL_WAIT_SELECTION_PROGRESS,
  DIAL_WAIT_SELECTION_REJECTED,
] as const;
export type DialWaitSelection = (typeof DIAL_WAIT_SELECTIONS)[number];
