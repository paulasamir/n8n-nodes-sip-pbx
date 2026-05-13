import { OPTION_DEFAULTS } from "../../../../shared/option-defaults";
import { findPlayTonePreset, parseCanonicalToneSegments } from "../../operations/play-tones-operation";
import type { BufferReleasePool } from "../../streams/media-stream";
import { Media } from "./media";

function clampPcm16(sample: number): number {
  if (sample > 32767) {
    return 32767;
  }
  if (sample < -32768) {
    return -32768;
  }
  return sample | 0;
}

function readPcm16Sample(buffer: Buffer, offset: number): number {
  const low = buffer[offset] || 0;
  const high = buffer[offset + 1] || 0;
  const value = (high << 8) | low;
  return value & 0x8000 ? value - 0x10000 : value;
}

function writePcm16Sample(buffer: Buffer, offset: number, value: number): void {
  const normalized = clampPcm16(value);
  const unsigned = normalized < 0 ? 0x10000 + normalized : normalized;
  buffer[offset] = unsigned & 0xff;
  buffer[offset + 1] = (unsigned >> 8) & 0xff;
}

function toPcm16View(buffer: Buffer): Int16Array | null {
  if (buffer.length < 2 || (buffer.byteOffset & 1) !== 0) {
    return null;
  }
  return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
}

type PlaybackSource = {
  kind: "buffered";
  queue: PlaybackChunk[];
  queueCursor: number;
  queueBytes: number;
  current: PlaybackChunk | null;
  offset: number;
  loop: boolean;
  finished: boolean;
  completionEmitted: boolean;
  loopSeed: PlaybackChunk | null;
};

type PlaybackChunk = {
  pcm: Buffer;
  bytes: number;
  releasePool?: BufferReleasePool | null;
};

type ToneSegment = {
  frequencies: number[];
  durationSamples: number;
};

type TonePlaybackSource = {
  kind: "tone";
  segments: ToneSegment[];
  segmentIndex: number;
  segmentOffsetSamples: number;
  remainingSamples: number;
  loop: boolean;
  completionEmitted: boolean;
  amplitude: number;
  sampleRate: number;
  phaseByFrequency: Map<number, number>;
  definition: {
    tone: string;
    customTone: string | null;
    loop: boolean;
    amplitude: number;
  };
};

type AnyPlaybackSource = PlaybackSource | TonePlaybackSource;

type ToneSourceInput = {
  tone: string;
  customTone?: string | null;
  durationMs: number;
  loop: boolean;
  sampleRate?: number;
  amplitude?: number;
};

export type MixerPlaybackState = {
  mediaId: string;
  effectiveGain: number;
};

export type MixerSnapshot = {
  activePlaybackMediaIds: string[];
  playbackMix: MixerPlaybackState[];
};

function buildBuiltinToneSegments(tone: string, sampleRate: number): ToneSegment[] {
  const preset = findPlayTonePreset(tone);
  const segments = parseCanonicalToneSegments(preset.customTone) || parseCanonicalToneSegments(findPlayTonePreset(OPTION_DEFAULTS.playTone.tone).customTone) || [];
  return segments.map((segment) => ({
    frequencies: segment.frequencies.slice(),
    durationSamples: Math.max(1, Math.round((segment.durationMs / 1000) * sampleRate)),
  }));
}

function parseCustomToneSegments(value: string, sampleRate: number): ToneSegment[] | null {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return null;
  }
  const segments: ToneSegment[] = [];
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
      durationSamples: Math.max(1, Math.round((durationMs / 1000) * sampleRate)),
    });
  }
  return segments.length > 0 ? segments : null;
}

function createToneSegments(input: ToneSourceInput): ToneSegment[] {
  const sampleRate = Math.max(1, Number(input.sampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate));
  if (String(input.tone || "").trim().toLowerCase() === "custom") {
    return parseCustomToneSegments(String(input.customTone || ""), sampleRate)
      || buildBuiltinToneSegments(OPTION_DEFAULTS.playTone.tone, sampleRate);
  }
  return buildBuiltinToneSegments(input.tone, sampleRate);
}

function setEquals(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function releasePlaybackChunk(chunk: PlaybackChunk | null | undefined): void {
  if (!chunk?.releasePool) {
    return;
  }
  try {
    chunk.releasePool.release(chunk.pcm);
  } catch (error) {
    console.error(
      `[sip-pbx:media-worker] playback chunk release failed; error=${error instanceof Error ? error.message : String(error || "unknown")}`,
    );
  }
}

export class Mixer {
  private readonly mediaById = new Map<string, Media>();
  private readonly sources = new Map<string, AnyPlaybackSource>();

  addMedia(media: Media): void {
    this.mediaById.set(media.mediaId, media);
  }

  removeMedia(mediaId: string): Media | null {
    const media = this.mediaById.get(mediaId) || null;
    if (media) {
      this.mediaById.delete(mediaId);
    }
    return media;
  }

  getMedia(mediaId: string): Media | null {
    return this.mediaById.get(mediaId) || null;
  }

  listMediaIds(): string[] {
    return Array.from(this.mediaById.keys());
  }

  setSource(mediaId: string, pcm: Buffer, loop: boolean): void {
    this.removeSource(mediaId);
    this.sources.set(mediaId, {
      kind: "buffered",
      queue: loop ? [] : (pcm.length ? [{ pcm, bytes: pcm.length }] : []),
      queueCursor: 0,
      queueBytes: loop ? 0 : pcm.length,
      current: null,
      offset: 0,
      loop,
      finished: !loop,
      completionEmitted: false,
      loopSeed: pcm.length ? { pcm, bytes: pcm.length } : null,
    });
  }

  setToneSource(mediaId: string, input: ToneSourceInput): void {
    const sampleRate = Math.max(1, Number(input.sampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate));
    const amplitude = Math.max(0, Number(input.amplitude == null ? 0.2 : input.amplitude));
    const segments = createToneSegments({
      ...input,
      sampleRate,
    });
    this.sources.set(mediaId, {
      kind: "tone",
      segments,
      segmentIndex: 0,
      segmentOffsetSamples: 0,
      remainingSamples: input.loop
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.round((Math.max(1, Number(input.durationMs || 0)) / 1000) * sampleRate)),
      loop: Boolean(input.loop),
      completionEmitted: false,
      amplitude,
      sampleRate,
      phaseByFrequency: new Map<number, number>(),
      definition: {
        tone: String(input.tone || OPTION_DEFAULTS.playTone.tone),
        customTone: input.customTone == null ? null : String(input.customTone || ""),
        loop: Boolean(input.loop),
        amplitude,
      },
    });
  }

  reconfigureToneSources(sampleRate: number): void {
    const normalizedSampleRate = Math.max(1, Number(sampleRate || OPTION_DEFAULTS.recordAudio.wavSampleRate));
    for (const source of this.sources.values()) {
      if (source.kind !== "tone" || source.sampleRate === normalizedSampleRate) {
        continue;
      }
      const previousSegment = source.segments[source.segmentIndex] || null;
      const segmentElapsedMs = previousSegment
        ? Math.max(0, (source.segmentOffsetSamples / Math.max(1, source.sampleRate)) * 1000)
        : 0;
      const remainingMs = source.loop
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.round((source.remainingSamples / Math.max(1, source.sampleRate)) * 1000));
      const nextSegments = createToneSegments({
        tone: source.definition.tone,
        customTone: source.definition.customTone,
        durationMs: Math.max(1, remainingMs || 1),
        loop: source.definition.loop,
        sampleRate: normalizedSampleRate,
        amplitude: source.definition.amplitude,
      });
      let nextSegmentIndex = Math.min(source.segmentIndex, Math.max(0, nextSegments.length - 1));
      let nextSegmentOffsetSamples = Math.max(0, Math.round((segmentElapsedMs / 1000) * normalizedSampleRate));
      while (nextSegments.length > 0) {
        const segment = nextSegments[nextSegmentIndex] || null;
        if (!segment || nextSegmentOffsetSamples < segment.durationSamples) {
          break;
        }
        nextSegmentOffsetSamples -= segment.durationSamples;
        if (source.loop) {
          nextSegmentIndex = (nextSegmentIndex + 1) % nextSegments.length;
          continue;
        }
        if (nextSegmentIndex + 1 >= nextSegments.length) {
          nextSegmentOffsetSamples = Math.max(0, segment.durationSamples - 1);
          break;
        }
        nextSegmentIndex += 1;
      }
      source.segments = nextSegments;
      source.segmentIndex = nextSegmentIndex;
      source.segmentOffsetSamples = nextSegmentOffsetSamples;
      source.remainingSamples = source.loop
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.round((remainingMs / 1000) * normalizedSampleRate));
      source.sampleRate = normalizedSampleRate;
    }
  }

  appendChunk(mediaId: string, pcm: Buffer, bytes: number, releasePool?: BufferReleasePool | null): number {
    if (!this.mediaById.has(mediaId)) {
      return 0;
    }
    const source = this.ensureSource(mediaId);
    const normalizedBytes = Math.max(0, Math.min(Number(bytes) || 0, pcm.length));
    if (!normalizedBytes) {
      return source.queueBytes + (source.current ? source.current.bytes - source.offset : 0);
    }
    source.queue.push({ pcm, bytes: normalizedBytes, releasePool });
    source.queueBytes += normalizedBytes;
    return source.queueBytes + (source.current ? source.current.bytes - source.offset : 0);
  }

  finishSource(mediaId: string): void {
    const source = this.ensureSource(mediaId);
    if (!source.loop) {
      source.finished = true;
    }
  }

  removeSource(mediaId: string): void {
    const source = this.sources.get(mediaId);
    if (!source) {
      return;
    }
    const startedAt = Date.now();
    this.releaseSource(source);
    this.sources.delete(mediaId);
    console.error(
      `[sip-pbx:media-worker] mixer.removeSource media=${mediaId}; elapsedMs=${Math.max(0, Date.now() - startedAt)}`,
    );
  }

  clear(): void {
    for (const source of this.sources.values()) {
      this.releaseSource(source);
    }
    this.sources.clear();
    this.mediaById.clear();
  }

  private dropCurrentBufferedChunk(source: PlaybackSource): void {
    if (source.current && source.current !== source.loopSeed) {
      releasePlaybackChunk(source.current);
    }
    source.current = null;
    source.offset = 0;
  }

  private advanceBufferedSource(source: PlaybackSource): boolean {
    this.dropCurrentBufferedChunk(source);
    if (source.loop && source.loopSeed?.bytes) {
      source.current = source.loopSeed;
      return true;
    }
    if (source.queueCursor < source.queue.length) {
      const next = source.queue[source.queueCursor] || null;
      source.queueCursor += 1;
      source.queueBytes -= next?.bytes || 0;
      source.current = next;
      source.offset = 0;
      if (source.queueCursor >= source.queue.length) {
        source.queue.length = 0;
        source.queueCursor = 0;
      } else if (source.queueCursor > 64 && source.queueCursor * 2 >= source.queue.length) {
        source.queue = source.queue.slice(source.queueCursor);
        source.queueCursor = 0;
      }
      return Boolean(source.current);
    }
    return false;
  }

  private releaseSource(source: AnyPlaybackSource): void {
    if (source.kind === "tone") {
      return;
    }
    this.dropCurrentBufferedChunk(source);
    source.loopSeed = null;
    for (let index = source.queueCursor; index < source.queue.length; index += 1) {
      releasePlaybackChunk(source.queue[index] || null);
    }
    source.queue.length = 0;
    source.queueCursor = 0;
    source.queueBytes = 0;
    source.current = null;
    source.offset = 0;
  }

  hasRemainingAudio(snapshot: MixerSnapshot): boolean {
    return snapshot.activePlaybackMediaIds.some((mediaId) => {
      const source = this.sources.get(mediaId);
      if (!source) {
        return false;
      }
      if (source.kind === "tone") {
        return source.loop || source.remainingSamples > 0;
      }
      return source.loop
        || !source.finished
        || source.queueBytes > 0
        || Boolean(source.current && source.offset < source.current.bytes);
    });
  }

  takeFinishedSources(snapshot: MixerSnapshot): string[] {
    const finished: string[] = [];
    for (const mediaId of snapshot.activePlaybackMediaIds) {
      const source = this.sources.get(mediaId);
      if (!source || source.loop || source.completionEmitted) {
        continue;
      }
      if (source.kind === "tone") {
        if (source.remainingSamples <= 0) {
          source.completionEmitted = true;
          finished.push(mediaId);
        }
        continue;
      }
      const bufferedCurrentRemaining = source.current ? source.current.bytes - source.offset : 0;
      if (source.finished && source.queueBytes <= 0 && bufferedCurrentRemaining <= 0) {
        source.completionEmitted = true;
        finished.push(mediaId);
      }
    }
    return finished;
  }

  mixFrame(snapshot: MixerSnapshot, frameBytes: number, target?: Buffer): Buffer | null {
    if (frameBytes <= 0 || snapshot.activePlaybackMediaIds.length === 0) {
      return null;
    }
    const sampleCount = Math.floor(frameBytes / 2);
    if (sampleCount <= 0) {
      return null;
    }
    const mixed = target && target.length >= frameBytes ? target : Buffer.allocUnsafe(frameBytes);
    if (snapshot.playbackMix.length === 1) {
      const playback = snapshot.playbackMix[0] || null;
      if (!playback) {
        return null;
      }
      const source = this.sources.get(playback.mediaId) || null;
      if (!source) {
        return null;
      }
      const gain = Number(playback.effectiveGain || 0);
      if (!Number.isFinite(gain) || gain === 0) {
        return null;
      }
      const hasAudio = source.kind === "tone"
        ? this.renderToneSourceInto(mixed, source, frameBytes, gain)
        : this.renderSingleBufferedSourceInto(mixed, source, frameBytes, gain);
      return hasAudio ? mixed : null;
    }
    mixed.fill(0);
    let hasAudio = false;
    for (const playback of snapshot.playbackMix) {
      const source = this.sources.get(playback.mediaId);
      if (!source) {
        continue;
      }
      const gain = Number(playback.effectiveGain || 0);
      if (!Number.isFinite(gain) || gain === 0) {
        continue;
      }
      if (!hasAudio && source.kind === "buffered" && gain === 1) {
        hasAudio = this.copySourceInto(mixed, source, frameBytes) || hasAudio;
        continue;
      }
      hasAudio = (source.kind === "tone"
        ? this.mixToneSourceInto(mixed, source, frameBytes, gain)
        : this.mixSourceInto(mixed, source, frameBytes, gain)) || hasAudio;
    }
    return hasAudio ? mixed : null;
  }

  private renderSingleBufferedSourceInto(target: Buffer, source: PlaybackSource, frameBytes: number, gain: number): boolean {
    let written = 0;
    let hasAudio = false;
    const targetView = toPcm16View(target);
    while (written < frameBytes) {
      if (!source.current || source.offset >= source.current.bytes) {
        if (!this.advanceBufferedSource(source)) {
          break;
        }
      }
      if (!source.current) {
        break;
      }
      const current = source.current;
      const remainingSource = current.bytes - source.offset;
      const remainingFrame = frameBytes - written;
      const chunkSize = Math.min(remainingSource, remainingFrame);
      const copyBytes = chunkSize - (chunkSize % 2);
      if (copyBytes <= 0) {
        break;
      }
      hasAudio = true;
      if (gain === 1) {
        current.pcm.copy(target, written, source.offset, source.offset + copyBytes);
      } else {
        const targetSamples = targetView;
        const sourceView = toPcm16View(current.pcm);
        if (targetSamples && sourceView) {
          const targetSampleOffset = written >> 1;
          const sourceSampleOffset = source.offset >> 1;
          const sampleCount = copyBytes >> 1;
          // Inline-clamp hot path: avoids per-sample function dispatch and
          // lets V8 keep the loop body monomorphic on Int16Array access.
          for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
            const scaled = sourceView[sourceSampleOffset + sampleIndex] * gain;
            targetSamples[targetSampleOffset + sampleIndex] = scaled < -32768 ? -32768
              : scaled > 32767 ? 32767
              : scaled | 0;
          }
        } else {
          for (let offset = 0; offset < copyBytes; offset += 2) {
            const sample = readPcm16Sample(current.pcm, source.offset + offset);
            writePcm16Sample(target, written + offset, sample * gain);
          }
        }
      }
      source.offset += copyBytes;
      written += copyBytes;
      if (source.offset >= current.bytes) {
        this.dropCurrentBufferedChunk(source);
      }
    }
    if (written < frameBytes) {
      target.fill(0, written, frameBytes);
    }
    return hasAudio;
  }

  private copySourceInto(target: Buffer, source: PlaybackSource, frameBytes: number): boolean {
    let written = 0;
    let hasAudio = false;
    while (written < frameBytes) {
      if (!source.current || source.offset >= source.current.bytes) {
        if (!this.advanceBufferedSource(source)) {
          break;
        }
      }
      if (!source.current) {
        break;
      }
      const current = source.current;
      const remainingSource = current.bytes - source.offset;
      const remainingFrame = frameBytes - written;
      const chunkSize = Math.min(remainingSource, remainingFrame);
      const copyBytes = chunkSize - (chunkSize % 2);
      if (copyBytes <= 0) {
        break;
      }
      current.pcm.copy(target, written, source.offset, source.offset + copyBytes);
      hasAudio = true;
      source.offset += copyBytes;
      written += copyBytes;
      if (source.offset >= current.bytes) {
        this.dropCurrentBufferedChunk(source);
      }
    }
    if (written < frameBytes) {
      target.fill(0, written, frameBytes);
    }
    return hasAudio;
  }

  private mixSourceInto(target: Buffer, source: PlaybackSource, frameBytes: number, gain: number): boolean {
    let written = 0;
    let hasAudio = false;
    const targetView = toPcm16View(target);
    while (written < frameBytes) {
      if (!source.current || source.offset >= source.current.bytes) {
        if (!this.advanceBufferedSource(source)) {
          break;
        }
      }
      if (!source.current) {
        break;
      }
      const current = source.current;
      const remainingSource = current.bytes - source.offset;
      const remainingFrame = frameBytes - written;
      const chunkSize = Math.min(remainingSource, remainingFrame);
      const mixBytes = chunkSize - (chunkSize % 2);
      if (mixBytes <= 0) {
        break;
      }
      hasAudio = true;
      const sourceView = toPcm16View(current.pcm);
      if (targetView && sourceView) {
        const targetSampleOffset = written >> 1;
        const sourceSampleOffset = source.offset >> 1;
        const sampleCount = mixBytes >> 1;
        // Inline-clamp accumulating mix; same shape as the single-source
        // render path so V8 can specialize both loops identically.
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
          const targetIndex = targetSampleOffset + sampleIndex;
          const mixed = targetView[targetIndex] + sourceView[sourceSampleOffset + sampleIndex] * gain;
          targetView[targetIndex] = mixed < -32768 ? -32768
            : mixed > 32767 ? 32767
            : mixed | 0;
        }
      } else {
        for (let offset = 0; offset < mixBytes; offset += 2) {
          const targetOffset = written + offset;
          const currentSample = readPcm16Sample(target, targetOffset);
          const sourceSample = readPcm16Sample(current.pcm, source.offset + offset);
          writePcm16Sample(target, targetOffset, currentSample + sourceSample * gain);
        }
      }
      source.offset += mixBytes;
      written += mixBytes;
      if (source.offset >= current.bytes) {
        this.dropCurrentBufferedChunk(source);
      }
    }
    return hasAudio;
  }

  private renderToneSourceInto(target: Buffer, source: TonePlaybackSource, frameBytes: number, gain: number): boolean {
    const frameSamples = Math.floor(frameBytes / 2);
    let wroteSamples = 0;
    let consumedSamples = false;
    const targetView = toPcm16View(target);
    while (wroteSamples < frameSamples && (source.loop || source.remainingSamples > 0)) {
      const segment = source.segments[source.segmentIndex] || null;
      if (!segment || segment.durationSamples <= 0) {
        break;
      }
      const remainingSegmentSamples = segment.durationSamples - source.segmentOffsetSamples;
      const remainingFrameSamples = frameSamples - wroteSamples;
      const remainingBudgetSamples = source.loop
        ? remainingFrameSamples
        : Math.min(remainingFrameSamples, Math.max(0, source.remainingSamples));
      const sampleCount = Math.min(remainingSegmentSamples, remainingBudgetSamples);
      if (sampleCount <= 0) {
        break;
      }
      consumedSamples = true;
      if (targetView) {
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
          const scaled = this.renderToneSample(source, segment) * gain;
          targetView[wroteSamples + sampleIndex] = scaled < -32768 ? -32768
            : scaled > 32767 ? 32767
            : scaled | 0;
          source.segmentOffsetSamples += 1;
          if (!source.loop) {
            source.remainingSamples -= 1;
          }
        }
      } else {
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
          const rendered = this.renderToneSample(source, segment);
          writePcm16Sample(target, (wroteSamples + sampleIndex) * 2, rendered * gain);
          source.segmentOffsetSamples += 1;
          if (!source.loop) {
            source.remainingSamples -= 1;
          }
        }
      }
      wroteSamples += sampleCount;
      if (source.segmentOffsetSamples >= segment.durationSamples) {
        this.advanceToneSegment(source);
      }
    }
    const writtenBytes = wroteSamples * 2;
    if (writtenBytes < frameBytes) {
      target.fill(0, writtenBytes, frameBytes);
    }
    return consumedSamples;
  }

  private ensureSource(mediaId: string): PlaybackSource {
    let source = this.sources.get(mediaId) || null;
    if (source) {
      if (source.kind === "buffered") {
        return source;
      }
      throw new Error(`Playback source ${mediaId} is not a buffered source`);
    }
    source = {
      kind: "buffered",
      queue: [],
      queueCursor: 0,
      queueBytes: 0,
      current: null,
      offset: 0,
      loop: false,
      finished: false,
      completionEmitted: false,
      loopSeed: null,
    };
    this.sources.set(mediaId, source);
    return source;
  }

  private mixToneSourceInto(target: Buffer, source: TonePlaybackSource, frameBytes: number, gain: number): boolean {
    const frameSamples = Math.floor(frameBytes / 2);
    let wroteSamples = 0;
    let consumedSamples = false;
    const targetView = toPcm16View(target);
    while (wroteSamples < frameSamples && (source.loop || source.remainingSamples > 0)) {
      const segment = source.segments[source.segmentIndex] || null;
      if (!segment || segment.durationSamples <= 0) {
        break;
      }
      const remainingSegmentSamples = segment.durationSamples - source.segmentOffsetSamples;
      const remainingFrameSamples = frameSamples - wroteSamples;
      const remainingBudgetSamples = source.loop
        ? remainingFrameSamples
        : Math.min(remainingFrameSamples, Math.max(0, source.remainingSamples));
      const sampleCount = Math.min(remainingSegmentSamples, remainingBudgetSamples);
      if (sampleCount <= 0) {
        break;
      }
      consumedSamples = true;
      if (targetView) {
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
          const targetSampleIndex = wroteSamples + sampleIndex;
          const mixed = targetView[targetSampleIndex] + this.renderToneSample(source, segment) * gain;
          targetView[targetSampleIndex] = mixed < -32768 ? -32768
            : mixed > 32767 ? 32767
            : mixed | 0;
          source.segmentOffsetSamples += 1;
          if (!source.loop) {
            source.remainingSamples -= 1;
          }
        }
      } else {
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
          const rendered = this.renderToneSample(source, segment);
          const targetOffset = (wroteSamples + sampleIndex) * 2;
          const current = readPcm16Sample(target, targetOffset);
          writePcm16Sample(target, targetOffset, current + rendered * gain);
          source.segmentOffsetSamples += 1;
          if (!source.loop) {
            source.remainingSamples -= 1;
          }
        }
      }
      wroteSamples += sampleCount;
      if (source.segmentOffsetSamples >= segment.durationSamples) {
        this.advanceToneSegment(source);
      }
    }
    const writtenBytes = wroteSamples * 2;
    if (writtenBytes < frameBytes) {
      target.fill(0, writtenBytes, frameBytes);
    }
    return consumedSamples;
  }

  private renderToneSample(source: TonePlaybackSource, segment: ToneSegment): number {
    if (segment.frequencies.length === 0) {
      return 0;
    }
    let mixed = 0;
    for (const frequency of segment.frequencies) {
      const phase = source.phaseByFrequency.get(frequency) || 0;
      mixed += Math.sin(phase);
      let nextPhase = phase + ((2 * Math.PI * frequency) / source.sampleRate);
      if (nextPhase >= 2 * Math.PI) {
        nextPhase %= 2 * Math.PI;
      }
      source.phaseByFrequency.set(frequency, nextPhase);
    }
    return Math.round((mixed / Math.max(1, segment.frequencies.length)) * 32767 * source.amplitude);
  }

  private advanceToneSegment(source: TonePlaybackSource): void {
    const previous = source.segments[source.segmentIndex] || null;
    source.segmentOffsetSamples = 0;
    source.segmentIndex += 1;
    if (source.segmentIndex >= source.segments.length) {
      source.segmentIndex = 0;
    }
    const next = source.segments[source.segmentIndex] || null;
    if (!next) {
      return;
    }
    if (!previous || setEquals(previous.frequencies, next.frequencies)) {
      return;
    }
    for (const frequency of next.frequencies) {
      if (!previous.frequencies.includes(frequency)) {
        source.phaseByFrequency.set(frequency, 0);
      }
    }
  }
}
