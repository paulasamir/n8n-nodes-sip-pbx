import type { Socket } from "net";

export class LineFramedSocket {
  private readonly socket: Socket;
  private buffer = "";
  private readonly handlers = new Set<(frame: any) => void>();

  constructor(socket: Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const raw = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (raw) {
          let frame: unknown;
          try {
            frame = JSON.parse(raw);
          } catch (error) {
            frame = {
              __controllerParseError: true,
              message: error instanceof Error ? error.message : "Invalid JSON frame",
            };
          }
          for (const handler of Array.from(this.handlers)) {
            handler(frame);
          }
        }
        newlineIndex = this.buffer.indexOf("\n");
      }
    });
  }

  writeFrame(frame: unknown): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  onFrame(handler: (frame: any) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
