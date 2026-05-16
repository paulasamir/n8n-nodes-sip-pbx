import { getDefaultFreeTtlMs, nowMs } from "./time";

type SnapshotEntry<T> = {
  value: T;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
};

export class TerminalSnapshotStore<T> {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, SnapshotEntry<T>>();

  constructor(ttlMs = getDefaultFreeTtlMs()) {
    this.ttlMs = Math.max(1, Math.floor(Number(ttlMs || getDefaultFreeTtlMs())));
  }

  remember(id: string, value: T): void {
    const key = String(id || "").trim();
    if (!key) {
      return;
    }
    const existing = this.entries.get(key) || null;
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    const expiresAt = nowMs() + this.ttlMs;
    const timer = setTimeout(() => {
      const current = this.entries.get(key) || null;
      if (current && current.expiresAt <= nowMs()) {
        this.entries.delete(key);
      }
    }, this.ttlMs);
    timer.unref?.();
    this.entries.set(key, {
      value,
      expiresAt,
      timer,
    });
  }

  get(id: string): T | null {
    const key = String(id || "").trim();
    if (!key) {
      return null;
    }
    const entry = this.entries.get(key) || null;
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= nowMs()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.entries.clear();
  }
}
