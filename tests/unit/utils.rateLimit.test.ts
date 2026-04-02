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
