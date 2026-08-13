const GROQ_REQUESTS_PER_MINUTE = 30;
const OPENROUTER_REQUESTS_PER_MINUTE = 20;
const GEMINI_REQUESTS_PER_MINUTE = 15;
const BUCKET_REFILL_INTERVAL_MS = 60_000;

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillIntervalMs: number;

  constructor(requestsPerMinute: number) {
    this.capacity = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.lastRefill = Date.now();
    this.refillIntervalMs = BUCKET_REFILL_INTERVAL_MS;
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.refillIntervalMs) {
      const periods = Math.floor(elapsed / this.refillIntervalMs);
      this.tokens = Math.min(this.capacity, this.tokens + periods * this.capacity);
      // Advance by whole periods to preserve sub-period remainder — prevents drift
      this.lastRefill += periods * this.refillIntervalMs;
    }
  }
}

export const groqLimiter = new TokenBucketRateLimiter(GROQ_REQUESTS_PER_MINUTE);
export const openRouterLimiter = new TokenBucketRateLimiter(OPENROUTER_REQUESTS_PER_MINUTE);
export const geminiLimiter = new TokenBucketRateLimiter(GEMINI_REQUESTS_PER_MINUTE);
