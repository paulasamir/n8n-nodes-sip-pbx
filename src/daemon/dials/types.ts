import { EventfulRetainedEntity, type RetentionTicket } from "../core/operation-retainer";
import { newDialId } from "../core/ids";
import { nowMs } from "../core/time";
import type { MapRegistry } from "../../shared/map-registry";

import type { DialEventType, DialStatusName } from "../../shared/result-events";

export type DialStatus = DialStatusName;

export type DialEvent = {
  eventType: DialEventType;
  legId?: string;
  reason?: string;
  createdAt: number;
};

export type OpaqueDialTarget = {
  kind: "opaque";
  value: string;
};

export type ExtensionDialTarget = {
  kind: "extension";
  ref: string;
  extensionNumber: string;
  endpointId: string;
};

export type DialTarget = OpaqueDialTarget | ExtensionDialTarget;

export function toDialTarget(target: string | DialTarget): DialTarget {
  if (typeof target === "string") {
    return { kind: "opaque", value: target };
  }
  if (target && target.kind === "extension") {
    return {
      kind: "extension",
      ref: String(target.ref || "").trim(),
      extensionNumber: String(target.extensionNumber || "").trim(),
      endpointId: String(target.endpointId || "").trim(),
    };
  }
  return {
    kind: "opaque",
    value: String((target as OpaqueDialTarget)?.value || "").trim(),
  };
}

export function formatDialTarget(target: DialTarget): string {
  if (target.kind === "extension") {
    const parts = [
      "extension",
      encodeURIComponent(target.ref),
      encodeURIComponent(target.extensionNumber),
    ];
    if (target.endpointId) {
      parts.push(encodeURIComponent(target.endpointId));
    }
    return parts.join(":");
  }
  return String(target.value || "");
}

export type DialInput = {
  dialId?: string;
  strategy: "parallel" | "sequential";
  mode?: string;
  targets: Array<string | DialTarget>;
  metadata?: Record<string, unknown>;
  sequentialAttemptTimeoutMs?: number;
  sequentialGapMs?: number;
  onDestroy?: (dial: Dial, status: DialStatus, reason?: string) => Promise<void> | void;
};

const DIAL_CONSTRUCTOR_TOKEN = Symbol("Dial.constructor");

export class Dial extends EventfulRetainedEntity<DialEvent> {
  readonly dialId: string;
  readonly strategy: "parallel" | "sequential";
  mode?: string;
  targets: DialTarget[];
  pendingTargets: DialTarget[];
  metadata: Record<string, unknown>;
  createdAt: number;
  finalizedAt: number | null;
  status: DialStatus;
  attemptLegIds: string[];
  activeAttemptLegIds: string[];
  winnerLegId: string | null;
  terminalReason: string | null;
  sequentialAttemptTimeoutMs: number;
  sequentialGapMs: number;
  gapTimer: NodeJS.Timeout | null;
  attemptTimeoutTimers: Map<string, NodeJS.Timeout>;
  /**
   * Per-attempt retention tickets keyed by `legId`. Each ticket represents the
   * dial's ownership of its attempt leg — released when ownership is dropped
   * (winner becomes finalized, attempt rejected/failed, or dial torn down).
   */
  private readonly attemptRetentions = new Map<string, RetentionTicket>();
  private readonly onDestroyHandler?: (dial: Dial, status: DialStatus, reason?: string) => Promise<void> | void;

  private constructor(input: DialInput, token: symbol) {
    super(64);
    if (token !== DIAL_CONSTRUCTOR_TOKEN) {
      throw new Error("Dial must be created via Dial.create()");
    }
    this.dialId = String(input.dialId || "").trim();
    this.strategy = input.strategy;
    this.mode = input.mode;
    this.targets = input.targets.map((target) => toDialTarget(target));
    this.pendingTargets = this.targets.slice();
    this.metadata = { ...(input.metadata || {}) };
    this.createdAt = nowMs();
    this.finalizedAt = null;
    this.status = "dialing";
    this.attemptLegIds = [];
    this.activeAttemptLegIds = [];
    this.winnerLegId = null;
    this.terminalReason = null;
    this.sequentialAttemptTimeoutMs = Number(input.sequentialAttemptTimeoutMs || 0);
    this.sequentialGapMs = Number(input.sequentialGapMs || 0);
    this.gapTimer = null;
    this.attemptTimeoutTimers = new Map<string, NodeJS.Timeout>();
    this.onDestroyHandler = input.onDestroy;
  }

  static create(registry: MapRegistry<string, Dial>, input: DialInput): Dial {
    const dial = new Dial({
      ...input,
      dialId: String(input.dialId || newDialId()).trim(),
    }, DIAL_CONSTRUCTOR_TOKEN);
    registry.store(dial.dialId, dial);
    dial.bindRegistryDetach(() => {
      registry.remove(dial.dialId);
    });
    return dial;
  }

  markFinalized(status: DialStatus): this {
    this.status = status;
    this.finalizedAt = nowMs();
    return this;
  }

  addAttemptLeg(legId: string, retention: RetentionTicket): this {
    this.attemptLegIds.push(legId);
    this.activeAttemptLegIds.push(legId);
    this.attemptRetentions.set(legId, retention);
    console.error(
      `[sip-pbx:dial] attempt added; dial=${this.dialId}; leg=${legId}; activeAttempts=${this.activeAttemptLegIds.length}; totalAttempts=${this.attemptLegIds.length}; pendingTargets=${this.pendingTargets.length}`,
    );
    return this;
  }

  hasActiveAttempt(legId: string): boolean {
    return this.activeAttemptLegIds.includes(legId);
  }

  /**
   * Release the retention ticket for the given attempt leg, if any. Returns
   * the ticket that was released (or null if none was registered) — useful for
   * tests/diagnostics. Idempotent: a second call for the same legId is a no-op.
   */
  releaseAttemptRetention(legId: string): RetentionTicket | null {
    const ticket = this.attemptRetentions.get(legId) || null;
    if (!ticket) {
      return null;
    }
    this.attemptRetentions.delete(legId);
    ticket.release();
    return ticket;
  }

  releaseAttemptOwnership(legId: string): boolean {
    if (!this.attemptLegIds.includes(legId)) {
      return false;
    }
    this.activeAttemptLegIds = this.activeAttemptLegIds.filter((attemptLegId) => attemptLegId !== legId);
    console.error(
      `[sip-pbx:dial] attempt released; dial=${this.dialId}; leg=${legId}; activeAttempts=${this.activeAttemptLegIds.length}; finalized=${Boolean(this.finalizedAt)}; pendingTargets=${this.pendingTargets.length}; status=${this.status}`,
    );
    return true;
  }

  clearAttemptTimeout(legId: string): void {
    const handle = this.attemptTimeoutTimers.get(legId);
    if (!handle) {
      return;
    }
    clearTimeout(handle);
    this.attemptTimeoutTimers.delete(legId);
  }

  clearGapTimer(): void {
    if (!this.gapTimer) {
      return;
    }
    clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }

  clearTimers(): void {
    this.clearGapTimer();
    for (const [legId, handle] of Array.from(this.attemptTimeoutTimers.entries())) {
      clearTimeout(handle);
      this.attemptTimeoutTimers.delete(legId);
    }
  }

  destroy(status: DialStatus, reason?: string): Promise<void> {
    return this.runDestroyOnce(() => {
      this.clearTimers();
      if (!this.finalizedAt) {
        this.markFinalized(status);
      }
      this.terminalReason = reason || null;
      if (!this.onDestroyHandler) {
        throw new Error(`Dial destroy handler is not bound for ${this.dialId}`);
      }
      const outcome = this.onDestroyHandler(this, status, reason);
      if (outcome && typeof (outcome as Promise<void>).then === "function") {
        return Promise.resolve(outcome).finally(() => {
          this.detachFromRegistry();
        });
      }
      this.detachFromRegistry();
      return outcome;
    });
  }

  protected override onFreeTtl(): void {
    void this.destroy("failed", "free_ttl");
  }
}
