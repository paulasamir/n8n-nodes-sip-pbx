export const SIP_AUDIO_CODEC_ALAW = "alaw" as const;
export const SIP_AUDIO_CODEC_MULAW = "mulaw" as const;
export const SIP_AUDIO_CODEC_G722 = "g722" as const;
export const SIP_AUDIO_CODEC_G729 = "g729" as const;
export const SIP_AUDIO_CODEC_OPUS = "opus" as const;

export const SIP_DTMF_METHOD_RFC2833 = "rfc2833" as const;
export const SIP_DTMF_METHOD_INFO = "info" as const;
export const SIP_DTMF_METHOD_INBAND = "inband" as const;

export const SIP_AUDIO_CODEC_FILTER_VALUES = [
  SIP_AUDIO_CODEC_OPUS,
  SIP_AUDIO_CODEC_G722,
  SIP_AUDIO_CODEC_ALAW,
  SIP_AUDIO_CODEC_MULAW,
  SIP_AUDIO_CODEC_G729,
] as const;

export const SIP_DTMF_METHOD_FILTER_VALUES = [
  SIP_DTMF_METHOD_RFC2833,
  SIP_DTMF_METHOD_INFO,
  SIP_DTMF_METHOD_INBAND,
] as const;

export type SipAudioCodecFilter = (typeof SIP_AUDIO_CODEC_FILTER_VALUES)[number];
export type SipDtmfMethodFilter = (typeof SIP_DTMF_METHOD_FILTER_VALUES)[number];

export function normalizeSipAudioCodecFilters(value: unknown): SipAudioCodecFilter[] {
  const allowed = new Set<string>(SIP_AUDIO_CODEC_FILTER_VALUES);
  return normalizeSelectionList(value)
    .filter((entry): entry is SipAudioCodecFilter => allowed.has(entry));
}

export function normalizeSipDtmfMethodFilters(value: unknown): SipDtmfMethodFilter[] {
  const allowed = new Set<string>(SIP_DTMF_METHOD_FILTER_VALUES);
  return normalizeSelectionList(value)
    .filter((entry): entry is SipDtmfMethodFilter => allowed.has(entry));
}

export function allowsSipDtmfMethod(
  filters: readonly SipDtmfMethodFilter[],
  method: SipDtmfMethodFilter,
): boolean {
  return filters.length === 0 || filters.includes(method);
}

function normalizeSelectionList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((entry) => String(entry || "").trim())
          .filter(Boolean),
      ),
    );
  }
  const single = String(value || "").trim();
  return single ? [single] : [];
}
