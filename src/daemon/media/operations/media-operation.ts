import { daemonError } from "../../core/daemon-error";
import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import { EventfulDestroyable } from "../../core/eventful-destroyable";
import { nowMs } from "../../core/time";
import { MapRegistry } from "../../../shared/map-registry";
import type { MediaEventType } from "../../../shared/result-events";

export type MediaStatus = MediaEventType;

export type MediaOperationKind = "playback" | "tone" | "recording";

export type MediaExecutionMode = "background" | "blocking";

export type MediaOperationOptions = Record<string, unknown>;

export type MediaEvent = {
  mediaId: string;
  legId: string;
  eventType: MediaStatus;
  createdAt: number;
  [key: string]: unknown;
};

type MediaOperationInput = {
  mediaId: string;
  legId: string;
  kind: MediaOperationKind;
  options?: MediaOperationOptions;
  onDestroy?: (
    operation: MediaOperation,
    status: MediaStatus,
    result: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

export const MEDIA_OPERATION_CONSTRUCTOR_TOKEN = Symbol("MediaOperation.constructor");

export abstract class MediaOperation extends EventfulDestroyable<MediaEvent> {
  readonly mediaId: string;
  readonly legId: string;
  readonly kind: MediaOperationKind;
  readonly options: MediaOperationOptions;
  status: MediaStatus = "started";
  finalized = false;
  createdAt: number;
  finalizedAt: number | null = null;
  result: Record<string, unknown> = {};
  completionTimer: NodeJS.Timeout | null = null;
  private readonly onDestroyHandler?: (
    operation: MediaOperation,
    status: MediaStatus,
    result: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;

  protected constructor(input: MediaOperationInput, token: symbol) {
    super(32);
    if (token !== MEDIA_OPERATION_CONSTRUCTOR_TOKEN) {
      throw new Error("MediaOperation must be created via subclass static create()");
    }
    this.mediaId = String(input.mediaId || "").trim();
    this.legId = String(input.legId || "").trim();
    this.kind = input.kind;
    this.options = { ...(input.options || {}) };
    this.createdAt = nowMs();
    this.onDestroyHandler = input.onDestroy;
  }

  get executionMode(): MediaExecutionMode {
    return String(this.options.mediaExecutionMode || OPTION_DEFAULTS.mediaExecution.mode) === "background"
      ? "background"
      : OPTION_DEFAULTS.mediaExecution.mode;
  }

  isBackground(): boolean {
    return this.executionMode === "background";
  }

  destroy(status: MediaStatus, result: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.runDestroyOnce(() => {
      if (!this.onDestroyHandler) {
        throw new Error(`Media destroy handler is not bound for ${this.mediaId}`);
      }
      const outcome = this.onDestroyHandler(this, status, result);
      if (outcome && typeof (outcome as Promise<Record<string, unknown>>).then === "function") {
        return Promise.resolve(outcome).finally(() => {
          this.detachFromRegistry();
        });
      }
      this.detachFromRegistry();
      return outcome;
    });
  }
}
export function requireMediaOperation(
  registry: MapRegistry<string, MediaOperation>,
  mediaId: string,
): MediaOperation {
  const operation = registry.get(mediaId);
  if (!operation) {
    throw daemonError("invalid_media", `Unknown media ${mediaId}`);
  }
  return operation;
}
