import { normalizeStringList } from "../../../shared/string-utils";

export class WaitMediaOperation {
  readonly mediaIds: string[];
  readonly timeoutMs: number;

  constructor(input: { mediaIds?: string[]; timeoutMs?: number }) {
    this.mediaIds = normalizeStringList(input.mediaIds);
    this.timeoutMs = Math.max(0, Number(input.timeoutMs || 0));
  }
}
