type Release = () => void;

export class AsyncLock {
  private locked = false;
  private readonly waiters: Array<(release: Release) => void> = [];

  async acquire(): Promise<Release> {
    if (!this.locked) {
      this.locked = true;
      return this.release.bind(this);
    }
    return await new Promise<Release>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async runExclusive<T>(callback: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await callback();
    } finally {
      release();
    }
  }

  private release(): void {
    const next = this.waiters.shift() || null;
    if (!next) {
      this.locked = false;
      return;
    }
    next(this.release.bind(this));
  }
}

export class AsyncLockMap {
  private readonly locks = new Map<string, AsyncLock>();

  private getLock(key: string): AsyncLock {
    const normalized = String(key || "").trim();
    if (!normalized) {
      throw new Error("lock_key_required");
    }
    let lock = this.locks.get(normalized) || null;
    if (!lock) {
      lock = new AsyncLock();
      this.locks.set(normalized, lock);
    }
    return lock;
  }

  async runExclusive<T>(key: string, callback: () => Promise<T> | T): Promise<T> {
    return await this.getLock(key).runExclusive(callback);
  }

  async runExclusiveMany<T>(keys: string[], callback: () => Promise<T> | T): Promise<T> {
    const normalized = Array.from(new Set(keys.map((key) => String(key || "").trim()).filter(Boolean))).sort();
    const locks = normalized.map((key) => this.getLock(key));
    const releases: Release[] = [];
    try {
      for (const lock of locks) {
        releases.push(await lock.acquire());
      }
      return await callback();
    } finally {
      for (const release of releases.reverse()) {
        release();
      }
    }
  }
}
