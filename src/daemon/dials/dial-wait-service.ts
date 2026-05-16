import { daemonError } from "../core/daemon-error";
import type { RequestContext } from "../core/request-context";
import { nowMs } from "../core/time";
import { MapRegistry } from "../../shared/map-registry";
import {
  DIAL_EVENT_ANSWERED,
  DIAL_EVENT_FAILED,
  DIAL_EVENT_TIMEOUT,
  DIAL_STATUS_ANSWERED,
  DIAL_WAIT_SELECTIONS,
  type DialWaitSelection,
} from "../../shared/result-events";
import { normalizeStringList } from "../../shared/string-utils";
import { TerminalSnapshotStore } from "../core/terminal-snapshot-store";
import type { Dial, DialEvent } from "./types";

export class DialWaitService {
  private readonly registry: MapRegistry<string, Dial>;
  private readonly terminalSnapshots: TerminalSnapshotStore<DialEvent & { dialId: string }>;

  constructor(
    registry: MapRegistry<string, Dial>,
    terminalSnapshots?: TerminalSnapshotStore<DialEvent & { dialId: string }>,
  ) {
    this.registry = registry;
    this.terminalSnapshots = terminalSnapshots || new TerminalSnapshotStore<DialEvent & { dialId: string }>();
  }

  async waitForEvent(
    dialId: string | string[],
    input: number | { timeoutMs: number; waitEventOutputs?: string[] },
    context?: RequestContext | null,
  ): Promise<DialEvent & { dialId: string; stillDialingLegCount: number }> {
    const dialIds = Array.from(new Set(normalizeStringList(dialId)));
    const snapshots = dialIds.map((currentDialId) => ({
      dialId: currentDialId,
      snapshot: this.terminalSnapshots.get(currentDialId),
    }));
    const records = dialIds.map((currentDialId) => ({
      dialId: currentDialId,
      record: this.registry.get(currentDialId),
    }));
    const missing = records.find((entry, index) => !entry.record && !snapshots[index]?.snapshot)?.dialId || "";
    if (missing || records.length === 0) {
      throw daemonError("invalid_dial_wait", `Dial ${missing || String(dialId || "")} cannot be waited`);
    }
    const waitRecords = records.filter((entry): entry is { dialId: string; record: Dial } => Boolean(entry.record));
    const waitSnapshotRecords = snapshots.filter(
      (entry): entry is { dialId: string; snapshot: DialEvent & { dialId: string } } => Boolean(entry.snapshot),
    );
    const waitTickets = waitRecords.map(({ record }) => record.retain("dial-wait"));
    try {
      console.error(`[sip-pbx:dial-wait] begin; dialIds=${dialIds.join(",")}; timeoutMs=${timeoutMsValue(input)}; waitOutputs=${Array.from(enabledOutputNames(input)).join(",") || "none"}`);

      const timeoutMs = timeoutMsValue(input);
      const enabledOutputs = new Set<DialWaitSelection>(
        Array.isArray(typeof input === "number" ? [] : input.waitEventOutputs)
          ? ((typeof input === "number" ? [] : input.waitEventOutputs) as string[])
            .filter((value): value is DialWaitSelection => (DIAL_WAIT_SELECTIONS as readonly string[]).includes(String(value || "")))
          : [],
      );
      const matches = (event: DialEvent): boolean => {
        if (event.eventType === DIAL_EVENT_ANSWERED || event.eventType === DIAL_EVENT_FAILED || event.eventType === DIAL_EVENT_TIMEOUT) {
          return true;
        }
        return enabledOutputs.has(event.eventType as DialWaitSelection);
      };

      for (const { dialId: currentDialId, record } of waitRecords) {
        const existing = record.shiftEventMatching(matches);
        if (existing) {
          console.error(`[sip-pbx:dial-wait] immediate queued hit; dial=${currentDialId}; event=${existing.eventType}; reason=${String(existing.reason || "") || "none"}`);
          return {
            dialId: currentDialId,
            ...existing,
            stillDialingLegCount: stillDialingCount(record),
          };
        }
      }
      for (const { dialId: currentDialId, snapshot } of waitSnapshotRecords) {
        if (!matches(snapshot)) {
          continue;
        }
        console.error(`[sip-pbx:dial-wait] terminal snapshot hit; dial=${currentDialId}; event=${snapshot.eventType}; reason=${String(snapshot.reason || "") || "none"}`);
        return {
          dialId: currentDialId,
          ...snapshot,
          stillDialingLegCount: 0,
        };
      }

      const tickets = waitRecords.map(({ dialId: currentDialId, record }) => ({
        dialId: currentDialId,
        record,
        ticket: record.waitForEventCancellable(matches, timeoutMs),
      }));
      for (const { dialId: currentDialId, record, ticket } of tickets) {
        const queued = record.shiftEventMatching(matches);
        if (queued) {
          for (const { ticket: currentTicket } of tickets) {
            currentTicket.cancel();
          }
          console.error(`[sip-pbx:dial-wait] post-register queued hit; dial=${currentDialId}; event=${queued.eventType}; reason=${String(queued.reason || "") || "none"}`);
          return {
            dialId: currentDialId,
            ...queued,
            stillDialingLegCount: stillDialingCount(record),
          };
        }
      }
      try {
        const outcome = await this.waitForAnyWithCancellation(
          tickets.map(async ({ dialId: currentDialId, record, ticket }) => ({
            dialId: currentDialId,
            record,
            event: await ticket.promise,
          })),
          context,
        );
        for (const { dialId: currentDialId, ticket } of tickets) {
          if (currentDialId !== outcome.dialId) {
            ticket.cancel();
          }
        }
        console.error(`[sip-pbx:dial-wait] waiter resolved; dial=${outcome.dialId}; event=${outcome.event.eventType}; reason=${String(outcome.event.reason || "") || "none"}; stillDialing=${stillDialingCount(outcome.record)}`);
        return {
          dialId: outcome.dialId,
          ...outcome.event,
          stillDialingLegCount: stillDialingCount(outcome.record),
        };
      } catch (error) {
        for (const { ticket } of tickets) {
          ticket.cancel();
        }
        if (this.isRequestCancelled(error)) {
          throw error;
        }
        if (this.isWaitTimeout(error)) {
          console.error(
            `[sip-pbx:dial-wait] timeout; dialIds=${dialIds.join(",")}; stillDialing=${stillDialingCount(waitRecords[0]?.record || null)}; finalized=${Boolean(waitRecords[0]?.record.finalizedAt)}`,
          );
          return {
            dialId: dialIds[0] || "",
            eventType: DIAL_EVENT_TIMEOUT,
            createdAt: nowMs(),
            stillDialingLegCount: stillDialingCount(waitRecords[0]?.record || null),
          };
        }
        throw error;
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
    return Boolean(error instanceof Error && error.message === "wait_timeout");
  }
}

function stillDialingCount(dial: { activeAttemptLegIds: string[]; status?: string; winnerLegId?: string | null } | null): number {
  if (!dial) {
    return 0;
  }
  if (dial.status === DIAL_STATUS_ANSWERED && dial.winnerLegId) {
    return dial.activeAttemptLegIds.filter((legId) => legId !== dial.winnerLegId).length;
  }
  return dial.activeAttemptLegIds.length;
}

function timeoutMsValue(input: number | { timeoutMs: number; waitEventOutputs?: string[] }): number {
  return typeof input === "number" ? input : Number(input.timeoutMs || 0);
}

function enabledOutputNames(input: number | { timeoutMs: number; waitEventOutputs?: string[] }): DialWaitSelection[] {
  return Array.isArray(typeof input === "number" ? [] : input.waitEventOutputs)
    ? ((typeof input === "number" ? [] : input.waitEventOutputs) as string[])
      .filter((value): value is DialWaitSelection => (DIAL_WAIT_SELECTIONS as readonly string[]).includes(String(value || "")))
    : [];
}
