import { BoundedEventQueue } from "./bounded-event-queue";
import { EventWaiterSet, type CancellableWait } from "./event-waiter-set";

/** Base for entities with explicit lifecycle (no retention/TTL): event queue + idempotent destroy + registry detach. */
export abstract class EventfulDestroyable<TEvent> {
  private readonly events: BoundedEventQueue<TEvent>;
  private readonly waiters = new EventWaiterSet<TEvent>();
  private destroyPromise: Promise<unknown> | null = null;
  private registryDetach: (() => void) | null = null;

  protected constructor(eventQueueLimit: number) {
    this.events = new BoundedEventQueue<TEvent>(eventQueueLimit);
  }

  publishEvent(event: TEvent): void {
    if (!this.waiters.publish(event)) {
      this.events.push(event);
    }
  }

  shiftEvent(): TEvent | null {
    return this.events.shift();
  }

  shiftEventMatching(predicate: (event: TEvent) => boolean): TEvent | null {
    return this.events.shiftMatching(predicate);
  }

  peekQueuedEventMatching(predicate: (event: TEvent) => boolean): TEvent | null {
    return this.events.peekMatching(predicate);
  }

  consumeQueuedEventsMatching(predicate: (event: TEvent) => boolean): number {
    return this.events.consumeMatching(predicate);
  }

  waitForEvent(predicate: (event: TEvent) => boolean, timeoutMs: number): Promise<TEvent> {
    return this.waiters.waitFor(predicate, timeoutMs);
  }

  waitForEventCancellable(predicate: (event: TEvent) => boolean, timeoutMs: number): CancellableWait<TEvent> {
    return this.waiters.waitForCancellable(predicate, timeoutMs);
  }

  rejectEventWaiters(error: unknown): void {
    this.waiters.rejectAll(error);
  }

  bindRegistryDetach(detach: () => void): void {
    this.registryDetach = detach;
  }

  protected detachFromRegistry(): void {
    const detach = this.registryDetach;
    this.registryDetach = null;
    detach?.();
  }

  protected runDestroyOnce<T>(executor: () => Promise<T> | T): Promise<T> {
    if (this.destroyPromise) {
      return this.destroyPromise as Promise<T>;
    }
    const destroyPromise = Promise.resolve(executor());
    this.destroyPromise = destroyPromise;
    return destroyPromise;
  }
}
