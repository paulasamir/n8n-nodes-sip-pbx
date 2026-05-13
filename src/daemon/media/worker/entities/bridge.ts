import { Leg } from "./leg";

export class Bridge {
  private readonly legsById = new Map<string, Leg>();

  constructor(input?: { legA?: Leg | null; legB?: Leg | null }) {
    if (input?.legA) {
      this.attachLeg(input.legA);
    }
    if (input?.legB) {
      this.attachLeg(input.legB);
    }
  }

  attachLeg(leg: Leg): void {
    if (this.legsById.has(leg.legId)) {
      return;
    }
    if (this.legsById.size >= 2) {
      throw new Error("Bridge cannot own more than two legs");
    }
    this.legsById.set(leg.legId, leg);
    leg.bridge = this;
  }

  detachLeg(legId: string): Leg | null {
    const leg = this.legsById.get(legId) || null;
    if (!leg) {
      return null;
    }
    this.legsById.delete(legId);
    if (leg.bridge === this) {
      leg.bridge = null;
    }
    return leg;
  }

  getLeg(legId: string): Leg | null {
    return this.legsById.get(legId) || null;
  }

  listLegs(): Leg[] {
    return Array.from(this.legsById.values());
  }

  listLegIds(): string[] {
    return Array.from(this.legsById.keys());
  }

  size(): number {
    return this.legsById.size;
  }

  getPeerLeg(sourceLegId: string): Leg | null {
    if (!this.legsById.has(sourceLegId)) {
      return null;
    }
    for (const [legId, leg] of Array.from(this.legsById.entries())) {
      if (legId !== sourceLegId) {
        return leg;
      }
    }
    return null;
  }

  async routeInboundPcm(
    sourceLegId: string,
    pcm: Buffer,
    bytes = pcm.length,
    sampleRate?: number,
    channels?: number,
  ): Promise<boolean> {
    const normalizedBytes = Math.max(0, Math.min(Number(bytes) || 0, pcm.length));
    if (!normalizedBytes) {
      return false;
    }
    const peer = this.getPeerLeg(sourceLegId);
    if (!peer) {
      return false;
    }
    return await peer.sendBridgePcm(
      pcm,
      normalizedBytes,
      Number(sampleRate || 0) || undefined,
      Number(channels || 0) || undefined,
    );
  }
}
