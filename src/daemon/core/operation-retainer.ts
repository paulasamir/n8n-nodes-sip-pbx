import { EventfulDestroyable } from "./eventful-destroyable";
import { getDefaultFreeTtlMs } from "./time";

/** Acquired via `entity.retain(tag)`. Owner MUST call `release()` exactly once; the call is idempotent. */
export interface RetentionTicket {
  readonly tag: string;
  release(): void;
}

interface RetentionTicketInternal extends RetentionTicket {
  released: boolean;
}

/** Wraps several tickets so they release atomically (e.g. both legs of a bridge). */
export function combineTickets(tickets: RetentionTicket[], tag = "combined"): RetentionTicket {
  let released = false;
  return {
    tag,
    release(): void {
      if (released) {
        return;
      }
      released = true;
      for (const ticket of tickets) {
        ticket.release();
      }
    },
  };
}

/**
 * Eventful entity with refcounted retention + free-TTL safety net: when the
 * last ticket is released and no owner re-acquires within TTL, `onFreeTtl()`
 * fires. For resources without idle phases, use `EventfulDestroyable` directly.
 */
export abstract class EventfulRetainedEntity<TEvent> extends EventfulDestroyable<TEvent> {
  private activeOperationCount = 0;
  private freeTimer: NodeJS.Timeout | null = null;
  private readonly ttlMs = Math.max(1, Math.floor(Number(getDefaultFreeTtlMs())));
  private retentionGeneration = 0;
  private cleared = false;
  private readonly activeTickets = new Set<RetentionTicketInternal>();

  protected constructor(eventQueueLimit: number) {
    super(eventQueueLimit);
    // Start with an armed free TTL so unowned entities don't leak.
    this.opEnd();
  }

  retain(tag: string): RetentionTicket {
    this.opBegin();
    const ticket: RetentionTicketInternal = {
      released: false,
      tag,
      release: () => {
        if (ticket.released) {
          return;
        }
        ticket.released = true;
        this.activeTickets.delete(ticket);
        this.opEnd();
      },
    };
    this.activeTickets.add(ticket);
    return ticket;
  }

  describeRetentions(): Array<{ tag: string }> {
    return Array.from(this.activeTickets).map((ticket) => ({ tag: ticket.tag }));
  }

  private opBegin(): void {
    if (this.cleared) {
      return;
    }
    this.retentionGeneration += 1;
    if (this.freeTimer) {
      clearTimeout(this.freeTimer);
      this.freeTimer = null;
    }
    this.activeOperationCount += 1;
  }

  private opEnd(): void {
    if (this.cleared) {
      return;
    }
    this.activeOperationCount = Math.max(0, this.activeOperationCount - 1);
    if (this.activeOperationCount > 0) {
      return;
    }
    if (this.freeTimer) {
      clearTimeout(this.freeTimer);
    }
    const generation = ++this.retentionGeneration;
    this.freeTimer = setTimeout(() => {
      this.freeTimer = null;
      if (generation !== this.retentionGeneration) {
        return;
      }
      this.onFreeTtl();
    }, this.ttlMs);
    // The free-TTL must not keep the process alive when no real work is pending.
    this.freeTimer.unref?.();
  }

  private clearRetention(): void {
    this.cleared = true;
    this.retentionGeneration += 1;
    this.activeOperationCount = 0;
    if (this.freeTimer) {
      clearTimeout(this.freeTimer);
      this.freeTimer = null;
    }
  }

  protected override runDestroyOnce<T>(executor: () => Promise<T> | T): Promise<T> {
    this.clearRetention();
    return super.runDestroyOnce(executor);
  }

  /** Fires when free-TTL expires; subclass must trigger its own destroy path (abstract to prevent silent leaks). */
  protected abstract onFreeTtl(): void;
}
