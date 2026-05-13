export type PbxResponseHandle = {
  kind: "auth" | "record" | "aiTool";
  handle: string;
};

export type PbxMetadata = {
  legId?: string;
  dialId?: string;
  mediaId?: string;
  authRequestId?: string;
  recordRequestId?: string;
  aiToolRequestId?: string;
  callId?: string;
  ref?: string;
};

function getSipPbxMetadata(item: any): Record<string, unknown> {
  const json = item && typeof item === "object" && item.json && typeof item.json === "object"
    ? (item.json as Record<string, unknown>)
    : {};
  return json && typeof json.sipPbx === "object" ? (json.sipPbx as Record<string, unknown>) : {};
}

export function readResponseHandle(item: any): PbxResponseHandle | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const handle = item._sipPbxResponseHandle;
  if (!handle || !handle.handle) {
    return null;
  }
  return {
    kind: handle.kind,
    handle: String(handle.handle),
  };
}

export function inheritPbxContext(sourceItem: any, targetItem: any): any {
  const handle = readResponseHandle(sourceItem);
  if (handle) {
    targetItem._sipPbxResponseHandle = handle;
  }
  const sourceMetadata = getSipPbxMetadata(sourceItem);
  if (!targetItem.json || typeof targetItem.json !== "object") {
    return targetItem;
  }
  const nextMetadata = typeof targetItem.json.sipPbx === "object" && targetItem.json.sipPbx
    ? { ...(targetItem.json.sipPbx as Record<string, unknown>) }
    : {};
  for (const [key, value] of Object.entries(sourceMetadata)) {
    if (nextMetadata[key] == null && value != null && value !== "") {
      nextMetadata[key] = value;
    }
  }
  if (Object.keys(nextMetadata).length > 0) {
    targetItem.json.sipPbx = nextMetadata;
  }
  return targetItem;
}
