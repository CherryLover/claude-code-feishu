export class MessageDedup {
  private processed = new Map<string, number>();
  private readonly maxSize = 10000;
  private readonly ttlMs = 5 * 60 * 1000; // 5 分钟

  isDuplicate(messageId: string): boolean {
    this.cleanupIfNeeded();

    if (this.processed.has(messageId)) {
      return true;
    }
    this.processed.set(messageId, Date.now());
    return false;
  }

  private cleanupIfNeeded() {
    if (this.processed.size <= this.maxSize) return;

    const now = Date.now();
    for (const [id, timestamp] of this.processed) {
      if (now - timestamp > this.ttlMs) {
        this.processed.delete(id);
      }
    }
  }
}
