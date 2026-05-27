/**
 * Async rate limiter that paces concurrent callers without serializing
 * their sleeps.
 *
 * Each call to `acquire()` atomically reserves the next available slot
 * by advancing the wall-clock cursor (`nextSlot`), then sleeps until
 * that slot opens. Multiple in-flight callers therefore sleep
 * independently — caller N's sleep duration is roughly
 * `(N - 1) * minInterval`, but all N sleeps run concurrently so the
 * total wall-clock to fan out N requests is `(N - 1) * minInterval`
 * (the same as a serialized chain, but with the caller's request body
 * preparation and the response handling free to overlap rather than
 * being gated by previous callers' sleeps).
 *
 * Mirrors the Python SDK's `AsyncRateLimiter`, which advances
 * `_last_call` speculatively under the lock and releases the lock
 * before sleeping.
 */
export class AsyncRateLimiter {
    private readonly minInterval: number;
    /** Wall-clock time (ms since epoch) at which the next slot opens. */
    private nextSlot: number = 0;

    /**
     * Create a new rate limiter.
     * @param callsPerSecond - Maximum calls allowed per second
     */
    constructor(callsPerSecond: number) {
        if (callsPerSecond <= 0) {
            throw new Error('callsPerSecond must be positive');
        }
        this.minInterval = 1000 / callsPerSecond;
    }

    /**
     * Acquire a slot from the rate limiter.
     *
     * Advances `nextSlot` synchronously so multiple concurrent callers
     * each reserve a distinct slot before any of them sleep. Each
     * caller then awaits its own slot independently.
     */
    async acquire(): Promise<void> {
        const now = Date.now();
        // After a quiet period the cursor falls behind `now`; reset it
        // so we don't catch up by issuing a burst back-to-back.
        if (this.nextSlot < now) {
            this.nextSlot = now;
        }
        const mySlot = this.nextSlot;
        this.nextSlot += this.minInterval;

        const waitTime = mySlot - now;
        if (waitTime > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, waitTime));
        }
    }

    /**
     * Reset the rate limiter state. The next caller is allowed
     * immediately.
     */
    reset(): void {
        this.nextSlot = 0;
    }

    /**
     * Get the minimum interval between calls in milliseconds.
     */
    getMinInterval(): number {
        return this.minInterval;
    }
}

/**
 * Create a rate-limited wrapper for an async function.
 *
 * @param fn - The async function to rate limit
 * @param limiter - The rate limiter to use
 * @returns Rate-limited version of the function
 *
 * @example
 *   const limiter = new AsyncRateLimiter(5); // 5 calls/second
 *   const rateLimitedFetch = withRateLimit(fetch, limiter);
 *   await rateLimitedFetch('https://api.example.com');
 */
export function withRateLimit<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    limiter: AsyncRateLimiter
): T {
    const wrapped = async (...args: Parameters<T>): Promise<ReturnType<T>> => {
        await limiter.acquire();
        return fn(...args);
    };

    return wrapped as T;
}
