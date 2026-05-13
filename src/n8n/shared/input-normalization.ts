import { normalizeStringList } from "../../shared/string-utils";

export type NodeParameterReader = {
  getNodeParameter?: (name: string, index: number, fallbackValue?: unknown) => unknown;
  getInputData?: () => Array<{ json?: Record<string, unknown>; binary?: Record<string, unknown> }>;
  getCredentials?: (name: string, index?: number) => Promise<unknown> | unknown;
  getInputConnectionData?: (connectionType: string, itemIndex: number, inputIndex?: number) => Promise<unknown> | unknown;
  getNodeInputs?: () => Array<{ type?: string; maxConnections?: number }>;
};

export type FixedCollectionItem = Record<string, unknown>;
export type HeaderEntry = {
  name: string;
  value: string;
};

type FixedCollectionContainer = {
  item: unknown[];
};

export type NormalizedExtensionDialConfig = {
  extensionNumbers: string[];
  callStrategy: "parallel" | "sequential";
  callerNumber: string;
  callerName: string;
  customSipHeaders: HeaderEntry[];
  sequentialAttemptTimeoutSeconds?: number;
  sequentialGapSeconds?: number;
  extensionListOnlyFreeEndpoints: boolean;
};

export function getInputItems(node: NodeParameterReader): any[] {
  if (typeof node?.getInputData === "function") {
    const items = node.getInputData();
    if (Array.isArray(items) && items.length > 0) {
      return items;
    }
  }
  return [{ json: {} }];
}

export function readNodeParameter(node: NodeParameterReader, name: string, index: number, fallback: unknown = ""): unknown {
  if (typeof node?.getNodeParameter !== "function") {
    return fallback;
  }
  try {
    return node.getNodeParameter(name, index, fallback);
  } catch (_error) {
    return fallback;
  }
}

export function readStringParameter(node: NodeParameterReader, name: string, index: number, fallback = ""): string {
  return String(readNodeParameter(node, name, index, fallback) || "").trim();
}

export function requireActionValue(name: string, value: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function readBooleanParameter(node: NodeParameterReader, name: string, index: number, fallback = false): boolean {
  return Boolean(readNodeParameter(node, name, index, fallback));
}

export function readNumberParameter(node: NodeParameterReader, name: string, index: number, fallback = 0): number {
  const raw = Number(readNodeParameter(node, name, index, fallback));
  return Number.isFinite(raw) ? raw : fallback;
}

export function readOptionalNumberParameter(node: NodeParameterReader, name: string, index: number, fallback = 0): number {
  const raw = readNodeParameter(node, name, index, fallback);
  if (raw == null || raw === "") {
    return fallback;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function readStringListParameter(node: NodeParameterReader, name: string, index: number): string[] {
  return normalizeStringList(readNodeParameter(node, name, index, []));
}

export function readFixedCollectionItems(node: NodeParameterReader, name: string, index: number): FixedCollectionItem[] {
  const raw = readNodeParameter(node, name, index, {});
  const container = readFixedCollectionContainer(raw);
  if (container) {
    return container.item.filter((value) => value && typeof value === "object") as FixedCollectionItem[];
  }
  if (Array.isArray(raw)) {
    return raw.filter((value) => value && typeof value === "object") as FixedCollectionItem[];
  }
  return [];
}

export function readOptionalScalarCollectionParameter(
  node: NodeParameterReader,
  collectionName: string,
  fieldName: string,
  index: number,
): string {
  const raw = readNodeParameter(node, collectionName, index, {});
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const directValue = String((raw as Record<string, unknown>)[fieldName] || "").trim();
    if (directValue) {
      return directValue;
    }
  }
  return "";
}

export function readCollectionOptions(
  node: NodeParameterReader,
  collectionName: string,
  index: number,
): Record<string, unknown> {
  const raw = readNodeParameter(node, collectionName, index, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

export function readHeaderLinesFromCollectionOptions(
  options: Record<string, unknown>,
  fieldName: string,
): HeaderEntry[] {
  const raw = options[fieldName];
  const container = readFixedCollectionContainer(raw);
  if (container) {
    return container.item
      .map((entry): HeaderEntry | null => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const key = String((entry as Record<string, unknown>).name || "").trim();
        if (!key) {
          return null;
        }
        return {
          name: key,
          value: String((entry as Record<string, unknown>).value == null ? "" : (entry as Record<string, unknown>).value),
        };
      })
      .filter(Boolean) as HeaderEntry[];
  }
  return [];
}

function readFixedCollectionContainer(raw: unknown): FixedCollectionContainer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const item = (raw as Record<string, unknown>).item;
  if (!Array.isArray(item)) {
    return null;
  }
  return { item };
}

export function readHeaderLines(node: NodeParameterReader, name: string, index: number): HeaderEntry[] {
  return readFixedCollectionItems(node, name, index)
    .map((entry): HeaderEntry | null => {
      const key = String(entry.name || "").trim();
      if (!key) {
        return null;
      }
      return { name: key, value: String(entry.value == null ? "" : entry.value) };
    })
    .filter(Boolean) as HeaderEntry[];
}

export function normalizeExtensionDialConfig(input: {
  extensionNumbers: unknown;
  callStrategy?: unknown;
  sequentialAttemptTimeoutSeconds?: unknown;
  sequentialGapSeconds?: unknown;
  options?: Record<string, unknown>;
  extensionListOnlyFreeEndpointsDefault?: boolean;
}): NormalizedExtensionDialConfig {
  const options = input.options || {};
  const extensionNumbers = normalizeStringList(input.extensionNumbers);
  const callStrategy = normalizeDialStrategy(input.callStrategy);
  const extensionListOnlyFreeEndpointsDefault = input.extensionListOnlyFreeEndpointsDefault !== false;
  const normalized: NormalizedExtensionDialConfig = {
    extensionNumbers,
    callStrategy,
    callerNumber: String(options.callerNumber || "").trim(),
    callerName: String(options.callerName || "").trim(),
    customSipHeaders: readHeaderLinesFromCollectionOptions(options, "customSipHeaders"),
    extensionListOnlyFreeEndpoints: normalizeBooleanOption(
      options.extensionListOnlyFreeEndpoints,
      extensionListOnlyFreeEndpointsDefault,
    ),
  };
  if (callStrategy === "sequential") {
    normalized.sequentialAttemptTimeoutSeconds = normalizeFiniteNumber(input.sequentialAttemptTimeoutSeconds);
    normalized.sequentialGapSeconds = normalizeFiniteNumber(input.sequentialGapSeconds);
  }
  return normalized;
}

export function readJsonParameter<T = unknown>(node: NodeParameterReader, name: string, index: number, fallback: T): T {
  const raw = readNodeParameter(node, name, index, fallback as unknown);
  if (raw == null || raw === "") {
    return fallback;
  }
  const validateType = (value: unknown): T => {
    if (Array.isArray(fallback)) {
      if (!Array.isArray(value)) {
        throw new Error(`Parameter ${name} must be a JSON array`);
      }
      return value as T;
    }
    if (fallback && typeof fallback === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Parameter ${name} must be a JSON object`);
      }
    }
    return value as T;
  };
  if (typeof raw === "object") {
    return validateType(raw);
  }
  try {
    return validateType(JSON.parse(String(raw)));
  } catch (error) {
    throw new Error(`Parameter ${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeDialStrategy(raw: unknown): "parallel" | "sequential" {
  return String(raw || "").trim() === "sequential" ? "sequential" : "parallel";
}

function normalizeFiniteNumber(raw: unknown): number {
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeBooleanOption(raw: unknown, fallback: boolean): boolean {
  if (raw == null || raw === "") {
    return fallback;
  }
  return Boolean(raw);
}

export function assertDtmfString(name: string, value: string, options?: { allowEmpty?: boolean; exactLength?: number }): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    if (options?.allowEmpty) {
      return normalized;
    }
    throw new Error(`${name} must not be empty`);
  }
  if (options?.exactLength != null && normalized.length !== options.exactLength) {
    throw new Error(`${name} must contain exactly ${options.exactLength} DTMF character(s)`);
  }
  if (!/^[0-9*#ABCD]+$/.test(normalized)) {
    throw new Error(`${name} contains unsupported DTMF characters`);
  }
  return normalized;
}

export function normalizeDtmfRules(node: NodeParameterReader, index: number): Array<{ pattern: string; label: string }> {
  return readFixedCollectionItems(node, "rules", index)
    .map((entry, ruleIndex) => {
      const pattern = String(entry.pattern || "").trim();
      const label = String(entry.label || "").trim();
      if (!pattern || !label) {
        return null;
      }
      return {
        pattern: assertDtmfString("DTMF rule pattern", pattern),
        label,
      };
    })
    .filter(Boolean) as Array<{ pattern: string; label: string }>;
}

export function assertUniqueRuleLabels(rules: Array<{ pattern: string; label: string }>): void {
  const labels = new Set<string>();
  for (const rule of rules) {
    if (labels.has(rule.label)) {
      throw new Error(`DTMF rule labels must be unique. Duplicate label: ${rule.label}`);
    }
    labels.add(rule.label);
  }
}

export function readItemBinaryDataBase64(item: any, propertyName: string): string {
  if (!item || typeof item !== "object" || !item.binary || typeof item.binary !== "object") {
    return "";
  }
  const binaryEntry = (item.binary as Record<string, unknown>)[propertyName];
  if (!binaryEntry) {
    return "";
  }
  if (typeof binaryEntry === "string") {
    return String(binaryEntry).trim();
  }
  if (Buffer.isBuffer(binaryEntry)) {
    return binaryEntry.toString("base64");
  }
  if (typeof binaryEntry === "object") {
    const nested = binaryEntry as Record<string, unknown>;
    if (typeof nested.data === "string" && nested.data.trim()) {
      return nested.data.trim();
    }
    if (Buffer.isBuffer(nested.data)) {
      return nested.data.toString("base64");
    }
  }
  return "";
}

export async function readAiInputConnectionData(
  node: NodeParameterReader,
  connectionType: string,
  itemIndex: number,
  inputIndex = 0,
): Promise<unknown | null> {
  if (typeof node?.getInputConnectionData !== "function") {
    return null;
  }
  try {
    return await node.getInputConnectionData(connectionType, itemIndex, inputIndex);
  } catch (_error) {
    return null;
  }
}

export async function readAiInputConnections(
  node: NodeParameterReader,
  connectionType: string,
  itemIndex: number,
): Promise<unknown[]> {
  const raw = await readAiInputConnectionData(node, connectionType, itemIndex, 0);
  if (raw == null) {
    return [];
  }
  return Array.isArray(raw) ? raw.filter((value) => value != null) : [raw];
}
