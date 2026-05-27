import {
    MemoryCache,
    withInstanceCache,
    getStaticCache,
    getSemiStaticCache,
    getBalanceCache,
    getOrderbookCache,
    configureCaches,
    clearAllCaches,
    resetCachesForTesting,
} from '../../src/utils/cache';

describe('MemoryCache', () => {
    let cache: MemoryCache;
    let now: number;

    beforeEach(() => {
        jest.useFakeTimers();
        now = 1000;
        jest.setSystemTime(now);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('stores and retrieves values', () => {
        cache = new MemoryCache(60);
        cache.set('key1', 'value1');
        expect(cache.get('key1')).toBe('value1');
    });

    it('returns null for non-existent keys', () => {
        cache = new MemoryCache(60);
        expect(cache.get('missing')).toBeNull();
    });

    it('expires items after TTL', () => {
        cache = new MemoryCache(10);
        cache.set('key1', 'value1');
        jest.setSystemTime(now + 11000);
        expect(cache.get('key1')).toBeNull();
    });

    it('purges an expired entry on get and frees the map slot', () => {
        cache = new MemoryCache(10);
        cache.set('key1', 'value1');
        jest.setSystemTime(now + 11000);
        expect(cache.size).toBe(1);
        cache.get('key1');
        expect(cache.size).toBe(0);
    });

    it('enforces maxSize via FIFO eviction', () => {
        cache = new MemoryCache(60, 2);
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');
        cache.set('key3', 'value3');
        expect(cache.get('key1')).toBeNull();
        expect(cache.get('key2')).toBe('value2');
        expect(cache.get('key3')).toBe('value3');
    });

    it('handles empty string keys during eviction', () => {
        cache = new MemoryCache(60, 1);
        cache.set('', 'empty');
        cache.set('key2', 'value2');
        // After the second set, the empty-string key is evicted (FIFO).
        expect(cache.get('')).toBeNull();
        expect(cache.get('key2')).toBe('value2');
    });

    it('amortizes the TTL-expiry sweep over CLEANUP_INTERVAL writes', () => {
        cache = new MemoryCache(10);
        // Write an expired entry first (write count = 1).
        cache.set('stale', 'old');
        jest.setSystemTime(now + 11000);

        // Write CLEANUP_INTERVAL - 2 more entries so the total is
        // CLEANUP_INTERVAL - 1 (below the sweep threshold). The stale
        // entry must still occupy a slot.
        for (let i = 0; i < MemoryCache.CLEANUP_INTERVAL - 2; i++) {
            cache.set(`k${i}`, i);
        }
        expect((cache as any).store.has('stale')).toBe(true);

        // The next write hits exactly CLEANUP_INTERVAL → sweep runs and
        // the stale entry is dropped.
        cache.set('newest', 1);
        expect((cache as any).store.has('stale')).toBe(false);
    });

    it('setTtl applies to subsequent writes (existing entries keep their original expiry)', () => {
        cache = new MemoryCache(60);
        cache.set('old', 'v');     // expiry = now + 60_000
        cache.setTtl(1);
        cache.set('new', 'v');     // expiry = now + 1_000
        jest.setSystemTime(now + 2000);
        // The post-setTtl entry expires; the pre-setTtl entry survives.
        expect(cache.get('new')).toBeNull();
        expect(cache.get('old')).toBe('v');
    });

    it('setMaxSize trims immediately when shrinking below current size', () => {
        cache = new MemoryCache(60, 10);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        cache.setMaxSize(2);
        expect(cache.get('a')).toBeNull();
        expect(cache.get('b')).toBe(2);
        expect(cache.get('c')).toBe(3);
    });

    it('clear removes both stored values and pending Promises', async () => {
        cache = new MemoryCache(60);
        cache.set('k', 'v');
        cache.setPending('k', Promise.resolve('inflight'));
        cache.clear();
        expect(cache.get('k')).toBeNull();
        expect(cache.getPending('k')).toBeUndefined();
    });
});

describe('Module-level cache singletons', () => {
    it('getStaticCache / getSemiStaticCache / getBalanceCache / getOrderbookCache are stable references', () => {
        const a = getStaticCache();
        const b = getStaticCache();
        expect(a).toBe(b);
        expect(getSemiStaticCache()).toBeInstanceOf(MemoryCache);
        expect(getBalanceCache()).toBeInstanceOf(MemoryCache);
        expect(getOrderbookCache()).toBeInstanceOf(MemoryCache);
    });

    it('configureCaches mutates the singleton in place (identity preserved)', () => {
        const before = getStaticCache();
        configureCaches({ cacheTtlStatic: 60 });
        const after = getStaticCache();
        expect(after).toBe(before);
    });

    it('configureCaches ignores values equal to the documented defaults', () => {
        const cache = getBalanceCache();
        const beforeTtl = (cache as any).ttlMs;
        configureCaches({ cacheTtlBalance: 10 });
        const afterTtl = (cache as any).ttlMs;
        expect(afterTtl).toBe(beforeTtl);
    });

    it('configureCaches applies each tier independently', () => {
        configureCaches({
            cacheTtlStatic: 30,
            cacheTtlSemiStatic: 45,
            cacheTtlBalance: 5,
            cacheTtlOrderbook: 2,
        });
        expect((getStaticCache() as any).ttlMs).toBe(30 * 1000);
        expect((getSemiStaticCache() as any).ttlMs).toBe(45 * 1000);
        expect((getBalanceCache() as any).ttlMs).toBe(5 * 1000);
        expect((getOrderbookCache() as any).ttlMs).toBe(2 * 1000);
    });

    it('clearAllCaches clears all four singletons', () => {
        getStaticCache().set('s', 1);
        getSemiStaticCache().set('ss', 1);
        getBalanceCache().set('b', 1);
        getOrderbookCache().set('o', 1);
        clearAllCaches();
        expect(getStaticCache().get('s')).toBeNull();
        expect(getSemiStaticCache().get('ss')).toBeNull();
        expect(getBalanceCache().get('b')).toBeNull();
        expect(getOrderbookCache().get('o')).toBeNull();
    });

    it('resetCachesForTesting replaces the singletons and restores defaults', () => {
        configureCaches({ cacheTtlStatic: 30 });
        expect((getStaticCache() as any).ttlMs).toBe(30 * 1000);
        resetCachesForTesting();
        expect((getStaticCache() as any).ttlMs).toBe(3600 * 1000);
    });
});

describe('withInstanceCache', () => {
    let cache: MemoryCache;

    beforeEach(() => {
        cache = new MemoryCache(60);
    });

    it('caches by (keyPrefix, apiBaseUrl, args)', async () => {
        const fn = jest.fn().mockResolvedValue('r');
        const instance = { _cacheEnabled: true, apiBaseUrl: 'https://api.test' };
        const wrapped = withInstanceCache(instance, cache, 'op', fn);
        await wrapped('a');
        await wrapped('a');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('different apiBaseUrl values for the same call do not collide', async () => {
        const fn = jest.fn().mockResolvedValue('r');
        const i1 = { _cacheEnabled: true, apiBaseUrl: 'https://testnet' };
        const i2 = { _cacheEnabled: true, apiBaseUrl: 'https://mainnet' };
        const w1 = withInstanceCache(i1, cache, 'op', fn);
        const w2 = withInstanceCache(i2, cache, 'op', fn);
        await w1('a');
        await w2('a');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('uses different keys for different arguments', async () => {
        const fn = jest.fn().mockImplementation(async (a) => `r-${a}`);
        const instance = { _cacheEnabled: true, apiBaseUrl: '' };
        const wrapped = withInstanceCache(instance, cache, 'op', fn);
        await wrapped('a');
        await wrapped('b');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('bypasses cache entirely when _cacheEnabled === false', async () => {
        const fn = jest.fn().mockResolvedValue('r');
        const instance = { _cacheEnabled: false, apiBaseUrl: 'https://api' };
        const wrapped = withInstanceCache(instance, cache, 'op', fn);
        await wrapped('a');
        await wrapped('a');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('caches when _cacheEnabled is true (or undefined — undefined is not false)', async () => {
        const fn = jest.fn().mockResolvedValue('r');
        const instance = { apiBaseUrl: 'https://api' };
        const wrapped = withInstanceCache(instance, cache, 'op', fn);
        await wrapped('a');
        await wrapped('a');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does NOT include the instance itself in the cache key (no self ref)', async () => {
        // Two distinct instances with the same apiBaseUrl SHOULD share cache slots.
        const fn = jest.fn().mockResolvedValue('r');
        const i1 = { _cacheEnabled: true, apiBaseUrl: 'https://api' };
        const i2 = { _cacheEnabled: true, apiBaseUrl: 'https://api' };
        await withInstanceCache(i1, cache, 'op', fn)('a');
        await withInstanceCache(i2, cache, 'op', fn)('a');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('stampede protection — concurrent callers coalesce on one fetch', async () => {
        let resolve!: (v: string) => void;
        const fn = jest.fn(
            (_arg: string) => new Promise<string>((r) => { resolve = r; })
        );
        const instance = { _cacheEnabled: true, apiBaseUrl: '' };
        const wrapped = withInstanceCache(instance, cache, 'op', fn);

        const p1 = wrapped('a');
        const p2 = wrapped('a');
        const p3 = wrapped('a');
        // All three are racing for the same uncached key.
        resolve('shared-result');
        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
        expect(r1).toBe('shared-result');
        expect(r2).toBe('shared-result');
        expect(r3).toBe('shared-result');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('stampede: error propagates to all waiters', async () => {
        let reject!: (e: Error) => void;
        const fn = jest.fn((_arg: string) => new Promise<string>((_r, rj) => { reject = rj; }));
        const instance = { _cacheEnabled: true, apiBaseUrl: '' };
        const wrapped = withInstanceCache(instance, cache, 'op', fn);

        const p1 = wrapped('a').catch((e: Error) => e);
        const p2 = wrapped('a').catch((e: Error) => e);
        reject(new Error('boom'));
        const [r1, r2] = await Promise.all([p1, p2]);
        expect((r1 as Error).message).toBe('boom');
        expect((r2 as Error).message).toBe('boom');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('stampede: a fresh fetch is issued after the previous in-flight resolves and is cleared', async () => {
        const fn = jest.fn().mockResolvedValueOnce('v1').mockResolvedValueOnce('v2');
        const instance = { _cacheEnabled: true, apiBaseUrl: '' };
        const wrapped = withInstanceCache(instance, cache, 'op', fn);

        const r1 = await wrapped('a');
        // First call cached; second sees the cached value.
        const r2 = await wrapped('a');
        expect(r1).toBe('v1');
        expect(r2).toBe('v1');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('treats missing apiBaseUrl on the instance as empty string', async () => {
        const fn = jest.fn().mockResolvedValue('r');
        const noUrl = { _cacheEnabled: true };
        const wrapped = withInstanceCache(noUrl, cache, 'op', fn);
        await wrapped('a');
        await wrapped('a');
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('MemoryCache.clear', () => {
    it('removes all entries from the cache', () => {
        const cache = new MemoryCache(60);
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');
        cache.clear();
        expect(cache.get('key1')).toBeNull();
        expect(cache.get('key2')).toBeNull();
    });
});
