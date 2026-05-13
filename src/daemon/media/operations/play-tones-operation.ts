import { OPTION_DEFAULTS, type PlayTonePreset } from "../../../shared/option-defaults";
import type { MapRegistry } from "../../../shared/map-registry";
import { MediaOperation, MEDIA_OPERATION_CONSTRUCTOR_TOKEN, type MediaStatus } from "./media-operation";

export type CanonicalToneSegment = {
  frequencies: number[];
  durationMs: number;
};

export function findExactPlayTonePreset(value: unknown): PlayTonePreset | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return OPTION_DEFAULTS.playTone.presets.find((preset) => preset.value === normalized) || null;
}

export function findPlayTonePreset(value: unknown): PlayTonePreset {
  return findExactPlayTonePreset(value) || OPTION_DEFAULTS.playTone.presets[0]!;
}

export function parseCanonicalToneSegments(value: string): CanonicalToneSegment[] | null {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return null;
  }
  const segments: CanonicalToneSegment[] = [];
  for (const rawSegment of normalized.split(",")) {
    const segment = String(rawSegment || "").trim();
    if (!segment) {
      continue;
    }
    const slashIndex = segment.indexOf("/");
    if (slashIndex <= 0 || slashIndex >= segment.length - 1) {
      return null;
    }
    const rawFrequencies = segment.slice(0, slashIndex).trim();
    const rawDurationMs = segment.slice(slashIndex + 1).trim();
    const durationMs = Number(rawDurationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return null;
    }
    const frequencies = rawFrequencies === "0"
      ? []
      : rawFrequencies
        .split("+")
        .map((entry) => Number(String(entry || "").trim()))
        .filter((entry) => Number.isFinite(entry) && entry > 0);
    if (rawFrequencies !== "0" && frequencies.length === 0) {
      return null;
    }
    segments.push({
      frequencies,
      durationMs,
    });
  }
  return segments.length > 0 ? segments : null;
}

export function getCanonicalToneDurationMs(value: string): number | null {
  const segments = parseCanonicalToneSegments(value);
  if (!segments || segments.length === 0) {
    return null;
  }
  return segments.reduce((sum, segment) => sum + segment.durationMs, 0);
}

export function getPlayToneDurationMs(input: { tone: unknown; customTone?: unknown }): number {
  const tone = String(input.tone || "").trim().toLowerCase();
  if (tone === "custom") {
    const customDurationMs = getCanonicalToneDurationMs(String(input.customTone || ""));
    if (customDurationMs != null) {
      return customDurationMs;
    }
  }
  const preset = findPlayTonePreset(tone || OPTION_DEFAULTS.playTone.tone);
  return getCanonicalToneDurationMs(preset.customTone) || 1000;
}

type PlayTonesOperationInput = {
  mediaId: string;
  legId: string;
  tone: string;
  loopPlayback: boolean;
  durationMs: number;
  options?: Record<string, unknown>;
  onDestroy?: (
    operation: MediaOperation,
    status: MediaStatus,
    result: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

export class PlayTonesOperation extends MediaOperation {
  readonly tone: string;
  readonly loopPlayback: boolean;
  readonly durationMs: number;

  private constructor(input: PlayTonesOperationInput, token: symbol) {
    super({
      mediaId: input.mediaId,
      legId: input.legId,
      kind: "tone",
      options: input.options,
      onDestroy: input.onDestroy,
    }, token);
    this.tone = input.tone;
    this.loopPlayback = input.loopPlayback;
    this.durationMs = input.durationMs;
  }

  static create(registry: MapRegistry<string, MediaOperation>, input: PlayTonesOperationInput): PlayTonesOperation {
    const operation = new PlayTonesOperation(input, MEDIA_OPERATION_CONSTRUCTOR_TOKEN);
    registry.store(operation.mediaId, operation);
    operation.bindRegistryDetach(() => {
      registry.remove(operation.mediaId);
    });
    return operation;
  }

  get duckingFactor(): number {
    return Number(this.options.duckingFactor == null ? 1 : this.options.duckingFactor);
  }

  get interruptOnDtmf(): boolean {
    return Boolean(this.options.interruptOnDtmf);
  }

  get interruptOnVoice(): boolean {
    return Boolean(this.options.interruptOnVoice);
  }

  get voiceThreshold(): number {
    return Number(this.options.voiceThreshold || 0);
  }

  get voiceDurationMs(): number {
    return Number(this.options.voiceDurationMs || 0);
  }
}
