type Predicate<T> = (event: T) => boolean;

type Waiter<T> = {
  predicate: Predicate<T>;
  resolve: (event: T) => void;
  reject: (error: unknown) => void;
  timeoutHandle: NodeJS.Timeout | null;
};

export type CancellableWait<T> = {
  promise: Promise<T>;
  cancel: () => void;
};

export class EventWaiterSet<T> {
  private readonly waiters = new Set<Waiter<T>>();

  publish(event: T): boolean {
    for (const waiter of Array.from(this.waiters)) {
      if (!waiter.predicate(event)) {
        continue;
      }
      this.waiters.delete(waiter);
      if (waiter.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
      }
      waiter.resolve(event);
      return true;
    }
    return false;
  }

  async waitFor(predicate: Predicate<T>, timeoutMs: number): Promise<T> {
    const ticket = this.waitForCancellable(predicate, timeoutMs);
    return await ticket.promise;
  }

  waitForCancellable(predicate: Predicate<T>, timeoutMs: number): CancellableWait<T> {
    let waiterRef: Waiter<T> | null = null;
    const promise = new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        predicate,
        resolve,
        reject,
        timeoutHandle: null,
      };
      waiterRef = waiter;
      if (timeoutMs > 0) {
        waiter.timeoutHandle = setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("wait_timeout"));
        }, timeoutMs);
      }
      this.waiters.add(waiter);
    });
    return {
      promise,
      cancel: () => {
        const waiter = waiterRef;
        if (!waiter) {
          return;
        }
        if (waiter.timeoutHandle) {
          clearTimeout(waiter.timeoutHandle);
        }
        this.waiters.delete(waiter);
      },
    };
  }

  rejectAll(error: unknown): void {
    for (const waiter of Array.from(this.waiters)) {
      this.waiters.delete(waiter);
      if (waiter.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
      }
      waiter.reject(error);
    }
  }
}
