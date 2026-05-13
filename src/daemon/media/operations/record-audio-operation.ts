import { OPTION_DEFAULTS } from "../../../shared/option-defaults";
import type { MapRegistry } from "../../../shared/map-registry";
import { MediaOperation, MEDIA_OPERATION_CONSTRUCTOR_TOKEN, type MediaStatus } from "./media-operation";

type RecordAudioOperationInput = {
  mediaId: string;
  legId: string;
  options?: Record<string, unknown>;
  onDestroy?: (
    operation: MediaOperation,
    status: MediaStatus,
    result: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

export class RecordAudioOperation extends MediaOperation {
  private constructor(input: RecordAudioOperationInput, token: symbol) {
    super({
      mediaId: input.mediaId,
      legId: input.legId,
      kind: "recording",
      options: input.options,
      onDestroy: input.onDestroy,
    }, token);
  }

  static create(registry: MapRegistry<string, MediaOperation>, input: RecordAudioOperationInput): RecordAudioOperation {
    const operation = new RecordAudioOperation(input, MEDIA_OPERATION_CONSTRUCTOR_TOKEN);
    registry.store(operation.mediaId, operation);
    operation.bindRegistryDetach(() => {
      registry.remove(operation.mediaId);
    });
    return operation;
  }

  get maxDurationMs(): number {
    return Math.max(0, Math.round(Number(this.options.maxDurationSeconds || 0) * 1000));
  }

  get fileFormat(): string {
    return String(this.options.recordFileFormat || OPTION_DEFAULTS.recordAudio.fileFormat).trim().toLowerCase();
  }

  get wavSampleRate(): number {
    return Number(this.options.recordWavSampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate);
  }

  get wavBitDepth(): number {
    return Number(this.options.recordWavBitDepth || OPTION_DEFAULTS.recordAudio.wavBitDepth);
  }

  get compressedSampleRate(): number {
    return Number(this.options.recordCompressedSampleRate || this.options.recordMp3SampleRate || OPTION_DEFAULTS.recordAudio.compressedSampleRate);
  }

  get compressedBitrateKbps(): number {
    return Number(this.options.recordCompressedBitrate || this.options.recordMp3Bitrate || OPTION_DEFAULTS.recordAudio.compressedBitrateKbps);
  }
}
