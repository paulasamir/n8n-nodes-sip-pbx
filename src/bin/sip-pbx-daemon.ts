import { inspect } from "util";
import { SipPbxDaemon } from "../daemon/sip-pbx-daemon";
import { loadNativeCodecBindings } from "../daemon/media/codecs/audio-codec";

function formatFatalReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack || reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return inspect(reason, { depth: 4, breakLength: 120 });
}

function registerFatalProcessLogging(): void {
  process.once("uncaughtExceptionMonitor", (error, origin) => {
    console.error(`[sip-pbx:daemon] uncaught exception during ${origin}: ${formatFatalReason(error)}`);
  });
  process.once("unhandledRejection", (reason) => {
    console.error(`[sip-pbx:daemon] unhandled rejection: ${formatFatalReason(reason)}`);
  });
}

function setDaemonThreadName(): void {
  try {
    loadNativeCodecBindings()?.SetThreadName?.("sip-pbx:daemon");
  } catch (error) {
    console.error(
      `[sip-pbx:daemon] thread naming failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
    );
  }
}

async function main(): Promise<void> {
  registerFatalProcessLogging();
  setDaemonThreadName();
  const daemon = new SipPbxDaemon();
  await daemon.start();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
