export const INTERRUPT_SELECTION_DTMF = "dtmf" as const;
export const INTERRUPT_SELECTION_VOICE = "voice" as const;
export const INTERRUPT_SELECTION_SILENCE = "silence" as const;

export const INTERRUPT_SELECTIONS = [
  INTERRUPT_SELECTION_DTMF,
  INTERRUPT_SELECTION_VOICE,
  INTERRUPT_SELECTION_SILENCE,
] as const;

export type InterruptSelection = (typeof INTERRUPT_SELECTIONS)[number];
