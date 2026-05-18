import { daemonError } from "../core/daemon-error";
import type { RequestContext } from "../core/request-context";
import { nowMs } from "../core/time";
import { CALL_INTERRUPT_REASONS, type CallInterruptReason } from "../../shared/interrupt-reasons";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";
import { MapRegistry } from "../../shared/map-registry";
import { TerminalSnapshotStore } from "../core/terminal-snapshot-store";
import {
  CALL_EVENT_DTMF,
  CALL_EVENT_ENDED,
  CALL_EVENT_INTERRUPT,
  CALL_EVENT_TIMEOUT,
  CALL_WAIT_OUTPUT_DTMF_FALLBACK,
  CALL_WAIT_OUTPUT_ENDED,
  CALL_WAIT_OUTPUT_INTERRUPT,
  CALL_WAIT_OUTPUT_MATCHED,
  CALL_WAIT_OUTPUT_TIMEOUT,
  LEG_STATUS_ENDED,
} from "../../shared/result-events";
import { normalizeStringList } from "../../shared/string-utils";
import type { Leg, LegEvent } from "./types";

export type WaitRule = {
  pattern: string;
  label: string;
};

type WaitInput = {
  timeoutMs: number;
  interdigitTimeoutMs?: number;
  rules?: WaitRule[];
  interruptReasons?: CallInterruptReason[];
  clearDtmfBuffer?: boolean;
  waitDtmfFallbackEnabled?: boolean;
  waitDtmfMultiDigitFallbackEnabled?: boolean;
  dtmfTerminatorDigit?: string;
};

type WaitOutput =
  | {
      legId: string;
      eventType: typeof CALL_EVENT_DTMF;
      output: typeof CALL_WAIT_OUTPUT_MATCHED;
      digits: string;
      matchedPattern: string;
      matchedLabel: string;
      createdAt: number;
    }
  | {
      legId: string;
      eventType: typeof CALL_EVENT_DTMF;
      output: typeof CALL_WAIT_OUTPUT_DTMF_FALLBACK;
      digits: string;
      createdAt: number;
      terminatedBy?: string;
    }
  | {
      legId: string;
      eventType: typeof CALL_EVENT_INTERRUPT;
      output: typeof CALL_WAIT_OUTPUT_INTERRUPT;
      reason: string;
      createdAt: number;
    }
  | {
      legId: string;
      eventType: typeof CALL_EVENT_ENDED;
      output: typeof CALL_WAIT_OUTPUT_ENDED;
      reason: string;
      createdAt: number;
    }
  | {
      legId: string;
      eventType: typeof CALL_EVENT_TIMEOUT;
      output: typeof CALL_WAIT_OUTPUT_TIMEOUT;
      digits?: string;
      createdAt: number;
    };

type PerLegState = {
  digits: string;
  lastDigitAt: number;
};

type ProcessEventResult = {
  digits: string;
  output: WaitOutput | null;
  lastDigitAt?: number;
  awaitingMoreDigits: boolean;
};

function timeoutOutput(legId: string, digits?: string): WaitOutput {
  return {
    legId,
    eventType: CALL_EVENT_TIMEOUT,
    output: CALL_WAIT_OUTPUT_TIMEOUT,
    digits: digits || undefined,
    createdAt: nowMs(),
  };
}

export class LegWaitService {
  private readonly registry: MapRegistry<string, Leg>;
  private readonly terminalSnapshots: TerminalSnapshotStore<{ legId: string; event: LegEvent }>;

  constructor(
    registry: MapRegistry<string, Leg>,
    terminalSnapshots?: TerminalSnapshotStore<{ legId: string; event: LegEvent }>,
  ) {
    this.registry = registry;
    this.terminalSnapshots = terminalSnapshots || new TerminalSnapshotStore<{ legId: string; event: LegEvent }>();
  }

  async waitForEvent(
    legId: string | string[],
    input: number | WaitInput,
    context?: RequestContext | null,
  ): Promise<WaitOutput> {
    const params = typeof input === "number" ? { timeoutMs: input } : input;
    const legIds = Array.from(new Set(normalizeStringList(legId)));
    if (legIds.length === 0) {
      throw daemonError("invalid_leg_wait", "No leg IDs to wait");
    }

    const snapshots = legIds.map((currentLegId) => ({
      legId: currentLegId,
      snapshot: this.terminalSnapshots.get(currentLegId),
    }));
    const records = legIds.map((currentLegId) => ({
      legId: currentLegId,
      record: this.registry.get(currentLegId),
    }));
    const missing = records.find((entry, index) => !entry.record && !snapshots[index]?.snapshot)?.legId || "";
    if (missing) {
      throw daemonError("invalid_leg_wait", `Leg ${missing} cannot be waited`);
    }
    const waitRecords = records.filter((entry): entry is { legId: string; record: Leg } => Boolean(entry.record));
    const waitSnapshotRecords = snapshots.filter(
      (entry): entry is { legId: string; snapshot: { legId: string; event: LegEvent } } => Boolean(entry.snapshot),
    );
    const waitTickets = waitRecords.map(({ record }) => record.retain("leg-wait"));
    try {

    const rules = Array.isArray(params.rules)
      ? params.rules
          .map((rule) => ({
            pattern: String((rule && rule.pattern) || "").trim(),
            label: String((rule && rule.label) || "").trim(),
          }))
          .filter((rule) => rule.pattern && rule.label)
      : [];
    const timeoutMs = Math.max(0, Number(params.timeoutMs || 0));
    const interdigitTimeoutMs = Math.max(0, Number(params.interdigitTimeoutMs == null ? Math.round(OPTION_DEFAULTS.call.interdigitTimeoutSeconds * 1000) : params.interdigitTimeoutMs) || 0);
    const interruptReasons = Array.isArray(params.interruptReasons)
      ? Array.from(new Set(params.interruptReasons.filter((reason): reason is CallInterruptReason => CALL_INTERRUPT_REASONS.includes(reason))))
      : [];
    const clearDtmfBuffer = Boolean(params.clearDtmfBuffer);
    const enableDtmfFallback = !!params.waitDtmfFallbackEnabled;
    const enableMultiDigitFallback = !!params.waitDtmfMultiDigitFallbackEnabled;
    const terminatorDigit = String(params.dtmfTerminatorDigit || "").trim();

    const stateByLegId = new Map<string, PerLegState>();
    for (const currentLegId of legIds) {
      stateByLegId.set(currentLegId, { digits: "", lastDigitAt: 0 });
    }

    let deadlineAtMs = nowMs() + timeoutMs;

    if (clearDtmfBuffer) {
      for (const { record } of waitRecords) {
        record.consumeQueuedEventsMatching((event) => event.eventType === CALL_EVENT_DTMF);
      }
    }

    for (const { legId: currentLegId, record } of waitRecords) {
      const immediate = record.shiftEventMatching(() => true);
      if (!immediate) {
        continue;
      }
      const state = stateByLegId.get(currentLegId)!;
      const result = this.processEvent(currentLegId, immediate, rules, {
        digits: state.digits,
        enableDtmfFallback,
        enableMultiDigitFallback,
        terminatorDigit,
        interdigitTimeoutMs,
        interruptReasons,
        allowFinalize: false,
      });
      state.digits = result.digits;
      state.lastDigitAt = result.lastDigitAt || state.lastDigitAt;
      if (result.output) {
        return result.output;
      }
      if (result.awaitingMoreDigits && interdigitTimeoutMs > 0 && state.lastDigitAt > 0) {
        deadlineAtMs = state.lastDigitAt + interdigitTimeoutMs;
      }
    }
    for (const { legId: currentLegId, snapshot } of waitSnapshotRecords) {
      const state = stateByLegId.get(currentLegId)!;
      const result = this.processEvent(currentLegId, snapshot.event, rules, {
        digits: state.digits,
        enableDtmfFallback,
        enableMultiDigitFallback,
        terminatorDigit,
        interdigitTimeoutMs,
        interruptReasons,
        allowFinalize: false,
      });
      state.digits = result.digits;
      state.lastDigitAt = result.lastDigitAt || state.lastDigitAt;
      if (result.output) {
        return result.output;
      }
      if (result.awaitingMoreDigits && interdigitTimeoutMs > 0 && state.lastDigitAt > 0) {
        deadlineAtMs = state.lastDigitAt + interdigitTimeoutMs;
      }
    }

    if (waitRecords.every(({ record }) => record.status === LEG_STATUS_ENDED)) {
      throw daemonError("invalid_leg_wait", `Leg ${legIds[0] || ""} cannot be waited`);
    }

    while (true) {
      for (const { legId: currentLegId, record } of waitRecords) {
        const queued = record.shiftEvent();
        if (!queued) {
          continue;
        }
        const state = stateByLegId.get(currentLegId)!;
        const result = this.processEvent(currentLegId, queued, rules, {
          digits: state.digits,
          enableDtmfFallback,
          enableMultiDigitFallback,
          terminatorDigit,
          interdigitTimeoutMs,
          interruptReasons,
          allowFinalize: false,
        });
        state.digits = result.digits;
        state.lastDigitAt = result.lastDigitAt || state.lastDigitAt;
        if (result.output) {
          return result.output;
        }
        if (result.awaitingMoreDigits && interdigitTimeoutMs > 0 && state.lastDigitAt > 0) {
          deadlineAtMs = state.lastDigitAt + interdigitTimeoutMs;
        }
      }

      const remainingWaitMs = Math.max(0, deadlineAtMs - nowMs());
      if (remainingWaitMs <= 0) {
        for (const { legId: currentLegId } of waitRecords) {
          const state = stateByLegId.get(currentLegId)!;
          const finalized = this.finalizeDigits(currentLegId, state.digits, rules, {
            enableDtmfFallback,
            enableMultiDigitFallback,
            terminatorDigit,
          });
          if (finalized) {
            return finalized;
          }
        }
        return timeoutOutput(legIds[0] || "");
      }

      const tickets = waitRecords.map(({ legId: currentLegId, record }) => ({
        legId: currentLegId,
        ticket: record.waitForEventCancellable(() => true, remainingWaitMs),
      }));
      try {
        const outcome = await this.waitForAnyWithCancellation(
          tickets.map(async ({ legId: currentLegId, ticket }) => ({
            legId: currentLegId,
            event: await ticket.promise,
          })),
          context,
        );
        for (const { legId: currentLegId, ticket } of tickets) {
          if (currentLegId !== outcome.legId) {
            ticket.cancel();
          }
        }
        const state = stateByLegId.get(outcome.legId)!;
        const result = this.processEvent(outcome.legId, outcome.event, rules, {
          digits: state.digits,
          enableDtmfFallback,
          enableMultiDigitFallback,
          terminatorDigit,
          interdigitTimeoutMs,
          interruptReasons,
          allowFinalize: false,
        });
        state.digits = result.digits;
        state.lastDigitAt = result.lastDigitAt || state.lastDigitAt;
        if (result.output) {
          return result.output;
        }
        if (result.awaitingMoreDigits && interdigitTimeoutMs > 0 && state.lastDigitAt > 0) {
          deadlineAtMs = state.lastDigitAt + interdigitTimeoutMs;
        }
      } catch (error) {
        for (const { legId: currentLegId, ticket } of tickets) {
          ticket.cancel();
        }
        if (this.isRequestCancelled(error)) {
          throw error;
        }
        if (!this.isWaitTimeout(error)) {
          throw error;
        }
        for (const { legId: currentLegId } of waitRecords) {
          const state = stateByLegId.get(currentLegId)!;
          const finalized = this.finalizeDigits(currentLegId, state.digits, rules, {
            enableDtmfFallback,
            enableMultiDigitFallback,
            terminatorDigit,
          });
          if (finalized) {
            return finalized;
          }
          state.digits = "";
          state.lastDigitAt = 0;
        }
        return timeoutOutput(legIds[0] || "");
      }
    }
    } finally {
      for (const ticket of waitTickets) {
        ticket.release();
      }
    }
  }

  private async waitForAnyWithCancellation<T>(
    waits: Array<Promise<T>>,
    context?: RequestContext | null,
  ): Promise<T> {
    if (!context) {
      return await Promise.race(waits);
    }
    let release = () => undefined;
    const cancelled = new Promise<T>((_resolve, reject) => {
      release = context.onCancel(() => {
        reject(daemonError("request_cancelled", "The request was cancelled"));
      });
    });
    try {
      return await Promise.race([...waits, cancelled]);
    } finally {
      release();
    }
  }

  private isRequestCancelled(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "request_cancelled");
  }

  private isWaitTimeout(error: unknown): boolean {
    return error instanceof Error && error.message === "wait_timeout";
  }

  private processEvent(
    legId: string,
    event: LegEvent,
    rules: WaitRule[],
    input: {
      digits: string;
      enableDtmfFallback: boolean;
      enableMultiDigitFallback: boolean;
      terminatorDigit: string;
      interdigitTimeoutMs: number;
      interruptReasons: CallInterruptReason[];
      allowFinalize: boolean;
    },
  ): ProcessEventResult {
    if (event.eventType === CALL_EVENT_ENDED) {
      return {
        digits: input.digits,
        output: {
          legId,
          eventType: CALL_EVENT_ENDED,
          output: CALL_WAIT_OUTPUT_ENDED,
          reason: event.reason,
          createdAt: event.createdAt,
        },
        awaitingMoreDigits: false,
      };
    }
    if (event.eventType === CALL_EVENT_INTERRUPT) {
      if (!input.interruptReasons.includes(event.reason as CallInterruptReason)) {
        return {
          digits: input.digits,
          output: null,
          awaitingMoreDigits: false,
        };
      }
      return {
        digits: input.digits,
        output: {
          legId,
          eventType: CALL_EVENT_INTERRUPT,
          output: CALL_WAIT_OUTPUT_INTERRUPT,
          reason: event.reason,
          createdAt: event.createdAt,
        },
        awaitingMoreDigits: false,
      };
    }
    if (event.eventType !== "dtmf") {
      return { digits: input.digits, output: null, awaitingMoreDigits: false };
    }

    const nextDigits = `${input.digits}${String(event.digits || "")}`;
    const exactRule = rules.find((rule) => rule.pattern === nextDigits) || null;
    const hasLongerPrefix = rules.some((rule) => rule.pattern.startsWith(nextDigits) && rule.pattern !== nextDigits);
    const hasAnyPrefix = !!exactRule || rules.some((rule) => rule.pattern.startsWith(nextDigits));
    const noWaitMode = input.interdigitTimeoutMs <= 0;

    if (exactRule && (!hasLongerPrefix || noWaitMode || input.allowFinalize)) {
      return {
        digits: nextDigits,
        output: {
          legId,
          eventType: CALL_EVENT_DTMF,
          output: CALL_WAIT_OUTPUT_MATCHED,
          digits: nextDigits,
          matchedPattern: exactRule.pattern,
          matchedLabel: exactRule.label,
          createdAt: event.createdAt,
        },
        lastDigitAt: event.createdAt,
        awaitingMoreDigits: false,
      };
    }

    if (input.enableMultiDigitFallback && input.terminatorDigit && nextDigits.endsWith(input.terminatorDigit)) {
      const strippedDigits = nextDigits.slice(0, nextDigits.length - input.terminatorDigit.length);
      const strippedRule = rules.find((rule) => rule.pattern === strippedDigits) || null;
      if (strippedRule) {
        return {
          digits: strippedDigits,
          output: {
            legId,
            eventType: CALL_EVENT_DTMF,
            output: CALL_WAIT_OUTPUT_MATCHED,
            digits: strippedDigits,
            matchedPattern: strippedRule.pattern,
            matchedLabel: strippedRule.label,
            createdAt: event.createdAt,
          },
          lastDigitAt: event.createdAt,
          awaitingMoreDigits: false,
        };
      }
      if (input.enableDtmfFallback) {
        return {
          digits: strippedDigits,
          output: {
            legId,
            eventType: CALL_EVENT_DTMF,
            output: CALL_WAIT_OUTPUT_DTMF_FALLBACK,
            digits: strippedDigits,
            terminatedBy: input.terminatorDigit,
            createdAt: event.createdAt,
          },
          lastDigitAt: event.createdAt,
          awaitingMoreDigits: false,
        };
      }
      return {
        digits: "",
        output: null,
        lastDigitAt: event.createdAt,
        awaitingMoreDigits: false,
      };
    }

    if (!hasAnyPrefix && input.enableDtmfFallback && (!input.enableMultiDigitFallback || noWaitMode || input.allowFinalize)) {
      return {
        digits: nextDigits,
        output: {
          legId,
          eventType: CALL_EVENT_DTMF,
          output: CALL_WAIT_OUTPUT_DTMF_FALLBACK,
          digits: nextDigits,
          createdAt: event.createdAt,
        },
        lastDigitAt: event.createdAt,
        awaitingMoreDigits: false,
      };
    }

    if (hasAnyPrefix || input.enableMultiDigitFallback) {
      return {
        digits: nextDigits,
        output: null,
        lastDigitAt: event.createdAt,
        awaitingMoreDigits: !noWaitMode,
      };
    }

    return {
      digits: "",
      output: null,
      awaitingMoreDigits: false,
    };
  }

  private finalizeDigits(
    legId: string,
    digits: string,
    rules: WaitRule[],
    input: {
      enableDtmfFallback: boolean;
      enableMultiDigitFallback: boolean;
      terminatorDigit: string;
    },
  ): WaitOutput | null {
    if (!digits) {
      return null;
    }
    const matchedRule = rules.find((rule) => rule.pattern === digits) || null;
    if (matchedRule) {
      return {
        legId,
        eventType: CALL_EVENT_DTMF,
        output: CALL_WAIT_OUTPUT_MATCHED,
        digits,
        matchedPattern: matchedRule.pattern,
        matchedLabel: matchedRule.label,
        createdAt: nowMs(),
      };
    }
    if (
      input.enableMultiDigitFallback
      && input.terminatorDigit
      && digits.endsWith(input.terminatorDigit)
      && digits.length > input.terminatorDigit.length
    ) {
      const strippedDigits = digits.slice(0, digits.length - input.terminatorDigit.length);
      const strippedRule = rules.find((rule) => rule.pattern === strippedDigits) || null;
      if (strippedRule) {
        return {
          legId,
          eventType: CALL_EVENT_DTMF,
          output: CALL_WAIT_OUTPUT_MATCHED,
          digits: strippedDigits,
          matchedPattern: strippedRule.pattern,
          matchedLabel: strippedRule.label,
          createdAt: nowMs(),
        };
      }
      if (input.enableDtmfFallback) {
        return {
          legId,
          eventType: CALL_EVENT_DTMF,
          output: CALL_WAIT_OUTPUT_DTMF_FALLBACK,
          digits: strippedDigits,
          terminatedBy: input.terminatorDigit,
          createdAt: nowMs(),
        };
      }
    }
    if (!input.enableDtmfFallback) {
      return null;
    }
    return {
      legId,
      eventType: CALL_EVENT_DTMF,
      output: CALL_WAIT_OUTPUT_DTMF_FALLBACK,
      digits,
      createdAt: nowMs(),
    };
  }
}
