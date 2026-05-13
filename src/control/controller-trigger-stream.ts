import type { Socket } from "net";
import { LineFramedSocket } from "./controller-framing";
import type { TriggerStreamEventDto } from "./controller-dto";

export type TriggerStreamCloseInfo = {
  expected: boolean;
  reason: string;
  error?: Error;
};

export class ControllerTriggerStream {
  readonly triggerKey: string;
  readonly socketId: string;
  private readonly socket: Socket;
  private readonly framed: LineFramedSocket;
  private readonly bufferedEvents: TriggerStreamEventDto[] = [];
  private readonly handlers = new Set<(event: TriggerStreamEventDto) => void>();
  private readonly closeHandlers = new Set<(info: TriggerStreamCloseInfo) => void>();
  private readonly unsubscribe: () => void;
  private closePromise: Promise<void> | null = null;
  private closeInfo: TriggerStreamCloseInfo | null = null;
  private closingExpected = false;

  constructor(socket: Socket, framed: LineFramedSocket, input: { triggerKey: string; socketId: string }) {
    this.triggerKey = input.triggerKey;
    this.socketId = input.socketId;
    this.socket = socket;
    this.framed = framed;
    this.unsubscribe = this.framed.onFrame((frame) => {
      const event = frame as TriggerStreamEventDto;
      if (this.handlers.size === 0) {
        this.bufferedEvents.push(event);
        return;
      }
      for (const handler of Array.from(this.handlers)) {
        handler(event);
      }
    });
    this.socket.once("error", (error) => {
      this.reportClose({
        expected: this.closingExpected,
        reason: this.closingExpected ? "closed" : "socket_error",
        error,
      });
    });
    this.socket.once("close", () => {
      this.reportClose({
        expected: this.closingExpected,
        reason: this.closingExpected ? "closed" : "socket_closed",
      });
    });
  }

  onEvent(handler: (event: TriggerStreamEventDto) => void): () => void {
    this.handlers.add(handler);
    while (this.bufferedEvents.length > 0) {
      const event = this.bufferedEvents.shift()!;
      handler(event);
    }
    return () => {
      this.handlers.delete(handler);
    };
  }

  onClose(handler: (info: TriggerStreamCloseInfo) => void): () => void {
    this.closeHandlers.add(handler);
    if (this.closeInfo) {
      handler(this.closeInfo);
    }
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    this.closingExpected = true;
    this.closePromise = (async () => {
      this.unsubscribe();
      this.handlers.clear();
      this.bufferedEvents.length = 0;
      if (this.socket.destroyed) {
        this.reportClose({ expected: true, reason: "closed" });
        return;
      }
      let forceDestroyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        try {
          this.socket.destroy();
        } catch (error) {
          console.error(
            `[sip-pbx:control] trigger stream forced destroy failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
          );
        }
      }, 250);
      try {
        await new Promise<void>((resolve) => {
          const finish = () => {
            this.socket.off("close", finish);
            this.socket.off("error", finish);
            resolve();
          };
          this.socket.once("close", finish);
          this.socket.once("error", finish);
          this.socket.end();
        });
      } finally {
        if (forceDestroyTimer) {
          clearTimeout(forceDestroyTimer);
          forceDestroyTimer = null;
        }
      }
    })();
    return await this.closePromise;
  }

  private reportClose(info: TriggerStreamCloseInfo): void {
    if (this.closeInfo) {
      return;
    }
    this.closeInfo = info;
    for (const handler of Array.from(this.closeHandlers)) {
      handler(info);
    }
  }
}
