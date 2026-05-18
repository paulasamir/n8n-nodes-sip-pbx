import type { RetentionTicket } from "../core/operation-retainer";
import { nowMs } from "../core/time";

export type QueueEntryMode = "live" | "callback";

export type QueueEntryState =
  | "idle"
  | "dispatching"
  | "ended";

export type QueueTriggerConfig = {
  ref: string;
  publicRef: string;
  workflowScopeKey: string;
  queueExtensions: string[];
};

export type QueueEntryDialConfig = {
  callStrategy: "parallel" | "sequential";
  callerNumber: string;
  callerName: string;
  customSipHeaders: Array<{ name: string; value: string }>;
  extensionOnlyFreeEndpoints: boolean;
  sequentialAttemptTimeoutSeconds: number;
  sequentialGapSeconds: number;
};

export type QueueEntryInput = {
  queueEntryId: string;
  ref: string;
  legId: string;
  workflowScopeKey: string;
  trunkRef: string;
  retryAttempts: number;
  retryPauseMs: number;
  queueDialConfig: QueueEntryDialConfig;
  retention: RetentionTicket;
};

export class QueueEntry {
  readonly queueEntryId: string;
  readonly ref: string;
  readonly workflowScopeKey: string;
  readonly queueDialConfig: QueueEntryDialConfig;
  readonly createdAt: number;
  readonly trunkRef: string;

  legId: string;
  mode: QueueEntryMode;
  state: QueueEntryState;
  callbackEnabled: boolean;
  dispatchedDialId: string | null;
  reservedExtensions: readonly string[];
  retryNotBeforeAt: number;
  retryCount: number;
  /** Retry budget excluding the initial dispatch — 0 means Offline fires on the first failure. */
  retryAttempts: number;
  retryPauseMs: number;
  placedPublished: boolean;
  retention: RetentionTicket | null;
  updatedAt: number;

  constructor(input: QueueEntryInput) {
    this.queueEntryId = input.queueEntryId;
    this.ref = input.ref;
    this.legId = input.legId;
    this.workflowScopeKey = input.workflowScopeKey;
    this.trunkRef = input.trunkRef;
    this.queueDialConfig = input.queueDialConfig;
    this.createdAt = nowMs();

    this.mode = "live";
    this.state = "idle";
    this.callbackEnabled = false;
    this.dispatchedDialId = null;
    this.reservedExtensions = [];
    this.retryNotBeforeAt = 0;
    this.retryCount = 0;
    this.retryAttempts = input.retryAttempts;
    this.retryPauseMs = input.retryPauseMs;
    this.placedPublished = false;
    this.retention = input.retention;
    this.updatedAt = this.createdAt;
  }

  isDispatching(): boolean {
    return this.state === "dispatching";
  }

  isEnded(): boolean {
    return this.state === "ended";
  }

  toDispatching(dialId: string, reservedExtensions: readonly string[]): void {
    this.state = "dispatching";
    this.dispatchedDialId = dialId;
    this.reservedExtensions = reservedExtensions.slice();
    this.retryNotBeforeAt = 0;
    this.updatedAt = nowMs();
  }

  toIdle(): void {
    this.state = "idle";
    this.dispatchedDialId = null;
    this.reservedExtensions = [];
    this.updatedAt = nowMs();
  }

  toCallback(): void {
    this.mode = "callback";
    this.state = "idle";
    this.dispatchedDialId = null;
    this.reservedExtensions = [];
    this.retention?.release();
    this.retention = null;
    this.updatedAt = nowMs();
  }

  toRejoined(legId: string, retention: RetentionTicket): void {
    this.retention?.release();
    this.retention = retention;
    this.legId = legId;
    this.mode = "live";
    this.state = "idle";
    this.dispatchedDialId = null;
    this.reservedExtensions = [];
    this.retryNotBeforeAt = 0;
    this.retryCount = 0;
    this.placedPublished = false;
    this.updatedAt = nowMs();
  }

  toEnded(): void {
    this.state = "ended";
    this.dispatchedDialId = null;
    this.reservedExtensions = [];
    this.retention?.release();
    this.retention = null;
    this.updatedAt = nowMs();
  }
}
