import { inheritPbxContext, type PbxMetadata } from "./pbx-payload-context";

export type OutputItem = {
  json: Record<string, unknown>;
  binary?: Record<string, unknown>;
  _sipPbxResponseHandle?: {
    kind: "auth" | "queue" | "record" | "aiTool";
    handle: string;
  };
};

function attachSipPbxMetadata(item: OutputItem, metadata?: PbxMetadata): OutputItem {
  const sipPbx: Record<string, unknown> = {};
  if (metadata?.legId) sipPbx.legId = metadata.legId;
  if (metadata?.dialId) sipPbx.dialId = metadata.dialId;
  if (metadata?.mediaId) sipPbx.mediaId = metadata.mediaId;
  if (metadata?.authRequestId) sipPbx.authRequestId = metadata.authRequestId;
  if (metadata?.recordRequestId) sipPbx.recordRequestId = metadata.recordRequestId;
  if (metadata?.aiToolRequestId) sipPbx.aiToolRequestId = metadata.aiToolRequestId;
  if (metadata?.ref) sipPbx.ref = metadata.ref;
  if (Object.keys(sipPbx).length > 0) {
    item.json.sipPbx = sipPbx;
  }
  return item;
}

export function attachResponseHandle(item: OutputItem, kind: "auth" | "record" | "aiTool", handle: string): OutputItem {
  item._sipPbxResponseHandle = { kind, handle };
  return item;
}

export function buildNodeItem(
  sourceItem: any,
  payload: Record<string, unknown>,
  metadata?: PbxMetadata,
): OutputItem {
  const item: OutputItem = {
    json: {
      ...(payload || {}),
    },
  };
  attachSipPbxMetadata(item, metadata);
  return inheritPbxContext(sourceItem, item);
}

export function buildTriggerItem(payload: Record<string, unknown>, metadata?: PbxMetadata): OutputItem {
  const item: OutputItem = {
    json: {
      ...(payload || {}),
    },
  };
  return attachSipPbxMetadata(item, metadata);
}

function normalizePublicRawKey(value: string): string {
  const segments = String(value || "")
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  return segments
    .map((segment, index) => {
      const lower = segment.toLowerCase();
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

export function normalizePublicRawObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizePublicRawObject(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = normalizePublicRawKey(key);
    if (!normalizedKey) {
      continue;
    }
    output[normalizedKey] = normalizePublicRawObject(entryValue);
  }
  return output;
}
