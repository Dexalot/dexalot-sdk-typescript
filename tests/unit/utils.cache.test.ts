import { MemoryCache, withCache, withInstanceCache } from '../../src/utils/cache';

describe('MemoryCache', () => {
    let cache: MemoryCache;
    // Mock Date.now
    let now: number;

    beforeEach(() => {
        jest.useFakeTimers();
        now = 1000;
        jest.setSystemTime(now);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should store and retrieve values', () => {
        cache = new MemoryCache(60); // 60 seconds TTL
        cache.set('key1', 'value1');
        expect(cache.get('key1')).toBe('value1');
    });

    it('should return null for non-existent keys', () => {
        cache = new MemoryCache(60);
        expect(cache.get('missing')).toBeNull();
    });

    it('should expire items after TTL', () => {
        cache = new MemoryCache(10); // 10 seconds TTL
        cache.set('key1', 'value1');
        
        // Advance time by 11 seconds
        jest.setSystemTime(now + 11000);
        
        expect(cache.get('key1')).toBeNull();
    });

    it('should cleanup expired items explicitly on set', () => {
        cache = new MemoryCache(10);
        cache.set('key1', 'value1'); // Expires at 11000
        
        // Advance time 
        jest.setSystemTime(now + 12000);

        // This set triggers cleanup
        cache.set('key2', 'value2');
        
        // key1 should be gone from store (internal check via get returning null is standard)
        expect(cache.get('key1')).toBeNull(); 
    });

    it('should enforce maxSize via LRU-like eviction', () => {
        cache = new MemoryCache(60, 2); // Max size 2
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');

        // Add 3rd item, should evict older one (iteration order)
        cache.set('key3', 'value3');

        // Map insertion order: key1, key2, key3. 
        // When removing excess (size 3 > 2), it iterates keys().next().
        // First key inserted (key1) is first in iterator. 
        expect(cache.get('key1')).toBeNull();
        expect(cache.get('key2')).toBe('value2');
        expect(cache.get('key3')).toBe('value3');
    });

    it('should handle edge case with empty string keys during eviction', () => {
        // Test eviction behavior with empty string key
        cache = new MemoryCache(60, 1); // Max size 1
        cache.set('', 'empty');
        
        // Adding second entry should trigger eviction
        cache.set('key2', 'value2');

        // Verify behavior: empty string key handling during eviction
        expect(cache.get('')).toBe('empty');
        expect(cache.get('key2')).toBe('value2');
    });
});

describe('withCache', () => {
    let cache: MemoryCache;

    beforeEach(() => {
        cache = new MemoryCache(60);
    });

    it('should cache async function results', async () => {
        const mockFn = jest.fn().mockResolvedValue('result');
        const cachedFn = withCache(cache, 'test', mockFn);

        // First call
        const res1 = await cachedFn('arg1');
        expect(res1).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(1);

        // Second call - should use cache
        const res2 = await cachedFn('arg1');
        expect(res2).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should use different keys for different arguments', async () => {
        const mockFn = jest.fn().mockImplementation(async (arg) => `result-${arg}`);
        const cachedFn = withCache(cache, 'test', mockFn);

        await cachedFn('a');
        await cachedFn('b');

        expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should bypass cache when caching is disabled on instance', async () => {
        // Simulate instance method call with caching disabled
        const mockFn = jest.fn().mockResolvedValue('result');
        const instance = { _cacheEnabled: false };
        const cachedFn = withCache(cache, 'test', mockFn);

        // First call should execute function
        const res1 = await cachedFn(instance, 'arg1');
        expect(res1).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(1);

        // Second call with same args should still execute (cache bypassed)
        const res2 = await cachedFn(instance, 'arg1');
        expect(res2).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should use cache when caching is enabled on instance', async () => {
        // Simulate instance method call with caching enabled
        const mockFn = jest.fn().mockResolvedValue('result');
        const instance = { _cacheEnabled: true };
        const cachedFn = withCache(cache, 'test', mockFn);

        // First call should execute and cache result
        const res1 = await cachedFn(instance, 'arg1');
        expect(res1).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(1);

        // Second call with same args should use cached result
        const res2 = await cachedFn(instance, 'arg1');
        expect(res2).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should handle function calls without instance object', async () => {
        // Test behavior when first argument is not an object (not an instance method)
        const mockFn = jest.fn().mockResolvedValue('result');
        const cachedFn = withCache(cache, 'test', mockFn);

        // Should work normally and use cache
        const res = await cachedFn('arg1');
        expect(res).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(1);
    });
});

describe('withInstanceCache', () => {
    let cache: MemoryCache;

    beforeEach(() => {
        cache = new MemoryCache(60);
    });

    it('should cache function results when caching is enabled', async () => {
        // Test caching behavior with instance cache wrapper
        const mockFn = jest.fn().mockResolvedValue('result');
        const instance = { _cacheEnabled: true };
        const cachedFn = withInstanceCache(instance, cache, 'test', mockFn);

        // First call should execute function and cache result
        const res1 = await cachedFn('arg1');
        expect(res1).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(1);

        // Second call with same arguments should return cached result
        const res2 = await cachedFn('arg1');
        expect(res2).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should bypass cache when caching is disabled on instance', async () => {
        // Test cache bypass behavior
        const mockFn = jest.fn().mockResolvedValue('result');
        const instance = { _cacheEnabled: false };
        const cachedFn = withInstanceCache(instance, cache, 'test', mockFn);

        // First call should execute function
        const res1 = await cachedFn('arg1');
        expect(res1).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(1);

        // Second call should execute again (cache bypassed)
        const res2 = await cachedFn('arg1');
        expect(res2).toBe('result');
        expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should use different keys for different arguments', async () => {
        const mockFn = jest.fn().mockImplementation(async (arg) => `result-${arg}`);
        const instance = { _cacheEnabled: true };
        const cachedFn = withInstanceCache(instance, cache, 'test', mockFn);

        await cachedFn('a');
        await cachedFn('b');

        expect(mockFn).toHaveBeenCalledTimes(2);
    });
});

describe('MemoryCache.clear', () => {
    it('should remove all entries from cache', () => {
        const cache = new MemoryCache(60);
        // Add multiple entries
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');
        
        // Verify entries exist
        expect(cache.get('key1')).toBe('value1');
        expect(cache.get('key2')).toBe('value2');
        
        // Clear cache
        cache.clear();
        
        // Verify all entries are removed
        expect(cache.get('key1')).toBeNull();
        expect(cache.get('key2')).toBeNull();
    });
});
