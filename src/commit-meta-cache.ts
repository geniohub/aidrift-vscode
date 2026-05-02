// Bounded in-memory cache for commit lookups. Null is a real cached value
// (means: server returned 404 / not tracked by AiDrift) so we don't keep
// re-asking. Eviction is FIFO, which is fine for "scroll a recent log"
// access patterns.

export type Fetcher<T> = (sha: string) => Promise<T | null>;

export class CommitMetaCache<T> {
  private readonly map = new Map<string, T | null>();

  constructor(
    private readonly fetcher: Fetcher<T>,
    private readonly capacity: number,
  ) {}

  async get(sha: string): Promise<T | null> {
    if (this.map.has(sha)) return this.map.get(sha) ?? null;
    const result = await this.fetcher(sha);
    this.map.set(sha, result);
    while (this.map.size > this.capacity) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
    return result;
  }

  invalidate(sha: string): void {
    this.map.delete(sha);
  }

  clear(): void {
    this.map.clear();
  }
}
