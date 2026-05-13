export class MapRegistry<TKey, TValue> {
  protected readonly records = new Map<TKey, TValue>();

  store(key: TKey, value: TValue): TValue {
    this.records.set(key, value);
    return value;
  }

  storeFront(key: TKey, value: TValue): TValue {
    this.records.delete(key);
    const reordered = new Map<TKey, TValue>([[key, value], ...this.records.entries()]);
    this.records.clear();
    for (const [entryKey, entryValue] of reordered.entries()) {
      this.records.set(entryKey, entryValue);
    }
    return value;
  }

  get(key: TKey): TValue | null {
    return this.records.get(key) || null;
  }

  require(key: TKey, message: string): TValue {
    const value = this.get(key);
    if (!value) {
      throw new Error(message);
    }
    return value;
  }

  remove(key: TKey): TValue | null {
    const value = this.get(key);
    if (!value) {
      return null;
    }
    this.records.delete(key);
    return value;
  }

  values(): TValue[] {
    return Array.from(this.records.values());
  }

  entries(): Array<[TKey, TValue]> {
    return Array.from(this.records.entries());
  }

  clear(): TValue[] {
    const values = this.values();
    this.records.clear();
    return values;
  }

  sweep(predicate: (value: TValue, key: TKey) => boolean): TValue[] {
    const removed: TValue[] = [];
    for (const [key, value] of this.entries()) {
      if (!predicate(value, key)) {
        continue;
      }
      this.records.delete(key);
      removed.push(value);
    }
    return removed;
  }
}
