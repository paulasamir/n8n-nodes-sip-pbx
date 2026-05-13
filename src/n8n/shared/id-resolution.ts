import type { NodeParameterReader } from "./input-normalization";
import { readOptionalScalarCollectionParameter } from "./input-normalization";
import { readResponseHandle } from "./pbx-payload-context";

function getJson(item: any): Record<string, unknown> {
  return item && typeof item === "object" && item.json && typeof item.json === "object"
    ? (item.json as Record<string, unknown>)
    : {};
}

function getSipPbxMetadata(item: any): Record<string, unknown> {
  const json = getJson(item);
  return json && typeof json.sipPbx === "object" ? (json.sipPbx as Record<string, unknown>) : {};
}

function readRequestIdParameter(node: NodeParameterReader, index: number, collectionName = "respondOptions"): string {
  return readOptionalScalarCollectionParameter(node, collectionName, "requestId", index);
}

export function resolveLegId(
  node: NodeParameterReader,
  item: any,
  index: number,
  fieldName = "legId",
  collectionName = "callOptions",
): string {
  const explicit = readOptionalScalarCollectionParameter(node, collectionName, fieldName, index);
  if (explicit) {
    return explicit;
  }
  const json = getJson(item);
  const sipPbx = getSipPbxMetadata(item);
  return String(json.legId || sipPbx.legId || "").trim();
}

export function resolveAiLegId(
  node: NodeParameterReader,
  item: any,
  index: number,
  fieldName = "legId",
  collectionName = "aiOptions",
): string {
  const explicit = readOptionalScalarCollectionParameter(node, collectionName, fieldName, index);
  if (explicit) {
    return explicit;
  }
  const json = getJson(item);
  const sipPbx = getSipPbxMetadata(item);
  return String(json.aiLegId || json.legId || sipPbx.aiLegId || sipPbx.legId || "").trim();
}

export function resolveDialId(
  node: NodeParameterReader,
  item: any,
  index: number,
  fieldName = "dialId",
  collectionName = "dialOptions",
): string {
  const explicit = readOptionalScalarCollectionParameter(node, collectionName, fieldName, index);
  if (explicit) {
    return explicit;
  }
  const json = getJson(item);
  const sipPbx = getSipPbxMetadata(item);
  return String(json.dialId || sipPbx.dialId || "").trim();
}

export function resolveMediaLegId(node: NodeParameterReader, item: any, index: number): string {
  return resolveLegId(node, item, index, "legId", "mediaOptions");
}

export function resolveStopMediaLegId(node: NodeParameterReader, item: any, index: number): string {
  return resolveLegId(node, item, index, "legId", "mediaOptions");
}

export function resolveStopMediaId(node: NodeParameterReader, item: any, index: number): string {
  const explicit = readOptionalScalarCollectionParameter(node, "mediaOptions", "mediaId", index);
  if (explicit) {
    return explicit;
  }
  const json = getJson(item);
  const sipPbx = getSipPbxMetadata(item);
  return String(json.mediaId || sipPbx.mediaId || "").trim();
}

export function resolveResponseHandle(item: any) {
  return readResponseHandle(item);
}

export function resolveAuthRequestId(node: NodeParameterReader, item: any, index: number): string {
  const hidden = readResponseHandle(item);
  if (hidden && hidden.kind === "auth") {
    return hidden.handle;
  }
  const explicit = readRequestIdParameter(node, index);
  if (explicit) {
    return explicit;
  }
  const json = getJson(item);
  const sipPbx = getSipPbxMetadata(item);
  return String(json.authRequestId || sipPbx.authRequestId || "").trim();
}

export function resolveAiToolRequestId(node: NodeParameterReader, item: any, index: number): string {
  const hidden = readResponseHandle(item);
  if (hidden && hidden.kind === "aiTool") {
    return hidden.handle;
  }
  const explicit = readRequestIdParameter(node, index);
  if (explicit) {
    return explicit;
  }
  const json = getJson(item);
  const sipPbx = getSipPbxMetadata(item);
  return String(json.aiToolRequestId || sipPbx.aiToolRequestId || "").trim();
}

export function resolveRecordRequestId(node: NodeParameterReader, item: any, index: number): string {
  const hidden = readResponseHandle(item);
  if (hidden && hidden.kind === "record") {
    return hidden.handle;
  }
  const explicit = readRequestIdParameter(node, index);
  if (explicit) {
    return explicit;
  }
  const json = getJson(item);
  const sipPbx = getSipPbxMetadata(item);
  return String(json.recordRequestId || sipPbx.recordRequestId || "").trim();
}
