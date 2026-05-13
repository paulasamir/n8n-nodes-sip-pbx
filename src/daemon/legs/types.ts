import { EventfulRetainedEntity } from "../core/operation-retainer";
import { newLegId } from "../core/ids";
import { nowMs } from "../core/time";
import type { MapRegistry } from "../../shared/map-registry";
import {
  LEG_STATUS_ENDED,
  type CALL_EVENT_DTMF,
  type CALL_EVENT_ENDED,
  type CALL_EVENT_INTERRUPT,
  type LegStatusName,
} from "../../shared/result-events";

export type LegStatus = LegStatusName;

export type LegEvent =
  | { eventType: typeof CALL_EVENT_DTMF; digits: string; createdAt: number }
  | { eventType: typeof CALL_EVENT_INTERRUPT; reason: string; createdAt: number }
  | { eventType: typeof CALL_EVENT_ENDED; reason: string; createdAt: number };

export type LegInput = {
  legId?: string;
  direction: "inbound" | "outbound";
  transportType: "sip" | "websocket";
  signalingDetails?: Record<string, unknown>;
  mediaDetails?: Record<string, unknown>;
  triggerMetadata?: Record<string, unknown>;
  onDestroy?: (leg: Leg, reason: string) => Promise<void> | void;
};

const LEG_CONSTRUCTOR_TOKEN = Symbol("Leg.constructor");

export class Leg extends EventfulRetainedEntity<LegEvent> {
  readonly legId: string;
  readonly direction: "inbound" | "outbound";
  status: LegStatus;
  readonly transportType: "sip" | "websocket";
  bridgePeerLegId?: string;
  bridgeRelayDtmf?: string;
  bridgeEmitDtmfEvents?: boolean;
  signalingDetails: Record<string, unknown>;
  mediaDetails: Record<string, unknown>;
  triggerMetadata: Record<string, unknown>;
  finalizedAt: number | null;
  private readonly onDestroyHandler?: (leg: Leg, reason: string) => Promise<void> | void;

  private constructor(input: LegInput, token: symbol) {
    super(128);
    if (token !== LEG_CONSTRUCTOR_TOKEN) {
      throw new Error("Leg must be created via Leg.create()");
    }
    this.legId = String(input.legId || "").trim();
    this.direction = input.direction;
    this.status = "created";
    this.transportType = input.transportType;
    this.signalingDetails = input.signalingDetails || {};
    this.mediaDetails = input.mediaDetails || {};
    this.triggerMetadata = input.triggerMetadata || {};
    this.finalizedAt = null;
    this.onDestroyHandler = input.onDestroy;
  }

  static create(registry: MapRegistry<string, Leg>, input: LegInput): Leg {
    const leg = new Leg({
      ...input,
      legId: String(input.legId || newLegId()).trim(),
    }, LEG_CONSTRUCTOR_TOKEN);
    registry.store(leg.legId, leg);
    leg.bindRegistryDetach(() => {
      registry.remove(leg.legId);
    });
    return leg;
  }

  updateStatus(status: LegStatus): this {
    this.status = status;
    return this;
  }

  updateMediaDetails(details: Record<string, unknown>): this {
    this.mediaDetails = { ...(details || {}) };
    return this;
  }

  updateBridgeState(
    bridgeState: { peerLegId: string; relayDtmf: string; emitDtmfEvents: boolean } | null,
  ): this {
    if (!bridgeState) {
      delete this.bridgePeerLegId;
      delete this.bridgeRelayDtmf;
      delete this.bridgeEmitDtmfEvents;
      return this;
    }
    this.bridgePeerLegId = bridgeState.peerLegId;
    this.bridgeRelayDtmf = bridgeState.relayDtmf;
    this.bridgeEmitDtmfEvents = bridgeState.emitDtmfEvents;
    return this;
  }

  updateSignalingDetails(details: Record<string, unknown>): this {
    this.signalingDetails = { ...(details || {}) };
    return this;
  }

  end(reason?: string): this {
    if (this.status === LEG_STATUS_ENDED) {
      return this;
    }
    this.status = "ended";
    this.finalizedAt = nowMs();
    return this;
  }

  destroy(reason: string): Promise<void> {
    return this.runDestroyOnce(() => {
      this.end(reason);
      if (!this.onDestroyHandler) {
        throw new Error(`Leg destroy handler is not bound for ${this.legId}`);
      }
      const outcome = this.onDestroyHandler(this, reason);
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
    void this.destroy("free_ttl");
  }
}
