export class ExtensionRegistrationGrace {
  private readonly graceMs: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(graceMs: number) {
    this.graceMs = Math.max(0, Number(graceMs || 0));
  }

  cancel(ref: string): void {
    const handle = this.timers.get(ref);
    if (!handle) {
      return;
    }
    clearTimeout(handle);
    this.timers.delete(ref);
  }

  schedule(ref: string, callback: () => void): void {
    this.cancel(ref);
    const handle = setTimeout(() => {
      this.timers.delete(ref);
      callback();
    }, this.graceMs);
    this.timers.set(ref, handle);
  }
}
