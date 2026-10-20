/**
 * Poll coalescing (API-73, 04 §8.3, ADR-29). Within one `(runId, stepKey, poll.group)`:
 * the first poll, every poll whose `(status, sha256(body))` differs from the previously persisted
 * one, and the last poll are persisted; the rest are only counted. The decision for a poll is made
 * when the next poll arrives (or at `close`), so the group's final persisted response carries
 * `poll.total` = the count of all polls, and a group with a single poll has `total: 1`.
 */
export interface PollPair<T> {
  index: number;
  /** `${status}:${sha256(body)}`, or `error:<class>` */
  signature: string;
  data: T;
}

interface Group<T> {
  count: number;
  lastPersisted: string | null;
  pending: PollPair<T> | null;
}

/** Persists only the first, the changed and the last poll of a polling group and counts the rest, so a long wait does not flood the log. */
export class PollCoalescer<T> {
  private readonly groups = new Map<string, Group<T>>();

  static key(runId: string, stepKey: string, group: string): string {
    return `${runId}\u0000${stepKey}\u0000${group}`;
  }

  /**
   * Registers poll number `index` and returns the pairs to persist now (the previous poll, when it
   * was the first or changed). The new poll is held as the latest unpersisted pair.
   */
  observe(key: string, signature: string, data: T): { persist: PollPair<T>[]; index: number } {
    let g = this.groups.get(key);
    if (!g) {
      g = { count: 0, lastPersisted: null, pending: null };
      this.groups.set(key, g);
    }
    g.count += 1;
    const persist: PollPair<T>[] = [];
    if (g.pending) {
      if (g.lastPersisted === null || g.pending.signature !== g.lastPersisted) {
        persist.push(g.pending);
        g.lastPersisted = g.pending.signature;
      }
    }
    g.pending = { index: g.count, signature, data };
    return { persist, index: g.count };
  }

  /** the latest unpersisted pair (always persisted at close) and the group's total */
  close(key: string): { pair: PollPair<T>; total: number } | null {
    const g = this.groups.get(key);
    this.groups.delete(key);
    if (!g?.pending) return null;
    return { pair: g.pending, total: g.count };
  }

  /** keys of every open group of a step / run (auto-close at step completion and run end) */
  openKeys(prefix: string): string[] {
    return [...this.groups.keys()].filter((k) => k.startsWith(prefix));
  }
}
