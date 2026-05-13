import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import type { ControllerRequestDto, TriggerStreamStartDto } from "../control/controller-dto";
import { LineFramedSocket } from "../control/controller-framing";
import { daemonError, daemonErrorDto } from "./core/daemon-error";
import { RequestContext } from "./core/request-context";

type UnaryHandler = (context: RequestContext, request: ControllerRequestDto) => Promise<unknown>;
type StreamHandler = (start: TriggerStreamStartDto, framed: LineFramedSocket, socket: net.Socket) => Promise<unknown>;

export class ControllerServer {
  private readonly socketPath: string;
  private readonly handleUnary: UnaryHandler;
  private readonly handleStreamStart: StreamHandler;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(input: {
    socketPath: string;
    handleUnary: UnaryHandler;
    handleStreamStart: StreamHandler;
  }) {
    this.socketPath = input.socketPath;
    this.handleUnary = input.handleUnary;
    this.handleStreamStart = input.handleStreamStart;
  }

  async start(): Promise<void> {
    if (this.server) return;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      const framed = new LineFramedSocket(socket);
      const context = new RequestContext();
      let handledUnaryRequest = false;
      socket.on("close", () => {
        this.sockets.delete(socket);
        context.cancel();
      });
      socket.on("error", () => context.cancel());
      framed.onFrame(async (frame) => {
        try {
          this.assertValidFrame(frame);
          if (this.isTriggerStart(frame)) {
            if (handledUnaryRequest) {
              throw daemonError("invalid_request", "A request socket cannot switch to a trigger stream");
            }
            const result = await this.handleStreamStart(frame, framed, socket);
            framed.writeFrame({ ok: true, result });
            return;
          }
          if (handledUnaryRequest) {
            throw daemonError("invalid_request", "Request socket accepts exactly one controller request");
          }
          handledUnaryRequest = true;
          const result = await this.handleUnary(context, frame as ControllerRequestDto);
          framed.writeFrame({ ok: true, result });
          socket.end();
        } catch (error) {
          framed.writeFrame(daemonErrorDto(error));
          socket.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, resolve);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const socket of Array.from(this.sockets)) {
      try {
        socket.destroy();
      } catch (error) {
        console.error(
          `[sip-pbx:controller] socket destroy failed during stop; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
  }

  private isTriggerStart(frame: any): frame is TriggerStreamStartDto {
    return Boolean(frame && typeof frame === "object" && typeof frame.kind === "string" && frame.config && !frame.method);
  }

  private assertValidFrame(frame: any): void {
    if (frame && typeof frame === "object" && frame.__controllerParseError) {
      throw daemonError("invalid_request", `Invalid JSON controller frame: ${String(frame.message || "parse error")}`);
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw daemonError("invalid_request", "Controller frame must be a JSON object");
    }
    const allowed = this.isTriggerStart(frame)
      ? new Set(["kind", "config"])
      : new Set(["method", "params"]);
    for (const key of Object.keys(frame)) {
      if (!allowed.has(key)) {
        throw daemonError("invalid_request", `Unknown controller frame field ${key}`);
      }
    }
    if (this.isTriggerStart(frame)) {
      if (!["trunk", "extensions", "queue", "aiTool", "voiceAgent"].includes(String(frame.kind))) {
        throw daemonError("unsupported_operation", `Unsupported trigger stream kind ${String(frame.kind)}`);
      }
      if (!frame.config || typeof frame.config !== "object" || Array.isArray(frame.config)) {
        throw daemonError("invalid_request", "Trigger stream config must be an object");
      }
      return;
    }
    if (typeof frame.method !== "string" || !frame.method) {
      throw daemonError("invalid_request", "Controller request method is required");
    }
    if (frame.params !== undefined && (!frame.params || typeof frame.params !== "object" || Array.isArray(frame.params))) {
      throw daemonError("invalid_request", "Controller request params must be an object");
    }
  }
}
