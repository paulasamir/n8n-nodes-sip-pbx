const DTMF_ROW_FREQUENCIES = [697, 770, 852, 941] as const;
const DTMF_COLUMN_FREQUENCIES = [1209, 1336, 1477, 1633] as const;
const DTMF_DIGIT_MATRIX = [
  ["1", "2", "3", "A"],
  ["4", "5", "6", "B"],
  ["7", "8", "9", "C"],
  ["*", "0", "#", "D"],
] as const;

const MIN_FRAME_DURATION_MS = 10;
const MIN_RMS_LEVEL = 0.015;
const MIN_START_DURATION_MS = 40;
const MIN_END_DURATION_MS = 40;
const DOMINANCE_RATIO = 2.5;
const MAX_TWIST_RATIO = 6;
const MIN_COMBINED_TO_NOISE_RATIO = 3;
const EXTERNAL_DTMF_SUPPRESS_MS = 500;

type GoertzelCoefficients = {
  readonly row: readonly number[];
  readonly column: readonly number[];
};

const coefficientCache = new Map<number, GoertzelCoefficients>();

function getCoefficients(sampleRate: number): GoertzelCoefficients {
  const normalizedSampleRate = Math.max(1, Math.round(Number(sampleRate) || 8000));
  const cached = coefficientCache.get(normalizedSampleRate);
  if (cached) {
    return cached;
  }
  const create = (frequency: number): number => 2 * Math.cos((2 * Math.PI * frequency) / normalizedSampleRate);
  const coefficients: GoertzelCoefficients = {
    row: DTMF_ROW_FREQUENCIES.map(create),
    column: DTMF_COLUMN_FREQUENCIES.map(create),
  };
  coefficientCache.set(normalizedSampleRate, coefficients);
  return coefficients;
}

function clampBytes(pcm: Buffer, bytes?: number): number {
  return Math.max(0, Math.min(Number(bytes ?? pcm.length) || 0, pcm.length));
}

function readMonoSamples(
  pcm: Buffer,
  bytes: number,
  channels: number,
): { samples: Float64Array; rms: number } | null {
  const normalizedChannels = Math.max(1, Math.round(Number(channels) || 1));
  const strideBytes = normalizedChannels * 2;
  const sampleCount = Math.floor(bytes / strideBytes);
  if (sampleCount <= 0) {
    return null;
  }
  const samples = new Float64Array(sampleCount);
  let energy = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const baseOffset = index * strideBytes;
    let mixed = 0;
    for (let channel = 0; channel < normalizedChannels; channel += 1) {
      mixed += pcm.readInt16LE(baseOffset + (channel * 2));
    }
    const normalized = (mixed / normalizedChannels) / 32768;
    samples[index] = normalized;
    energy += normalized * normalized;
  }
  const rms = Math.sqrt(energy / sampleCount);
  return { samples, rms };
}

function computeGoertzelPower(samples: Float64Array, coefficient: number): number {
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    q0 = coefficient * q1 - q2 + samples[index]!;
    q2 = q1;
    q1 = q0;
  }
  return (q1 * q1) + (q2 * q2) - (coefficient * q1 * q2);
}

function detectDigitFromFrame(
  pcm: Buffer,
  bytes: number,
  sampleRate: number,
  channels: number,
  durationMs: number,
): string | null {
  if (durationMs < MIN_FRAME_DURATION_MS) {
    return null;
  }
  const sampleInput = readMonoSamples(pcm, bytes, channels);
  if (!sampleInput || sampleInput.rms < MIN_RMS_LEVEL) {
    return null;
  }
  const coefficients = getCoefficients(sampleRate);
  const rowPowers = coefficients.row.map((coefficient) => computeGoertzelPower(sampleInput.samples, coefficient));
  const columnPowers = coefficients.column.map((coefficient) => computeGoertzelPower(sampleInput.samples, coefficient));

  const strongestRowIndex = rowPowers.reduce((best, power, index, values) => power > values[best]! ? index : best, 0);
  const strongestColumnIndex = columnPowers.reduce((best, power, index, values) => power > values[best]! ? index : best, 0);
  const strongestRowPower = rowPowers[strongestRowIndex] || 0;
  const strongestColumnPower = columnPowers[strongestColumnIndex] || 0;
  const secondRowPower = rowPowers
    .filter((_, index) => index !== strongestRowIndex)
    .reduce((best, power) => Math.max(best, power), 0);
  const secondColumnPower = columnPowers
    .filter((_, index) => index !== strongestColumnIndex)
    .reduce((best, power) => Math.max(best, power), 0);
  if (strongestRowPower <= 0 || strongestColumnPower <= 0) {
    return null;
  }
  if (strongestRowPower < (secondRowPower * DOMINANCE_RATIO) || strongestColumnPower < (secondColumnPower * DOMINANCE_RATIO)) {
    return null;
  }
  const twistRatio = strongestRowPower > strongestColumnPower
    ? strongestRowPower / strongestColumnPower
    : strongestColumnPower / strongestRowPower;
  if (twistRatio > MAX_TWIST_RATIO) {
    return null;
  }
  const combined = strongestRowPower + strongestColumnPower;
  const noise = Math.max(
    1e-9,
    rowPowers.reduce((sum, power) => sum + power, 0)
      + columnPowers.reduce((sum, power) => sum + power, 0)
      - combined,
  );
  if ((combined / noise) < MIN_COMBINED_TO_NOISE_RATIO) {
    return null;
  }
  return DTMF_DIGIT_MATRIX[strongestRowIndex]?.[strongestColumnIndex] || null;
}

export class InbandDtmfDetector {
  private candidateDigit = "";
  private candidateDurationMs = 0;
  private activeDigit = "";
  private activeGapDurationMs = 0;
  private suppressUntilMs = 0;

  reset(): void {
    this.candidateDigit = "";
    this.candidateDurationMs = 0;
    this.activeDigit = "";
    this.activeGapDurationMs = 0;
    this.suppressUntilMs = 0;
  }

  notifyExternalDtmf(now = Date.now()): void {
    this.candidateDigit = "";
    this.candidateDurationMs = 0;
    this.activeDigit = "";
    this.activeGapDurationMs = 0;
    this.suppressUntilMs = Math.max(this.suppressUntilMs, Number(now || Date.now()) + EXTERNAL_DTMF_SUPPRESS_MS);
  }

  feed(input: {
    pcm: Buffer;
    bytes?: number;
    sampleRate: number;
    channels?: number;
    durationMs?: number;
    nowMs?: number;
  }): string[] {
    const bytes = clampBytes(input.pcm, input.bytes);
    if (!bytes) {
      return [];
    }
    const durationMs = Math.max(1, Number(input.durationMs || 20));
    const nowMs = Math.max(0, Number(input.nowMs || Date.now()) || Date.now());
    const digit = detectDigitFromFrame(
      input.pcm,
      bytes,
      Math.max(1, Number(input.sampleRate || 8000)),
      Math.max(1, Number(input.channels || 1)),
      durationMs,
    );
    if (this.suppressUntilMs > nowMs) {
      this.candidateDigit = "";
      this.candidateDurationMs = 0;
      this.activeDigit = "";
      this.activeGapDurationMs = 0;
      return [];
    }
    if (this.activeDigit) {
      if (digit === this.activeDigit) {
        this.activeGapDurationMs = 0;
        return [];
      }
      this.activeGapDurationMs += durationMs;
      if (this.activeGapDurationMs < MIN_END_DURATION_MS) {
        return [];
      }
      const completedDigit = this.activeDigit;
      this.activeDigit = "";
      this.activeGapDurationMs = 0;
      this.candidateDigit = digit || "";
      this.candidateDurationMs = digit ? durationMs : 0;
      return completedDigit ? [completedDigit] : [];
    }
    if (!digit) {
      this.candidateDigit = "";
      this.candidateDurationMs = 0;
      return [];
    }
    if (digit === this.candidateDigit) {
      this.candidateDurationMs += durationMs;
    } else {
      this.candidateDigit = digit;
      this.candidateDurationMs = durationMs;
    }
    if (this.candidateDurationMs >= MIN_START_DURATION_MS) {
      this.activeDigit = digit;
      this.activeGapDurationMs = 0;
    }
    return [];
  }
}

