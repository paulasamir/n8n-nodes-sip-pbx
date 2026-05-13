function formatCleanupError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? error.stack.split("\n", 1)[0] || error.message : error.message;
  }
  return String(error ?? "unknown");
}

function logCleanupFailure(scope: string, action: string, error: unknown): void {
  console.error(`[sip-pbx:media-worker] ${scope} ${action} failed; error=${formatCleanupError(error)}`);
}

export function safeDestroy(scope: string, action: string, target: { destroy(): void } | null | undefined): void {
  if (!target) {
    return;
  }
  try {
    target.destroy();
  } catch (error) {
    logCleanupFailure(scope, action, error);
  }
}

export function safeClose(scope: string, action: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    logCleanupFailure(scope, action, error);
  }
}
