type Predicate<T> = (event: T) => boolean;

export class BoundedEventQueue<T> {
  private readonly limit: number;
  private readonly items: T[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  push(event: T): void {
    this.items.push(event);
    while (this.items.length > this.limit) {
      this.items.shift();
    }
  }

  shift(): T | null {
    return this.items.length > 0 ? this.items.shift() || null : null;
  }

  shiftMatching(predicate: Predicate<T>): T | null {
    const index = this.items.findIndex(predicate);
    if (index < 0) {
      return null;
    }
    const [event] = this.items.splice(index, 1);
    return event || null;
  }

  peekMatching(predicate: Predicate<T>): T | null {
    return this.items.find(predicate) || null;
  }

  consumeMatching(predicate: Predicate<T>): number {
    let removed = 0;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (!predicate(this.items[index] as T)) {
        continue;
      }
      this.items.splice(index, 1);
      removed += 1;
    }
    return removed;
  }

  toArray(): T[] {
    return this.items.slice();
  }
}
