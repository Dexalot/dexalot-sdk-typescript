/**
 * Token bucket rate limiter for async operations.
 * Matches Python SDK's AsyncRateLimiter implementation.
 */
export class AsyncRateLimiter {
    private readonly minInterval: number;
    private lastCall: number = 0;
    private pending: Promise<void> = Promise.resolve();

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
     * Waits if necessary to maintain the rate limit.
     */
    async acquire(): Promise<void> {
        // Chain this call after any pending waits to ensure FIFO ordering
        const previousPending = this.pending;
        
        let resolveThis: () => void;
        this.pending = new Promise<void>(resolve => {
            resolveThis = resolve;
        });

        // Wait for previous call to complete
        await previousPending;

        const now = Date.now();
        const elapsed = now - this.lastCall;
        const waitTime = Math.max(0, this.minInterval - elapsed);

        if (waitTime > 0) {
            await new Promise<void>(resolve => setTimeout(resolve, waitTime));
        }

        this.lastCall = Date.now();
        resolveThis!();
    }

    /**
     * Reset the rate limiter state.
     */
    reset(): void {
        this.lastCall = 0;
        this.pending = Promise.resolve();
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
 * const limiter = new AsyncRateLimiter(5); // 5 calls/second
 * const rateLimitedFetch = withRateLimit(fetch, limiter);
 * await rateLimitedFetch('https://api.example.com');
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
