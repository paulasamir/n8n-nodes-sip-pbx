import * as fs from "fs";
import * as path from "path";
import type { SupplyData } from "n8n-workflow";
import { z } from "zod";
import type { PbxRuntime } from "../../runtime/pbx-runtime";
import { VoiceAgentStreamBranchMemoryTurn, VoiceAgentStreamBranchToolCall } from "../../shared/branches";
import {
  readAiInputConnections,
  readFixedCollectionItems,
  readStringParameter,
  requireActionValue,
} from "../shared/input-normalization";
import { resolveAiLegId } from "../shared/id-resolution";

type VoiceAgentToolBinding = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (argumentsObject: Record<string, unknown>, context?: { aiLegId?: string }) => Promise<string>;
};

type VoiceAgentExecutedToolCall = {
  voiceAgentRequestId: string;
  toolName: string;
  argumentsObject: Record<string, unknown>;
  outputText: string;
  isError: boolean;
};

type VoiceAgentMemoryBinding = {
  memoryText: string;
  saveTurn: (userText: string, assistantText: string, toolCalls?: VoiceAgentExecutedToolCall[]) => Promise<void>;
};

type LangChainMessageConstructors = {
  HumanMessage: new (fields: unknown) => unknown;
  AIMessage: new (fields: unknown) => unknown;
  ToolMessage: new (fields: unknown) => unknown;
};

type SipPbxToolInvokeContext = {
  aiLegId?: string;
};

type DynamicStructuredToolConstructor = new (fields: {
  name: string;
  description: string;
  schema: unknown;
  func: (input: Record<string, unknown>) => Promise<string>;
}) => Record<string, unknown>;

type JsonParseSuccess = {
  ok: true;
  value: unknown;
};

type JsonParseFailure = {
  ok: false;
};

let cachedLangChainMessageConstructors: LangChainMessageConstructors | null | false = null;
let cachedDynamicStructuredToolConstructor: DynamicStructuredToolConstructor | null | false = null;

function findNodeModulePackageRoot(packageName: string): string | null {
  const segments = packageName.split("/").filter(Boolean);
  const starts = [process.cwd(), __dirname];
  const seen = new Set<string>();
  for (const start of starts) {
    let current = path.resolve(start);
    while (!seen.has(current)) {
      seen.add(current);
      const candidate = path.join(current, "node_modules", ...segments);
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        return candidate;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return null;
}

function resolveExportTarget(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return resolveExportTarget(record.require)
    || resolveExportTarget(record.node)
    || resolveExportTarget(record.default)
    || Object.values(record).map(resolveExportTarget).find(Boolean)
    || null;
}

function resolvePackageExportFile(packageRoot: string, subpath: string): string | null {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  const exportsField = packageJson.exports && typeof packageJson.exports === "object"
    ? packageJson.exports as Record<string, unknown>
    : null;
  const exportKey = `./${subpath}`;
  const target = resolveExportTarget(exportsField?.[exportKey]);
  const candidates = [
    target,
    target ? `${target}.js` : null,
    target ? `${target}.cjs` : null,
    target ? `${target}.mjs` : null,
    target ? path.join(target, "index.js") : null,
    target ? path.join(target, "index.cjs") : null,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const absolute = path.resolve(packageRoot, candidate);
    if (fs.existsSync(absolute)) {
      return absolute;
    }
  }
  return null;
}

function okJson(value: unknown): JsonParseSuccess {
  return { ok: true, value };
}

function failJson(): JsonParseFailure {
  return { ok: false };
}

function parseJsonText(text: string): JsonParseSuccess | JsonParseFailure {
  const source = String(text || "");
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < source.length) {
      const ch = source[index];
      if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") {
        break;
      }
      index += 1;
    }
  };

  const parseLiteral = (literal: string, value: unknown): JsonParseSuccess | JsonParseFailure => {
    if (source.slice(index, index + literal.length) !== literal) {
      return failJson();
    }
    index += literal.length;
    return okJson(value);
  };

  const parseString = (): JsonParseSuccess | JsonParseFailure => {
    if (source[index] !== "\"") {
      return failJson();
    }
    index += 1;
    let output = "";
    while (index < source.length) {
      const ch = source[index]!;
      index += 1;
      if (ch === "\"") {
        return okJson(output);
      }
      if (ch === "\\") {
        if (index >= source.length) {
          return failJson();
        }
        const escape = source[index]!;
        index += 1;
        switch (escape) {
          case "\"":
          case "\\":
          case "/":
            output += escape;
            break;
          case "b":
            output += "\b";
            break;
          case "f":
            output += "\f";
            break;
          case "n":
            output += "\n";
            break;
          case "r":
            output += "\r";
            break;
          case "t":
            output += "\t";
            break;
          case "u": {
            const hex = source.slice(index, index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              return failJson();
            }
            output += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
            break;
          }
          default:
            return failJson();
        }
        continue;
      }
      if (ch < " ") {
        return failJson();
      }
      output += ch;
    }
    return failJson();
  };

  const isDigit = (ch: string | undefined): boolean => Boolean(ch && ch >= "0" && ch <= "9");

  const parseNumber = (): JsonParseSuccess | JsonParseFailure => {
    const start = index;
    if (source[index] === "-") {
      index += 1;
    }
    const first = source[index];
    if (first === "0") {
      index += 1;
    } else if (first && first >= "1" && first <= "9") {
      index += 1;
      while (isDigit(source[index])) {
        index += 1;
      }
    } else {
      return failJson();
    }
    if (source[index] === ".") {
      index += 1;
      if (!isDigit(source[index])) {
        return failJson();
      }
      while (isDigit(source[index])) {
        index += 1;
      }
    }
    const exponent = source[index];
    if (exponent === "e" || exponent === "E") {
      index += 1;
      if (source[index] === "+" || source[index] === "-") {
        index += 1;
      }
      if (!isDigit(source[index])) {
        return failJson();
      }
      while (isDigit(source[index])) {
        index += 1;
      }
    }
    const parsed = Number(source.slice(start, index));
    return Number.isFinite(parsed) ? okJson(parsed) : failJson();
  };

  const parseValue = (): JsonParseSuccess | JsonParseFailure => {
    skipWhitespace();
    const ch = source[index];
    if (!ch) {
      return failJson();
    }
    if (ch === "\"") {
      return parseString();
    }
    if (ch === "{") {
      index += 1;
      skipWhitespace();
      const record: Record<string, unknown> = {};
      if (source[index] === "}") {
        index += 1;
        return okJson(record);
      }
      while (index < source.length) {
        const keyResult = parseString();
        if (!keyResult.ok || typeof keyResult.value !== "string") {
          return failJson();
        }
        skipWhitespace();
        if (source[index] !== ":") {
          return failJson();
        }
        index += 1;
        const valueResult = parseValue();
        if (!valueResult.ok) {
          return failJson();
        }
        record[keyResult.value] = valueResult.value;
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return okJson(record);
        }
        if (source[index] !== ",") {
          return failJson();
        }
        index += 1;
        skipWhitespace();
      }
      return failJson();
    }
    if (ch === "[") {
      index += 1;
      skipWhitespace();
      const values: unknown[] = [];
      if (source[index] === "]") {
        index += 1;
        return okJson(values);
      }
      while (index < source.length) {
        const valueResult = parseValue();
        if (!valueResult.ok) {
          return failJson();
        }
        values.push(valueResult.value);
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return okJson(values);
        }
        if (source[index] !== ",") {
          return failJson();
        }
        index += 1;
        skipWhitespace();
      }
      return failJson();
    }
    if (ch === "t") {
      return parseLiteral("true", true);
    }
    if (ch === "f") {
      return parseLiteral("false", false);
    }
    if (ch === "n") {
      return parseLiteral("null", null);
    }
    return parseNumber();
  };

  const result = parseValue();
  if (!result.ok) {
    return result;
  }
  skipWhitespace();
  return index === source.length ? result : failJson();
}

function loadOptionalModuleByFile(file: string | null): Record<string, unknown> | null {
  if (!file) {
    return null;
  }
  try {
    return require(file) as Record<string, unknown>;
  } catch (error) {
    console.error(
      `[sip-pbx:n8n] optional module load failed; file=${file}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
    );
    return null;
  }
}

function loadOptionalLangChainModule(subpath: string): Record<string, unknown> | null {
  // Try Node's resolution first (handles various n8n layouts); custom walker is fallback.
  const moduleId = `@langchain/core/${subpath}`;
  try {
    return require(moduleId) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code && code !== "MODULE_NOT_FOUND") {
      console.error(
        `[sip-pbx:n8n] require("${moduleId}") failed; code=${code}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
      );
    }
  }
  const packageRoot = findNodeModulePackageRoot("@langchain/core");
  if (!packageRoot) {
    return null;
  }
  const file = resolvePackageExportFile(packageRoot, subpath);
  return loadOptionalModuleByFile(file);
}

function encodeStructuredJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value == null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => encodeStructuredJson(entry, seen)).join(",")}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString());
  }
  if (ArrayBuffer.isView(value)) {
    return encodeStructuredJson(Array.from(Buffer.from(value.buffer, value.byteOffset, value.byteLength)), seen);
  }
  if (value instanceof ArrayBuffer) {
    return encodeStructuredJson(Array.from(Buffer.from(value)), seen);
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return JSON.stringify("[Circular]");
    }
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => {
        const type = typeof entryValue;
        return type !== "undefined" && type !== "function" && type !== "symbol";
      })
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${encodeStructuredJson(entryValue, seen)}`);
    seen.delete(value);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function normalizeVoiceAgentRole(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "human" || normalized === "user") {
    return "User";
  }
  if (normalized === "ai" || normalized === "assistant") {
    return "Assistant";
  }
  if (normalized === "system") {
    return "System";
  }
  if (normalized === "tool") {
    return "Tool";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeVoiceAgentMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string") {
          return String((entry as Record<string, unknown>).text || "").trim();
        }
        return normalizeVoiceAgentText(entry);
      })
      .filter(Boolean)
      .join("\n");
  }
  return normalizeVoiceAgentText(value);
}

function normalizeKnownVoiceAgentHistory(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (Array.isArray(value)) {
    return normalizeVoiceAgentText(value);
  }
  return normalizeVoiceAgentText(value);
}

function formatVoiceAgentMessageObject(value: Record<string, unknown>): string {
  const lcKwargs = value.lc_kwargs && typeof value.lc_kwargs === "object"
    ? value.lc_kwargs as Record<string, unknown>
    : null;
  const kwargs = value.kwargs && typeof value.kwargs === "object"
    ? value.kwargs as Record<string, unknown>
    : null;
  const role = normalizeVoiceAgentRole(
    value.role
    ?? value.type
    ?? value.messageType
    ?? value.sender
    ?? lcKwargs?.role
    ?? lcKwargs?.type
    ?? kwargs?.role
    ?? kwargs?.type,
  );
  const content = normalizeVoiceAgentMessageContent(
    value.content
    ?? value.text
    ?? value.message
    ?? lcKwargs?.content
    ?? kwargs?.content,
  );
  if (!content) {
    return "";
  }
  return role ? `${role}: ${content}` : content;
}

function nodeNameToToolName(name: string): string {
  let toolName = String(name || "").replace(/[^a-zA-Z0-9_-]+/g, "_");
  if (toolName.length > 64) {
    toolName = toolName.slice(0, 64).replace(/[_-]+$/, "");
  }
  return toolName;
}

function loadDynamicStructuredToolConstructor(): DynamicStructuredToolConstructor {
  if (cachedDynamicStructuredToolConstructor === false) {
    throw new Error("SIP PBX AI tool requires @langchain/core/tools in the n8n runtime");
  }
  if (cachedDynamicStructuredToolConstructor) {
    return cachedDynamicStructuredToolConstructor;
  }
  const moduleExports = loadOptionalLangChainModule("tools");
  if (!moduleExports) {
    cachedDynamicStructuredToolConstructor = false;
    throw new Error("SIP PBX AI tool requires @langchain/core/tools in the n8n runtime");
  }
  if (typeof moduleExports.DynamicStructuredTool === "function") {
    cachedDynamicStructuredToolConstructor = moduleExports.DynamicStructuredTool as DynamicStructuredToolConstructor;
    return cachedDynamicStructuredToolConstructor;
  }
  cachedDynamicStructuredToolConstructor = false;
  throw new Error("SIP PBX AI tool requires @langchain/core/tools in the n8n runtime");
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function assertUniqueNamedEntries(
  entries: Array<{ name: string }>,
  label: string,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`${label} names must be unique. Duplicate name: ${entry.name}`);
    }
    seen.add(entry.name);
  }
}

function readAiFlowParams(node: any, itemIndex: number): Record<string, unknown> {
  const entries: Array<{ name: string; value: unknown }> = [];
  for (const entry of readFixedCollectionItems(node, "aiFlowParams", itemIndex)) {
    const name = String(entry.name || "").trim();
    if (!name) {
      continue;
    }
    entries.push({
      name,
      value: entry.value,
    });
  }
  assertUniqueNamedEntries(entries, "AI flow parameter");
  const output: Record<string, unknown> = {};
  for (const entry of entries) {
    output[entry.name] = entry.value;
  }
  return output;
}

function buildAiToolSchema(node: any, itemIndex: number): unknown {
  const entries = readFixedCollectionItems(node, "aiToolParams", itemIndex)
    .map((entry) => ({
      name: String(entry.name || "").trim(),
      description: String(entry.description || "").trim(),
      required: entry.required === true,
      type: String(entry.type || "string").trim() || "string",
    }))
    .filter((entry) => entry.name);
  assertUniqueNamedEntries(entries, "AI tool parameter");
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const entry of entries) {
    let field: z.ZodTypeAny;
    if (entry.type === "number") {
      field = z.number();
    } else if (entry.type === "integer") {
      field = z.number().int();
    } else if (entry.type === "boolean") {
      field = z.boolean();
    } else if (entry.type === "string") {
      field = z.string();
    } else {
      throw new Error(`Unsupported AI tool parameter type: ${entry.type}`);
    }
    if (entry.description) {
      field = field.describe(entry.description);
    }
    if (!entry.required) {
      field = field.optional();
    }
    shape[entry.name] = field;
  }
  return z.object(shape);
}

function normalizeVoiceAgentText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeVoiceAgentText(entry))
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const payload = value as Record<string, unknown>;
    const formattedMessage = formatVoiceAgentMessageObject(payload);
    if (formattedMessage) {
      return formattedMessage;
    }
    if ("history" in payload) {
      return normalizeKnownVoiceAgentHistory(payload.history) || "";
    }
    if ("chat_history" in payload) {
      return normalizeKnownVoiceAgentHistory(payload.chat_history) || "";
    }
    if ("messages" in payload) {
      return normalizeKnownVoiceAgentHistory(payload.messages) || "";
    }
    const directContent = normalizeVoiceAgentText(payload.content);
    if (directContent) {
      return directContent;
    }
    const text = normalizeVoiceAgentText(payload.text);
    if (text) {
      return text;
    }
    const lcKwargs = normalizeVoiceAgentText(payload.lc_kwargs);
    if (lcKwargs) {
      return lcKwargs;
    }
    return encodeStructuredJson(payload);
  }
  return value == null ? "" : String(value).trim();
}

function isZodSchemaLike(value: unknown): value is Record<string, unknown> & { _def: Record<string, unknown> } {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as Record<string, unknown>).safeParse === "function"
    && (value as Record<string, unknown>)._def
    && typeof (value as Record<string, unknown>)._def === "object",
  );
}

function buildLooseObjectJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function tryLoadLangChainMessageConstructors(): LangChainMessageConstructors | null {
  if (cachedLangChainMessageConstructors === false) {
    return null;
  }
  if (cachedLangChainMessageConstructors) {
    return cachedLangChainMessageConstructors;
  }
  const moduleExports = loadOptionalLangChainModule("messages");
  if (!moduleExports) {
    cachedLangChainMessageConstructors = false;
    return null;
  }
  // Try aggregated messages first, then per-class subpaths for newer builds.
  const HumanMessage = pickMessageConstructor(moduleExports, "HumanMessage", "messages/human");
  const AIMessage = pickMessageConstructor(moduleExports, "AIMessage", "messages/ai");
  const ToolMessage = pickMessageConstructor(moduleExports, "ToolMessage", "messages/tool");
  if (HumanMessage && AIMessage && ToolMessage) {
    cachedLangChainMessageConstructors = { HumanMessage, AIMessage, ToolMessage };
    return cachedLangChainMessageConstructors;
  }
  console.error(
    `[sip-pbx:n8n] @langchain/core/messages loaded but missing required constructors;`
    + ` human=${typeof HumanMessage}; ai=${typeof AIMessage}; tool=${typeof ToolMessage}`,
  );
  cachedLangChainMessageConstructors = false;
  return null;
}

function pickMessageConstructor(
  primary: Record<string, unknown>,
  exportName: string,
  fallbackSubpath: "messages/human" | "messages/ai" | "messages/tool",
): (new (fields: unknown) => unknown) | null {
  const direct = primary[exportName];
  if (typeof direct === "function") {
    return direct as new (fields: unknown) => unknown;
  }
  // Fall back to dedicated subpaths if aggregated export is missing constructors.
  const fallback = loadOptionalLangChainModule(fallbackSubpath);
  const candidate = fallback?.[exportName];
  return typeof candidate === "function" ? (candidate as new (fields: unknown) => unknown) : null;
}

function parseJsonObjectTextOrNull(text: string): Record<string, unknown> | null {
  const parsed = parseJsonText(String(text || "{}"));
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return null;
  }
  return parsed.value as Record<string, unknown>;
}

function normalizeVoiceAgentToolArgumentsJson(argumentsJson: string): Record<string, unknown> {
  return parseJsonObjectTextOrNull(argumentsJson) || {};
}

async function saveVoiceAgentNativeStructuredTurn(
  chatHistory: { addMessages: (messages: unknown[]) => Promise<void> },
  constructors: LangChainMessageConstructors,
  userText: string,
  assistantText: string,
  toolCalls: VoiceAgentExecutedToolCall[],
): Promise<void> {
  const messages: unknown[] = [
    new constructors.HumanMessage({ content: userText }),
    new constructors.AIMessage({
      content: assistantText,
      ...(toolCalls.length > 0 ? {
        tool_calls: toolCalls.map((toolCall) => ({
          id: toolCall.voiceAgentRequestId,
          name: toolCall.toolName,
          args: toolCall.argumentsObject,
          type: "tool_call",
        })),
      } : {}),
    }),
    ...toolCalls.map((toolCall) => new constructors.ToolMessage({
      content: toolCall.outputText,
      tool_call_id: toolCall.voiceAgentRequestId,
      name: toolCall.toolName,
      ...(toolCall.isError ? { additional_kwargs: { is_error: true } } : {}),
    })),
  ];
  await chatHistory.addMessages(messages);
}

function convertZodSchemaLikeToJsonSchema(value: unknown): Record<string, unknown> | null {
  if (!isZodSchemaLike(value)) {
    return null;
  }
  const schema = value;
  const typeName = String(schema._def?.typeName || "").trim();
  switch (typeName) {
    case "ZodObject": {
      const rawShape = typeof schema._def.shape === "function" ? schema._def.shape() : schema._def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(rawShape || {})) {
        const childSchema = convertZodSchemaLikeToJsonSchema(child) || {};
        properties[key] = childSchema;
        const childType = isZodSchemaLike(child) ? String(child._def?.typeName || "").trim() : "";
        if (!["ZodOptional", "ZodDefault"].includes(childType)) {
          required.push(key);
        }
      }
      return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      };
    }
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodArray":
      return { type: "array", items: convertZodSchemaLikeToJsonSchema(schema._def.type) || {} };
    case "ZodEnum":
      return { type: "string", enum: Array.isArray(schema._def.values) ? schema._def.values.slice() : [] };
    case "ZodNativeEnum": {
      const values = Object.values(schema._def.values || {}).filter((entry) => ["string", "number"].includes(typeof entry));
      const first = values[0];
      return {
        type: typeof first === "number" ? "number" : "string",
        enum: values,
      };
    }
    case "ZodLiteral":
      return { enum: [schema._def.value] };
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return convertZodSchemaLikeToJsonSchema(typeof schema.unwrap === "function" ? schema.unwrap() : schema._def.innerType) || {};
    case "ZodEffects":
      return convertZodSchemaLikeToJsonSchema(schema._def.schema) || {};
    case "ZodUnion": {
      const options = Array.isArray(schema._def.options)
        ? schema._def.options.map((entry: unknown) => convertZodSchemaLikeToJsonSchema(entry) || {})
        : [];
      return options.length > 0 ? { anyOf: options } : {};
    }
    default:
      return {};
  }
}

function normalizeVoiceAgentToolParameters(value: unknown): Record<string, unknown> {
  const zodSchema = convertZodSchemaLikeToJsonSchema(value);
  if (zodSchema && String(zodSchema.type || "").trim() === "object") {
    return zodSchema;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const direct = { ...(value as Record<string, unknown>) };
    if (String(direct.type || "").trim() === "object") {
      return direct;
    }
  }
  return buildLooseObjectJsonSchema();
}

async function maybeCallFunction(target: unknown, propertyName: string, arg1?: unknown, arg2?: unknown): Promise<unknown> {
  if (!target || typeof target !== "object") {
    return undefined;
  }
  const candidate = (target as Record<string, unknown>)[propertyName];
  if (typeof candidate !== "function") {
    return undefined;
  }
  if (arguments.length >= 4) {
    return await candidate.call(target, arg1, arg2);
  }
  if (arguments.length >= 3) {
    return await candidate.call(target, arg1);
  }
  return await candidate.call(target);
}

async function resolveVoiceAgentMemoryBinding(
  node: any,
  index: number,
  options?: { loadMemoryText?: boolean },
): Promise<VoiceAgentMemoryBinding | null> {
  const connected = await readAiInputConnections(node, "ai_memory", index);
  if (connected.length > 1) {
    throw new Error("AI action allows at most one ai_memory connection");
  }
  const memory = connected[0];
  if (!memory || typeof memory !== "object") {
    return null;
  }
  const constructors = tryLoadLangChainMessageConstructors();
  if (!constructors) {
    throw new Error("AI action ai_memory requires @langchain/core/messages for native structured persistence");
  }
  const memoryRecord = memory as Record<string, unknown>;
  const chatHistoryRecord = memoryRecord.chatHistory && typeof memoryRecord.chatHistory === "object"
    ? memoryRecord.chatHistory as Record<string, unknown>
    : null;
  if (!chatHistoryRecord || typeof chatHistoryRecord.addMessages !== "function") {
    throw new Error("AI action ai_memory must expose chatHistory.addMessages for native structured persistence");
  }
  const chatHistory = {
    addMessages: async (messages: unknown[]) => {
      await (chatHistoryRecord.addMessages as (messages: unknown[]) => Promise<void>).call(chatHistoryRecord, messages);
    },
  };
  const memoryText = options?.loadMemoryText === false
    ? ""
    : normalizeVoiceAgentText(await maybeCallFunction(memory, "loadMemoryVariables", {}));
  const saveTurn = async (userText: string, assistantText: string, toolCalls?: VoiceAgentExecutedToolCall[]): Promise<void> => {
    await saveVoiceAgentNativeStructuredTurn(
      chatHistory,
      constructors,
      userText,
      assistantText,
      Array.isArray(toolCalls) ? toolCalls : [],
    );
  };
  return {
    memoryText,
    saveTurn,
  };
}

async function resolveVoiceAgentToolBindings(node: any, index: number): Promise<VoiceAgentToolBinding[]> {
  const connected = await readAiInputConnections(node, "ai_tool", index);
  const bindings: VoiceAgentToolBinding[] = [];
  for (const tool of connected) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const toolEnvelope = tool as Record<string, unknown>;
    const toolRecord = toolEnvelope.response && typeof toolEnvelope.response === "object"
      ? toolEnvelope.response as Record<string, unknown>
      : toolEnvelope;
    const name = String(toolRecord.name || toolRecord.toolName || "").trim();
    if (!name) {
      continue;
    }
    const description = String(toolRecord.description || "").trim() || name;
    const parameters = normalizeVoiceAgentToolParameters(
      toolRecord.parameters
      ?? toolRecord.schema
      ?? toolRecord.inputSchema
      ?? toolRecord.input_schema
      ?? toolRecord.jsonSchema,
    );
    bindings.push({
      name,
      description,
      parameters,
      execute: async (argumentsObject, context) => {
        const result =
          await maybeCallFunction(toolRecord, "invokeForSipPbx", argumentsObject, context || {})
          ?? await maybeCallFunction(toolRecord, "invoke", argumentsObject)
          ?? await maybeCallFunction(toolRecord, "execute", argumentsObject)
          ?? await maybeCallFunction(toolRecord, "call", argumentsObject);
        if (result == null) {
          return "";
        }
        if (typeof result === "string") {
          return result;
        }
        const normalized = normalizeVoiceAgentText(result);
        if (normalized) {
          return normalized;
        }
        return encodeStructuredJson(result);
      },
    });
  }
  return bindings;
}

async function handleVoiceAgentStreamEvent(
  runtime: PbxRuntime,
  event: { branch: string; payload: Record<string, unknown> },
  tools: VoiceAgentToolBinding[],
  memory: VoiceAgentMemoryBinding | null,
): Promise<void> {
  if (event.branch === VoiceAgentStreamBranchToolCall) {
    const voiceAgentRequestId = String(event.payload.voiceAgentRequestId || "").trim();
    const toolName = String(event.payload.toolName || "").trim();
    if (!voiceAgentRequestId || !toolName) {
      return;
    }
    const tool = tools.find((entry) => entry.name === toolName) || null;
    if (!tool) {
      await runtime.respondVoiceAgentToolCall({
        voiceAgentRequestId,
        outputText: `Unknown tool: ${toolName}`,
        isError: true,
      });
      return;
    }
    try {
      const argumentsJson = String(event.payload.argumentsJson || "{}");
      const parsed = JSON.parse(argumentsJson);
      const argumentsObject = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
      const outputText = await tool.execute(argumentsObject, {
        aiLegId: String(event.payload.legId || "").trim(),
      });
      await runtime.respondVoiceAgentToolCall({
        voiceAgentRequestId,
        outputText,
      });
    } catch (error) {
      const outputText = error instanceof Error ? error.message : String(error || "tool_execution_failed");
      await runtime.respondVoiceAgentToolCall({
        voiceAgentRequestId,
        outputText,
        isError: true,
      });
    }
    return;
  }
  if (event.branch === VoiceAgentStreamBranchMemoryTurn && memory) {
    const userText = String(event.payload.userText || "").trim();
    const assistantText = String(event.payload.assistantText || "").trim();
    const toolCalls = Array.isArray(event.payload.toolCalls)
      ? event.payload.toolCalls
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => {
          const payload = entry as Record<string, unknown>;
          return {
            voiceAgentRequestId: String(payload.voiceAgentRequestId || "").trim(),
            toolName: String(payload.toolName || "").trim(),
            argumentsObject: normalizeVoiceAgentToolArgumentsJson(String(payload.argumentsJson || "{}")),
            outputText: String(payload.outputText || ""),
            isError: payload.isError === true,
          };
        })
        .filter((entry) => entry.voiceAgentRequestId && entry.toolName)
      : [];
    if (!userText || (!assistantText && toolCalls.length === 0)) {
      return;
    }
    await memory.saveTurn(userText, assistantText, toolCalls);
    return;
  }
}

export async function executeAttachVoiceAgent(node: any, runtime: PbxRuntime, item: any, index: number): Promise<any> {
  const legId = requireActionValue("legId", resolveAiLegId(node, item, index));
  const memory = await resolveVoiceAgentMemoryBinding(node, index, { loadMemoryText: true });
  const tools = await resolveVoiceAgentToolBindings(node, index);
  let streamEventChain = Promise.resolve();
  const stream = await runtime.openVoiceAgentStream({
    legId,
    ...(memory ? { hasConnectedMemory: true } : {}),
    ...(memory?.memoryText ? { memoryText: memory.memoryText } : {}),
    ...(memory ? { needsInputTranscription: true } : {}),
    ...(tools.length > 0 ? {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    } : {}),
  }, (event) => {
    const runEvent = async (): Promise<void> => {
      try {
        await handleVoiceAgentStreamEvent(runtime, event, tools, memory);
      } catch (error) {
        console.error(
          `[sip-pbx:n8n] voice agent stream event handling failed; branch=${event.branch}; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
        );
      }
    };
    streamEventChain = streamEventChain.then(runEvent, runEvent);
  });
  try {
    const result = await runtime.attachVoiceAgent(legId);
    await streamEventChain;
    return result;
  } finally {
    await stream.close();
  }
}

export async function supplyAiTool(node: any, runtime: PbxRuntime, itemIndex: number): Promise<SupplyData> {
  const ref = requireActionValue("ref", readStringParameter(node, "ref", itemIndex, ""));
  const description = requireActionValue("aiToolDescription", readStringParameter(node, "aiToolDescription", itemIndex, ""));
  const flowParams = readAiFlowParams(node, itemIndex);
  const schema = buildAiToolSchema(node, itemIndex);
  const DynamicStructuredTool = loadDynamicStructuredToolConstructor();
  const rawNode = typeof node?.getNode === "function" ? node.getNode() : null;
  const toolName = nodeNameToToolName(String(rawNode?.name || "sip_pbx_ai_trigger"));
  const tool = new DynamicStructuredTool({
    name: toolName,
    description,
    schema,
    func: async () => {
      throw new Error("SIP PBX AI tool requires a live voice-agent AI leg context");
    },
  });
  (tool as Record<string, unknown>).invokeForSipPbx = async (
    toolParams: Record<string, unknown>,
    context?: SipPbxToolInvokeContext,
  ): Promise<string> => {
    const aiLegId = String(context?.aiLegId || "").trim();
    if (!aiLegId) {
      throw new Error("SIP PBX AI tool requires a live voice-agent AI leg context");
    }
    const result = await runtime.invokeAiTool({
      ref,
      aiLegId,
      flowParams,
      toolParams: normalizeObject(toolParams),
    });
    return String((result as Record<string, unknown>).outputText || "");
  };
  return { response: tool };
}
