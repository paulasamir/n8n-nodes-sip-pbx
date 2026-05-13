import * as os from "os";
import * as path from "path";

export function getDefaultSocketPath(): string {
  return process.env.SIP_PBX_SOCKET_PATH || path.join(os.homedir(), ".n8n", "sip-pbx", "daemon.sock");
}

export function getDefaultDaemonEntrypoint(): string {
  return path.resolve(__dirname, "..", "bin", "sip-pbx-daemon.js");
}
