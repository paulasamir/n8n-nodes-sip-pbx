export const TRUNK_CONNECTION_MODE_FIXED = "fixed" as const;
export const TRUNK_CONNECTION_MODE_DYNAMIC = "dynamic" as const;

export const TRUNK_CONNECTION_ROLES = [
  TRUNK_CONNECTION_MODE_FIXED,
  TRUNK_CONNECTION_MODE_DYNAMIC,
] as const;

export type TrunkConnectionMode = (typeof TRUNK_CONNECTION_ROLES)[number];
