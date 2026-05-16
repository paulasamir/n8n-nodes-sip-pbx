import { daemonError } from "../core/daemon-error";
import { combineTickets, type RetentionTicket } from "../core/operation-retainer";
import { TerminalSnapshotStore } from "../core/terminal-snapshot-store";
import { nowMs } from "../core/time";
import { MapRegistry } from "../../shared/map-registry";
import { CALL_EVENT_DTMF, CALL_EVENT_ENDED, CALL_EVENT_INTERRUPT, LEG_STATUS_ENDED } from "../../shared/result-events";
import { Leg, type LegEvent, type LegInput, type LegStatus } from "./types";

export class LegService {
  private readonly registry: MapRegistry<string, Leg>;
  private readonly terminalSnapshots: TerminalSnapshotStore<{ legId: string; event: LegEvent }>;
  private onLegEnded: (leg: Leg, reason: string) => Promise<void> | void;

  constructor(
    registry: MapRegistry<string, Leg>,
    onLegEnded?: (leg: Leg, reason: string) => Promise<void> | void,
    terminalSnapshots?: TerminalSnapshotStore<{ legId: string; event: LegEvent }>,
  ) {
    this.registry = registry;
    this.terminalSnapshots = terminalSnapshots || new TerminalSnapshotStore<{ legId: string; event: LegEvent }>();
    this.onLegEnded = onLegEnded || (() => undefined);
  }

  setOnLegEnded(onLegEnded: (leg: Leg, reason: string) => Promise<void> | void): void {
    this.onLegEnded = onLegEnded;
  }

  createLeg(input: LegInput): Leg {
    return Leg.create(this.registry, {
      ...input,
      onDestroy: this.handleLegDestroy.bind(this),
    });
  }

  getLeg(legId: string): Leg | null {
    return this.registry.get(legId);
  }

  listLegs(): Leg[] {
    return this.registry.values();
  }

  requireLeg(legId: string): Leg {
    const leg = this.getLeg(legId);
    if (!leg) {
      throw daemonError("invalid_leg", `Unknown leg ${legId}`);
    }
    return leg;
  }

  /** Convenience: acquire a retention ticket on the leg identified by `legId`. */
  retainLeg(legId: string, tag: string): RetentionTicket {
    return this.requireLeg(legId).retain(tag);
  }

  /**
   * Acquire retention on several legs atomically. If any retain throws, all
   * previously-acquired tickets are released before re-throwing. The returned
   * combined ticket releases every leg in one call.
   */
  retainLegs(legIds: string[], tag: string): RetentionTicket {
    const tickets: RetentionTicket[] = [];
    try {
      for (const legId of legIds) {
        tickets.push(this.retainLeg(legId, tag));
      }
    } catch (error) {
      for (const ticket of tickets) {
        ticket.release();
      }
      throw error;
    }
    return combineTickets(tickets, tag);
  }

  updateStatus(legId: string, status: LegStatus): Leg {
    const leg = this.requireLeg(legId);
    return leg.updateStatus(status);
  }

  updateMediaDetails(legId: string, details: Record<string, unknown>): Leg {
    const leg = this.requireLeg(legId);
    return leg.updateMediaDetails(details);
  }

  updateBridgeState(
    legId: string,
    bridgeState: { peerLegId: string; relayDtmf: string; emitDtmfEvents: boolean } | null,
  ): Leg {
    const leg = this.requireLeg(legId);
    return leg.updateBridgeState(bridgeState);
  }

  updateSignalingDetails(legId: string, details: Record<string, unknown>): Leg {
    const leg = this.requireLeg(legId);
    return leg.updateSignalingDetails(details);
  }

  publishDtmf(legId: string, digits: string): void {
    this.requireLeg(legId).publishEvent({
      eventType: CALL_EVENT_DTMF,
      digits,
      createdAt: nowMs(),
    });
  }

  publishInterrupt(legId: string, reason: string): void {
    this.requireLeg(legId).publishEvent({
      eventType: CALL_EVENT_INTERRUPT,
      reason,
      createdAt: nowMs(),
    });
  }

  hangupLeg(legId: string, reason: string): { legId: string } {
    const leg = this.registry.get(legId);
    if (!leg) {
      throw daemonError("invalid_leg", `Unknown leg ${legId}`);
    }
    if (leg.status === LEG_STATUS_ENDED) {
      return { legId };
    }
    console.error(
      `[sip-pbx:leg] hangup; leg=${legId}; transportType=${leg.transportType}; direction=${leg.direction}; status=${leg.status}; reason=${String(reason || "hangup")}`,
    );
    void leg.destroy(reason).catch((error) => {
      console.error(
        `[sip-pbx:leg] leg finalization failed; leg=${legId}; reason=${reason}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    });
    return { legId };
  }

  private async handleLegDestroy(leg: Leg, reason: string): Promise<void> {
    const event: LegEvent = {
      eventType: CALL_EVENT_ENDED,
      reason,
      createdAt: leg.finalizedAt || nowMs(),
    };
    this.terminalSnapshots.remember(leg.legId, {
      legId: leg.legId,
      event,
    });
    leg.publishEvent(event);
    leg.rejectEventWaiters(new Error("leg_finalized"));
    try {
      await Promise.resolve(this.onLegEnded(leg, reason));
    } catch (error) {
      console.error(
        `[sip-pbx:leg] onLegEnded failed; leg=${leg.legId}; reason=${reason}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
  }
}
