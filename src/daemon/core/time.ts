export const DEFAULT_FREE_TTL_MS = 5000;

export function nowMs(): number {
  return Date.now();
}

export function deadlineFromTimeout(timeoutMs: number): number {
  return nowMs() + Math.max(0, timeoutMs);
}

export function isExpired(deadlineMs: number): boolean {
  return nowMs() >= deadlineMs;
}

export function getDefaultFreeTtlMs(): number {
  const raw = Number(process.env.SIP_PBX_FREE_TTL_MS || DEFAULT_FREE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FREE_TTL_MS;
}
