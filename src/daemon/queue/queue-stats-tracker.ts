export class QueueStatsTracker {
  private readonly completedByRef = new Map<string, number>();
  private readonly completedWaitTotalMsByRef = new Map<string, number>();

  recordCompletion(ref: string, waitMs: number): void {
    this.completedByRef.set(ref, (this.completedByRef.get(ref) || 0) + 1);
    this.completedWaitTotalMsByRef.set(
      ref,
      (this.completedWaitTotalMsByRef.get(ref) || 0) + Math.max(0, waitMs),
    );
  }

  getCompletedCount(ref: string): number {
    return this.completedByRef.get(ref) || 0;
  }

  getAverageWaitMs(ref: string): number {
    const completedCount = this.getCompletedCount(ref);
    if (completedCount <= 0) {
      return 0;
    }
    const totalWaitMs = this.completedWaitTotalMsByRef.get(ref) || 0;
    return Math.floor(totalWaitMs / completedCount);
  }

  getEstimatedAnswerMs(ref: string, position: number): number {
    const averageWaitMs = this.getAverageWaitMs(ref);
    if (position <= 0 || averageWaitMs <= 0) {
      return 0;
    }
    return averageWaitMs * position;
  }
}
