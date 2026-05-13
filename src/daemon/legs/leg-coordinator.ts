import { AsyncLockMap } from "../core/async-lock";

/**
 * Shared per-leg lock authority. SipTransportService, WebSocketSignalingService,
 * MediaService, and the media execution plane all run their per-leg critical
 * sections through this single coordinator so that mutations of leg state
 * (signaling sessions, bridge mapping) serialize correctly across subsystems.
 *
 * Retention semantics live on the leg itself — call `leg.retain(tag)` (or
 * `legService.retainLeg(legId, tag)`) to acquire a ticket. This coordinator
 * is intentionally lock-only.
 */
export class LegCoordinator {
  private readonly locks: AsyncLockMap;

  constructor(options?: { locks?: AsyncLockMap }) {
    this.locks = options?.locks || new AsyncLockMap();
  }

  async withLeg<T>(legId: string, fn: () => Promise<T> | T): Promise<T> {
    const key = String(legId || "").trim();
    if (!key) {
      throw new Error("legId is required");
    }
    return await this.locks.runExclusive(key, fn);
  }

  async withLegs<T>(legIds: Array<string | null | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const keys: string[] = [];
    for (const value of legIds) {
      const key = String(value || "").trim();
      if (key) {
        keys.push(key);
      }
    }
    return await this.locks.runExclusiveMany(keys, fn);
  }
}
