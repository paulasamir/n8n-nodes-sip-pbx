import type { MapRegistry } from "../../../shared/map-registry";
import { MediaOperation, MEDIA_OPERATION_CONSTRUCTOR_TOKEN, type MediaStatus } from "./media-operation";

type PlayAudioOperationInput = {
  mediaId: string;
  legId: string;
  sourceRef?: string | null;
  options?: Record<string, unknown>;
  onDestroy?: (
    operation: MediaOperation,
    status: MediaStatus,
    result: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

export class PlayAudioOperation extends MediaOperation {
  readonly sourceRef: string | null;

  private constructor(input: PlayAudioOperationInput, token: symbol) {
    super({
      mediaId: input.mediaId,
      legId: input.legId,
      kind: "playback",
      options: input.options,
      onDestroy: input.onDestroy,
    }, token);
    this.sourceRef = input.sourceRef == null ? null : String(input.sourceRef || "");
  }

  static create(registry: MapRegistry<string, MediaOperation>, input: PlayAudioOperationInput): PlayAudioOperation {
    const operation = new PlayAudioOperation(input, MEDIA_OPERATION_CONSTRUCTOR_TOKEN);
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
