import { daemonError } from "../../core/daemon-error";

export type FlowScopedTriggerKind = "trunk" | "extensions" | "queue" | "aiTool";

const textDecoder = new TextDecoder("utf-8");

export function normalizeTriggerRef(value: unknown): string {
  return String(value || "").trim();
}

export function assertValidTriggerRef(value: unknown): string {
  const ref = normalizeTriggerRef(value);
  if (!ref) {
    throw daemonError("invalid_trigger", "Trigger ref is required");
  }
  return ref;
}

export function parseFlowScopedTriggerRef(value: unknown): {
  workflowScopeKey: string;
  kind: FlowScopedTriggerKind;
  publicRef: string;
} | null {
  const ref = normalizeTriggerRef(value);
  const match = ref.match(/^flow:([^:]+):(trunk|extensions|queue|aiTool):(.+)$/);
  if (!match) {
    return null;
  }
  const workflowScopeKey = decodeFlowScopedComponent(String(match[1] || ""));
  const publicRef = decodeFlowScopedComponent(String(match[3] || ""));
  if (workflowScopeKey == null || publicRef == null) {
    return null;
  }
  return {
    workflowScopeKey,
    kind: String(match[2] || "") as FlowScopedTriggerKind,
    publicRef,
  };
}

function decodeFlowScopedComponent(value: string): string | null {
  const normalized = String(value || "");
  if (!normalized.includes("%")) {
    return normalized;
  }
  const bytes: number[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] || "";
    if (char !== "%") {
      const code = char.charCodeAt(0);
      if (!Number.isFinite(code) || code < 0 || code > 0x7f) {
        return null;
      }
      bytes.push(code);
      continue;
    }
    const hex = normalized.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      return null;
    }
    bytes.push(parseInt(hex, 16));
    index += 2;
  }
  const decoded = textDecoder.decode(Uint8Array.from(bytes));
  return decoded.includes("\uFFFD") ? null : decoded;
}

export function buildFlowScopedTriggerRef(
  workflowScopeKey: string,
  kind: FlowScopedTriggerKind,
  publicRef: string,
): string {
  return `flow:${encodeURIComponent(String(workflowScopeKey || "").trim())}:${encodeURIComponent(kind)}:${encodeURIComponent(String(publicRef || "").trim())}`;
}

export function deriveFlowScopedTriggerRef(value: unknown, kind: FlowScopedTriggerKind): string {
  const parsed = parseFlowScopedTriggerRef(value);
  if (!parsed || !parsed.workflowScopeKey || !parsed.publicRef) {
    return normalizeTriggerRef(value);
  }
  return buildFlowScopedTriggerRef(parsed.workflowScopeKey, kind, parsed.publicRef);
}
