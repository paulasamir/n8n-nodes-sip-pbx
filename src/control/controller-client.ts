import { spawn } from "child_process";
import * as net from "net";
import type { Socket } from "net";
import { LineFramedSocket } from "./controller-framing";
import type {
  ControllerErrorDto,
  ControllerRequestDto,
  ControllerResponseDto,
  TriggerStreamStartDto,
} from "./controller-dto";
import { ControllerTriggerStream } from "./controller-trigger-stream";
import { ControllerMethod } from "./controller-protocol";
import { getDefaultDaemonEntrypoint, getDefaultSocketPath } from "./socket-path";

type DaemonAutoStartError = Error & {
  code?: string;
  exitCode?: number | null;
};

function createDaemonSocketClosedError(operation: string, socketPath: string, cause?: unknown): Error {
  const error = new Error(`Daemon RPC socket closed before ${operation} completed`);
  (error as Error & { code?: string; socketPath?: string }).code = "daemon_disconnected";
  (error as Error & { code?: string; socketPath?: string }).socketPath = socketPath;
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

const daemonStartPromisesBySocketPath = new Map<string, Promise<void>>();

function isControllerErrorResponse(response: ControllerResponseDto): response is ControllerErrorDto {
  return response.ok === false;
}

export class ControllerClient {
  private readonly socketPath: string;
  private readonly autoStart: boolean;
  private readonly daemonEntrypoint: string;
  private startPromise: Promise<void> | null = null;

  constructor(
    socketPathOrOptions?: string | {
      socketPath?: string;
      autoStart?: boolean;
      daemonEntrypoint?: string;
    },
    options?: { autoStart?: boolean; daemonEntrypoint?: string },
  ) {
    if (typeof socketPathOrOptions === "string" || socketPathOrOptions == null) {
      this.socketPath = typeof socketPathOrOptions === "string" ? socketPathOrOptions : getDefaultSocketPath();
      this.autoStart = options?.autoStart !== false;
      this.daemonEntrypoint = options?.daemonEntrypoint || getDefaultDaemonEntrypoint();
      return;
    }
    this.socketPath = socketPathOrOptions.socketPath || getDefaultSocketPath();
    this.autoStart = socketPathOrOptions.autoStart !== false;
    this.daemonEntrypoint = socketPathOrOptions.daemonEntrypoint || getDefaultDaemonEntrypoint();
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const response = await this.request({ method, params });
    if (isControllerErrorResponse(response)) {
      throw new Error(response.error.message);
    }
    return response.result;
  }

  async stopDaemon(): Promise<unknown> {
    return await this.call(ControllerMethod.stopDaemon);
  }

  async openStream(start: TriggerStreamStartDto): Promise<ControllerTriggerStream> {
    const socket = await this.connect();
    const framed = new LineFramedSocket(socket);
    return await new Promise<ControllerTriggerStream>((resolve, reject) => {
      let unsubscribe = () => undefined;
      const cleanup = () => {
        unsubscribe();
        socket.off("close", onClose);
        socket.off("end", onClose);
        socket.off("error", onError);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(createDaemonSocketClosedError("trigger stream handshake", this.socketPath, error));
      };
      const onClose = () => {
        cleanup();
        reject(createDaemonSocketClosedError("trigger stream handshake", this.socketPath));
      };
      unsubscribe = framed.onFrame((frame) => {
        cleanup();
        const response = frame as ControllerResponseDto;
        if (isControllerErrorResponse(response)) {
          try {
            socket.end();
          } catch (error) {
            console.error(
              `[sip-pbx:control] trigger stream socket end failed after error response; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
            );
          }
          reject(new Error(response.error.message));
          return;
        }
        const result = (response.result || {}) as Record<string, unknown>;
        const triggerKey = String(result.triggerKey || "").trim();
        const socketId = String(result.socketId || "").trim();
        if (!triggerKey || !socketId) {
          try {
            socket.end();
          } catch (error) {
            console.error(
              `[sip-pbx:control] trigger stream socket end failed after invalid handshake; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
            );
          }
          reject(new Error("Trigger stream handshake did not return triggerKey/socketId"));
          return;
        }
        resolve(new ControllerTriggerStream(socket, framed, { triggerKey, socketId }));
      });
      socket.once("close", onClose);
      socket.once("end", onClose);
      socket.once("error", onError);
      framed.writeFrame(start);
    });
  }

  private async request(request: ControllerRequestDto): Promise<ControllerResponseDto> {
    const socket = await this.connect();
    const framed = new LineFramedSocket(socket);
    return await new Promise<ControllerResponseDto>((resolve, reject) => {
      let unsubscribe = () => undefined;
      const cleanup = () => {
        unsubscribe();
        socket.off("close", onClose);
        socket.off("end", onClose);
        socket.off("error", onError);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(createDaemonSocketClosedError(request.method, this.socketPath, error));
      };
      const onClose = () => {
        cleanup();
        reject(createDaemonSocketClosedError(request.method, this.socketPath));
      };
      unsubscribe = framed.onFrame((frame) => {
        cleanup();
        socket.end();
        resolve(frame as ControllerResponseDto);
      });
      socket.once("close", onClose);
      socket.once("end", onClose);
      socket.once("error", onError);
      framed.writeFrame(request);
    });
  }

  private async connect(): Promise<Socket> {
    try {
      return await this.connectOnce();
    } catch (error: unknown) {
      if (!this.autoStart || !this.shouldAutoStart(error)) {
        throw error;
      }
      await this.ensureDaemonStarted();
      return await this.connectOnce();
    }
  }

  private async connectOnce(): Promise<Socket> {
    return await new Promise<Socket>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath, () => resolve(socket));
      socket.once("error", reject);
    });
  }

  private shouldAutoStart(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT" || code === "ECONNREFUSED";
  }

  private async ensureDaemonStarted(): Promise<void> {
    let startPromise = daemonStartPromisesBySocketPath.get(this.socketPath) || null;
    if (!startPromise) {
      startPromise = this.spawnDaemonAndWait()
        .finally(() => {
          if (daemonStartPromisesBySocketPath.get(this.socketPath) === startPromise) {
            daemonStartPromisesBySocketPath.delete(this.socketPath);
          }
        });
      daemonStartPromisesBySocketPath.set(this.socketPath, startPromise);
    }
    if (!this.startPromise) {
      this.startPromise = startPromise.finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  private async spawnDaemonAndWait(): Promise<void> {
    await this.spawnChildDaemonAndWait();
  }

  private async spawnChildDaemonAndWait(): Promise<void> {
    const child = spawn(process.execPath, [this.daemonEntrypoint], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SIP_PBX_SOCKET_PATH: this.socketPath,
      },
    });
    let childExited = false;
    let childExitCode: number | null = null;
    child.once("exit", (code) => {
      childExited = true;
      childExitCode = code;
    });
    child.unref();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (childExited) {
        const error: DaemonAutoStartError = new Error(`Daemon child process exited before opening socket ${this.socketPath}`);
        error.code = "autostart_child_failed";
        error.exitCode = childExitCode;
        throw error;
      }
      try {
        const socket = await this.connectOnce();
        socket.end();
        return;
      } catch (error: unknown) {
        if (!this.shouldAutoStart(error)) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const error: DaemonAutoStartError = new Error(`Timed out waiting for daemon socket ${this.socketPath}`);
    error.code = "autostart_timeout";
    throw error;
  }
}
