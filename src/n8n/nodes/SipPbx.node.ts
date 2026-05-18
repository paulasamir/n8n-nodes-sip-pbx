import type { ILoadOptionsFunctions, INodePropertyOptions } from "n8n-workflow";
import { getPbxRuntime } from "../../runtime/runtime-factory";
import { supplyAiTool } from "../actions/ai-actions";
import { createSipPbxActionDescription } from "../ui/action-description";
import { executeSipPbxActionNode } from "../actions/execute-action-node";
import { readStringParameter, type NodeParameterReader } from "../shared/input-normalization";
import { OPTION_DEFAULTS } from "../../shared/option-defaults";

type ActionNodeScope = NodeParameterReader & {
  getWorkflow?: () => { id?: unknown } | null;
};

function sortModelIds(ids: string[], preferredIds: string[]): string[] {
  const preferredOrder = new Map(preferredIds.map((id, index) => [id, index]));
  return [...new Set(ids)].sort((left, right) => {
    const leftPreferred = preferredOrder.get(left);
    const rightPreferred = preferredOrder.get(right);
    if (leftPreferred != null || rightPreferred != null) {
      if (leftPreferred == null) return 1;
      if (rightPreferred == null) return -1;
      return leftPreferred - rightPreferred;
    }
    return left.localeCompare(right);
  });
}

function toModelOptions(ids: string[], preferredIds: string[]): INodePropertyOptions[] {
  return sortModelIds(ids, preferredIds).map((id) => ({ name: id, value: id }));
}

async function requestCredentialBoundJson(
  context: ILoadOptionsFunctions,
  credentialType: string,
  url: string,
  qs?: Record<string, unknown>,
): Promise<any> {
  return await context.helpers.httpRequestWithAuthentication.call(context, credentialType, {
    method: "GET",
    url,
    qs,
    json: true,
  });
}

async function loadOpenAiModelIds(context: ILoadOptionsFunctions): Promise<string[]> {
  const response = await requestCredentialBoundJson(context, "openAiApi", "https://api.openai.com/v1/models");
  const models = Array.isArray(response?.data) ? response.data : [];
  return models
    .map((entry) => String(entry?.id || "").trim())
    .filter(Boolean);
}

async function loadGeminiModels(context: ILoadOptionsFunctions): Promise<Array<Record<string, unknown>>> {
  const response = await requestCredentialBoundJson(
    context,
    "googlePalmApi",
    "https://generativelanguage.googleapis.com/v1beta/models",
    { pageSize: 1000 },
  );
  return Array.isArray(response?.models) ? response.models as Array<Record<string, unknown>> : [];
}

function normalizeGeminiModelId(raw: unknown): string {
  const value = String(raw || "").trim();
  return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function supportsGeminiLive(model: Record<string, unknown>): boolean {
  const modelId = normalizeGeminiModelId(model.name);
  if (/(^|[-_])(live|native-audio)/i.test(modelId)) {
    return true;
  }
  const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
  return methods.some((method) => /bidi(generate)?content/i.test(String(method || "")));
}

async function getOpenAiRealtimeModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const ids = (await loadOpenAiModelIds(this)).filter((id) => /realtime/i.test(id));
  if (ids.length === 0) {
    throw new Error("OpenAI did not return any realtime models for the configured credential");
  }
  return toModelOptions(ids, [OPTION_DEFAULTS.dial.openaiRealtimeModel]);
}

async function getOpenAiRealtimeInputTranscriptionModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const ids = (await loadOpenAiModelIds(this)).filter((id) => /(transcribe|whisper)/i.test(id));
  if (ids.length === 0) {
    throw new Error("OpenAI did not return any transcription models for the configured credential");
  }
  return toModelOptions(ids, [OPTION_DEFAULTS.dial.openaiRealtimeInputTranscriptionModel]);
}

async function getGeminiLiveModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const ids = (await loadGeminiModels(this))
    .filter(supportsGeminiLive)
    .map((model) => normalizeGeminiModelId(model.name))
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("Gemini did not return any Live-capable models for the configured credential");
  }
  return toModelOptions(ids, [OPTION_DEFAULTS.dial.geminiLiveModel]);
}

export class SipPbx {
  description: Record<string, unknown>;
  methods: Record<string, unknown>;

  constructor() {
    this.description = createSipPbxActionDescription();
    this.methods = {
      loadOptions: {
        getOpenAiRealtimeModels,
        getOpenAiRealtimeInputTranscriptionModels,
        getGeminiLiveModels,
      },
    };
  }

  async execute(): Promise<any> {
    const scope = this as unknown as ActionNodeScope;
    return await executeSipPbxActionNode(scope, getPbxRuntime(scope));
  }

  async supplyData(itemIndex: number): Promise<any> {
    const scope = this as unknown as ActionNodeScope;
    const operation = readStringParameter(scope, "operation", itemIndex, OPTION_DEFAULTS.common.string);
    if (operation !== "ai.invokeAiTool") {
      throw new Error(`Operation ${operation || "none"} is not usable as an AI tool`);
    }
    return await supplyAiTool(scope, getPbxRuntime(scope), itemIndex);
  }
}
