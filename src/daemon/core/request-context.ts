import { daemonError } from "./daemon-error";

type CancelHandler = () => void;

export class RequestContext {
  private cancelled = false;
  private readonly cancelHandlers = new Set<CancelHandler>();

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const handler of Array.from(this.cancelHandlers)) {
      handler();
    }
    this.cancelHandlers.clear();
  }

  onCancel(handler: CancelHandler): () => void {
    if (this.cancelled) {
      handler();
      return () => undefined;
    }
    this.cancelHandlers.add(handler);
    return () => {
      this.cancelHandlers.delete(handler);
    };
  }

  throwIfCancelled(): void {
    if (this.cancelled) {
      throw daemonError("request_cancelled", "The request was cancelled");
    }
  }
}
