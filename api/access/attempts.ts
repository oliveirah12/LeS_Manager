import { HttpException } from '@nestjs/common';

/**
 * Counts attempts per key in a fixed window and refuses new ones once the limit is reached.
 * Kept in memory, which fits the single API instance of this version.
 */
export class AttemptLimiter {
  private entries = new Map<string, { count: number; expires: number }>();

  constructor(
    private max: number, private windowMs: number, private message: string, private now: () => number = Date.now,
  ) {}

  /** Counts the attempt, or refuses it with HTTP 429 when the key has used up its window. */
  take(key: string) {
    const now = this.now();
    for (const [stored, entry] of this.entries) if (entry.expires <= now) this.entries.delete(stored);
    const entry = this.entries.get(key) ?? { count: 0, expires: now + this.windowMs };
    if (entry.count >= this.max) throw new HttpException(this.message, 429);
    entry.count++;
    this.entries.set(key, entry);
  }

  /** Forgets the attempts of the key, used after a successful authentication. */
  reset(key: string) { this.entries.delete(key); }
}

/**
 * Reads TRUST_PROXY for Express. A number trusts that many proxy hops; any other text is
 * a list of trusted addresses, such as `loopback`. Unset keeps the socket address.
 */
export function proxySetting(value = process.env.TRUST_PROXY) {
  const text = value?.trim();
  if (!text) return undefined;
  return /^\d+$/.test(text) ? Number(text) : text;
}
