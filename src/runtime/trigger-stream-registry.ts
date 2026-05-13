import type { ControllerTriggerStream, TriggerStreamCloseInfo } from "../control/controller-trigger-stream";
import { MapRegistry } from "../shared/map-registry";

type TriggerStreamLike = Pick<ControllerTriggerStream, "triggerKey" | "socketId" | "close"> & {
  onClose?: (handler: (info: TriggerStreamCloseInfo) => void) => () => void;
};

export type RuntimeTriggerStream = Pick<ControllerTriggerStream, "triggerKey" | "socketId" | "close">;

const RECONNECT_DELAYS_MS = [100, 250, 500, 1000, 2000, 5000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatReconnectError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ManagedTriggerStream implements RuntimeTriggerStream {
  private readonly logicalKey: string;
  private readonly opener: () => Promise<TriggerStreamLike>;
  private activeStream: TriggerStreamLike | null;
  private unsubscribeClose: (() => void) | null = null;
  private closed = false;
  private reconnectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(logicalKey: string, opener: () => Promise<TriggerStreamLike>, stream: TriggerStreamLike) {
    this.logicalKey = logicalKey;
    this.opener = opener;
    this.activeStream = null;
    this.attach(stream);
  }

  get triggerKey(): string {
    return this.activeStream?.triggerKey || this.logicalKey;
  }

  get socketId(): string {
    return this.activeStream?.socketId || "";
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.unsubscribeClose) {
      this.unsubscribeClose();
      this.unsubscribeClose = null;
    }
    const stream = this.activeStream;
    this.activeStream = null;
    if (stream) {
      await stream.close();
    }
  }

  private attach(stream: TriggerStreamLike): void {
    if (this.closed) {
      void stream.close();
      return;
    }
    if (this.unsubscribeClose) {
      this.unsubscribeClose();
      this.unsubscribeClose = null;
    }
    this.activeStream = stream;
    if (typeof stream.onClose === "function") {
      this.unsubscribeClose = stream.onClose((info) => {
        if (info.expected || this.closed) {
          return;
        }
        this.reconnect();
      });
    }
  }

  private reconnect(): void {
    if (this.reconnectPromise || this.closed) {
      return;
    }
    this.reconnectPromise = this.runReconnect()
      .finally(() => {
        this.reconnectPromise = null;
      });
  }

  private async runReconnect(): Promise<void> {
    let attempt = 0;
    while (!this.closed) {
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      await new Promise<void>((resolve) => {
        this.reconnectTimer = setTimeout(resolve, delay);
      });
      this.reconnectTimer = null;
      if (this.closed) {
        return;
      }
      try {
        const nextStream = await this.opener();
        this.attach(nextStream);
        return;
      } catch (error) {
        attempt += 1;
        console.error(`[sip-pbx:runtime] trigger stream reconnect failed; trigger=${this.logicalKey}; attempt=${attempt}; error=${formatReconnectError(error)}`);
        await sleep(0);
      }
    }
  }
}

export class TriggerStreamRegistry extends MapRegistry<string, ManagedTriggerStream> {
  async open(logicalKey: string, opener: () => Promise<TriggerStreamLike>): Promise<ManagedTriggerStream> {
    if (this.get(logicalKey)) {
      throw new Error(`Trigger stream ${logicalKey} is already active`);
    }
    const stream = await opener();
    const managed = new ManagedTriggerStream(logicalKey, opener, stream);
    this.store(logicalKey, managed);
    return managed;
  }

  close(logicalKey: string): void {
    const stream = this.remove(logicalKey);
    if (!stream) {
      return;
    }
    void stream.close();
  }

  async closeAndWait(logicalKey: string): Promise<void> {
    const stream = this.remove(logicalKey);
    if (!stream) {
      return;
    }
    await stream.close();
  }

  closeAll(): void {
    for (const [logicalKey, stream] of this.entries()) {
      this.remove(logicalKey);
      void stream.close();
    }
  }

  async closeAllAndWait(): Promise<void> {
    const streams = this.clear();
    await Promise.all(streams.map(async (stream) => {
      await stream.close();
    }));
  }
}
