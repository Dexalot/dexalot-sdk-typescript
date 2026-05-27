import { AsyncRateLimiter, withRateLimit } from '../../src/utils/rateLimit';

describe('AsyncRateLimiter', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should create limiter with valid calls per second', () => {
            const limiter = new AsyncRateLimiter(5);
            expect(limiter.getMinInterval()).toBe(200); // 1000 / 5 = 200ms
        });

        it('should throw on zero calls per second', () => {
            expect(() => new AsyncRateLimiter(0)).toThrow('callsPerSecond must be positive');
        });

        it('should throw on negative calls per second', () => {
            expect(() => new AsyncRateLimiter(-1)).toThrow('callsPerSecond must be positive');
        });
    });

    describe('acquire()', () => {
        it('should not wait on first call', async () => {
            const limiter = new AsyncRateLimiter(5);
            
            const start = Date.now();
            await limiter.acquire();
            const elapsed = Date.now() - start;

            expect(elapsed).toBeLessThan(10);
        });

        it('should wait between rapid calls', async () => {
            const limiter = new AsyncRateLimiter(5); // 200ms min interval
            
            // First call should be immediate
            const promise1 = limiter.acquire();
            await jest.advanceTimersByTimeAsync(0);
            await promise1;

            // Second call should wait
            const promise2 = limiter.acquire();
            
            // Advance time partially
            await jest.advanceTimersByTimeAsync(100);
            
            // Should still be waiting
            let resolved = false;
            promise2.then(() => { resolved = true; });
            await jest.advanceTimersByTimeAsync(0);
            expect(resolved).toBe(false);

            // Advance past min interval
            await jest.advanceTimersByTimeAsync(150);
            await promise2;
        });

        it('should not wait if enough time has passed', async () => {
            const limiter = new AsyncRateLimiter(5); // 200ms min interval
            
            await limiter.acquire();
            
            // Wait longer than min interval
            await jest.advanceTimersByTimeAsync(300);
            
            const start = Date.now();
            await limiter.acquire();
            const elapsed = Date.now() - start;

            expect(elapsed).toBeLessThan(10);
        });

        it('should maintain FIFO ordering', async () => {
            const limiter = new AsyncRateLimiter(10); // 100ms min interval
            const order: number[] = [];

            // Start multiple acquires
            const promises = [
                limiter.acquire().then(() => order.push(1)),
                limiter.acquire().then(() => order.push(2)),
                limiter.acquire().then(() => order.push(3)),
            ];

            // Advance time to completion
            for (let i = 0; i < 5; i++) {
                await jest.advanceTimersByTimeAsync(150);
            }

            await Promise.all(promises);
            expect(order).toEqual([1, 2, 3]);
        });

        it('reserves each caller a distinct slot synchronously (independent sleeps)', async () => {
            // 5 concurrent callers at 5 rps: the cursor advances 4 times
            // synchronously when they queue up, so callers 1..4 see waitTimes
            // of 0, 200, 400, 600 ms respectively — and all four sleeps run
            // in parallel. Total wall-clock is 600 ms, not 4 * 200 = 800.
            const limiter = new AsyncRateLimiter(5);
            const completionTimes: number[] = [];

            const start = Date.now();
            const promises = Array.from({ length: 5 }, () =>
                limiter.acquire().then(() => {
                    completionTimes.push(Date.now() - start);
                })
            );

            // Push the clock forward in one big step; all five sleeps complete.
            await jest.advanceTimersByTimeAsync(1000);
            await Promise.all(promises);

            // Completions should be 0, 200, 400, 600, 800 — strictly
            // increasing, spaced by minInterval.
            expect(completionTimes).toHaveLength(5);
            expect(completionTimes[0]).toBe(0);
            for (let i = 1; i < 5; i++) {
                expect(completionTimes[i] - completionTimes[i - 1]).toBe(200);
            }
        });

        it('does not catch up after a quiet period (no burst)', async () => {
            const limiter = new AsyncRateLimiter(5); // 200ms interval
            await limiter.acquire();
            // Quiet period — the cursor would otherwise creep behind `now`.
            await jest.advanceTimersByTimeAsync(10_000);

            // Two rapid calls after the quiet period: the first is immediate,
            // the second waits a full interval (not zero).
            const firstStart = Date.now();
            await limiter.acquire();
            expect(Date.now() - firstStart).toBeLessThan(10);

            const secondStart = Date.now();
            const p = limiter.acquire();
            await jest.advanceTimersByTimeAsync(200);
            await p;
            expect(Date.now() - secondStart).toBe(200);
        });
    });

    describe('reset()', () => {
        it('should allow immediate acquire after reset', async () => {
            const limiter = new AsyncRateLimiter(5);
            
            await limiter.acquire();
            limiter.reset();

            const start = Date.now();
            await limiter.acquire();
            const elapsed = Date.now() - start;

            expect(elapsed).toBeLessThan(10);
        });
    });

    describe('getMinInterval()', () => {
        it('should return correct interval for various rates', () => {
            expect(new AsyncRateLimiter(1).getMinInterval()).toBe(1000);
            expect(new AsyncRateLimiter(2).getMinInterval()).toBe(500);
            expect(new AsyncRateLimiter(10).getMinInterval()).toBe(100);
            expect(new AsyncRateLimiter(0.5).getMinInterval()).toBe(2000);
        });
    });
});

describe('withRateLimit', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should wrap function with rate limiting', async () => {
        const limiter = new AsyncRateLimiter(5);
        const fn = jest.fn().mockResolvedValue('result');
        const wrapped = withRateLimit(fn, limiter);

        const promise = wrapped('arg1', 'arg2');
        await jest.advanceTimersByTimeAsync(0);
        const result = await promise;

        expect(result).toBe('result');
        expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
    });

    it('should rate limit multiple calls', async () => {
        const limiter = new AsyncRateLimiter(10); // 100ms interval
        const fn = jest.fn().mockResolvedValue('result');
        const wrapped = withRateLimit(fn, limiter);

        // Start multiple calls
        const promises = [wrapped(), wrapped(), wrapped()];

        // Advance time
        for (let i = 0; i < 5; i++) {
            await jest.advanceTimersByTimeAsync(150);
        }

        await Promise.all(promises);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should preserve function return type', async () => {
        const limiter = new AsyncRateLimiter(5);
        const fn = async (x: number): Promise<number> => x * 2;
        const wrapped = withRateLimit(fn, limiter);

        const promise = wrapped(5);
        await jest.advanceTimersByTimeAsync(0);
        const result = await promise;

        expect(result).toBe(10);
    });
});
