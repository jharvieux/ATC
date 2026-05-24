// BP36 §33.5 — process-wide token bucket rate limiter.
//
// Singleton across all callers in the Node process: serial fetches and
// concurrent fetches BOTH share the same bucket, so an over-eager
// `Promise.all` over a URL list still respects the RPS ceiling.
//
// Token bucket semantics:
//   - Capacity = ratePerSecond tokens (burst tolerance of 1 second).
//   - Refill = ratePerSecond tokens per second, fractional accumulation.
//   - acquire() resolves only when 1 token is available, FIFO across
//     queued callers.
//
// CruiseMapper-specific. Other scrapers (future) should construct their
// own bucket with their own rate.

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly rps: number) {
    this.tokens = rps;
    this.lastRefill = Date.now();
  }

  /** Wait until a token is available, then consume it. */
  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.tryDrain();
    });
  }

  private tryDrain(): void {
    this.refill();
    while (this.tokens >= 1 && this.queue.length > 0) {
      this.tokens -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
    if (this.queue.length > 0) {
      // Schedule next drain attempt at the earliest token-availability instant.
      const tokensNeeded = 1 - this.tokens;
      const msUntilToken = Math.max(20, Math.ceil((tokensNeeded / this.rps) * 1000));
      setTimeout(() => this.tryDrain(), msUntilToken);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.rps, this.tokens + elapsedSec * this.rps);
    this.lastRefill = now;
  }
}

let bucket: TokenBucket | null = null;
let bucketRps = 0;

/** Process-wide CruiseMapper rate limiter. Rebuilt if RPS changes. */
export function getCruiseMapperRateLimiter(): TokenBucket {
  const rps = parseFloat(process.env.CRUISEMAPPER_DIY_RATE_LIMIT_RPS ?? "1.0");
  if (!bucket || bucketRps !== rps) {
    bucket = new TokenBucket(rps);
    bucketRps = rps;
  }
  return bucket;
}

/** Test-only: reset the singleton between specs. */
export function _resetRateLimiterForTests(): void {
  bucket = null;
  bucketRps = 0;
}
