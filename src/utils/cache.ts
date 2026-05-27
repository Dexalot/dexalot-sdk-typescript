/**
 * In-memory TTL cache with amortized cleanup and per-cache stampede
 * protection. Module-level singletons (`getStaticCache`,
 * `getSemiStaticCache`, `getBalanceCache`, `getOrderbookCache`) back
 * the four tier-specific caches the SDK uses; all client instances
 * share them so a long-lived process never pays an unnecessary fetch
 * for the same key across instances.
 *
 * Cache keys are namespaced by `apiBaseUrl` so testnet and mainnet
 * clients do not collide on the same `(method, args)` pair.
 */

interface CacheEntry<T> {
    value: T;
    expiry: number;
}

export class MemoryCache {
    /** TTL-expiry sweep runs once per this many `set` calls. */
    public static readonly CLEANUP_INTERVAL = 50;

    private store: Map<string, CacheEntry<any>> = new Map();
    /** Per-cache in-flight Promise map for stampede protection. */
    private pending: Map<string, Promise<any>> = new Map();
    private ttlMs: number;
    private maxSize: number;
    private writeCount: number = 0;

    constructor(ttlSeconds: number, maxSize: number = 256) {
        this.ttlMs = ttlSeconds * 1000;
        this.maxSize = maxSize;
    }

    /** Update the TTL without replacing the cache instance. */
    public setTtl(ttlSeconds: number): void {
        this.ttlMs = ttlSeconds * 1000;
    }

    /** Update the size cap without replacing the cache instance. */
    public setMaxSize(maxSize: number): void {
        this.maxSize = maxSize;
        this.trim();
    }

    public get<T>(key: string): T | null {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiry) {
            this.store.delete(key);
            return null;
        }
        return entry.value as T;
    }

    public set(key: string, value: any): void {
        this.store.set(key, { value, expiry: Date.now() + this.ttlMs });
        // Trim runs on every write to enforce the size cap immediately;
        // the TTL-expiry sweep is amortized over CLEANUP_INTERVAL writes.
        this.trim();
        this.writeCount++;
        if (this.writeCount >= MemoryCache.CLEANUP_INTERVAL) {
            this.cleanup();
            this.writeCount = 0;
        }
    }

    public clear(): void {
        this.store.clear();
        this.pending.clear();
        this.writeCount = 0;
    }

    /** Return the current entry count (live + still-stored expired). */
    public get size(): number {
        return this.store.size;
    }

    // --- Stampede coordination (used by withInstanceCache) ---

    public getPending<T>(key: string): Promise<T> | undefined {
        return this.pending.get(key) as Promise<T> | undefined;
    }

    public setPending<T>(key: string, promise: Promise<T>): void {
        this.pending.set(key, promise);
    }

    public deletePending(key: string): void {
        this.pending.delete(key);
    }

    private trim(): void {
        if (this.store.size > this.maxSize) {
            const numToRemove = this.store.size - this.maxSize;
            const iter = this.store.keys();
            for (let i = 0; i < numToRemove; i++) {
                const k = iter.next().value;
                if (k !== undefined) this.store.delete(k);
            }
        }
    }

    private cleanup(): void {
        const now = Date.now();
        for (const [key, entry] of this.store.entries()) {
            if (now > entry.expiry) {
                this.store.delete(key);
            }
        }
    }
}

// --- Module-level cache singletons ---
//
// All client instances share these so a process-wide long-lived SDK
// never re-fetches the same (apiBaseUrl, method, args) pair across
// instances. Sizes mirror the Python SDK's tier-specific defaults.

let _STATIC_CACHE = new MemoryCache(3600, 128);          // 1h
let _SEMI_STATIC_CACHE = new MemoryCache(900, 256);       // 15m
let _BALANCE_CACHE = new MemoryCache(10, 512);            // 10s
let _ORDERBOOK_CACHE = new MemoryCache(1, 256);           // 1s

export function getStaticCache(): MemoryCache {
    return _STATIC_CACHE;
}
export function getSemiStaticCache(): MemoryCache {
    return _SEMI_STATIC_CACHE;
}
export function getBalanceCache(): MemoryCache {
    return _BALANCE_CACHE;
}
export function getOrderbookCache(): MemoryCache {
    return _ORDERBOOK_CACHE;
}

/**
 * Override module-level cache TTLs from config. Mutates the underlying
 * singleton in place so any references already held by clients continue
 * to point at the live cache. Only TTLs that differ from the defaults
 * are applied; passing the default value is a no-op.
 */
export function configureCaches(config: {
    cacheTtlStatic?: number;
    cacheTtlSemiStatic?: number;
    cacheTtlBalance?: number;
    cacheTtlOrderbook?: number;
}): void {
    if (config.cacheTtlStatic !== undefined && config.cacheTtlStatic !== 3600) {
        _STATIC_CACHE.setTtl(config.cacheTtlStatic);
    }
    if (config.cacheTtlSemiStatic !== undefined && config.cacheTtlSemiStatic !== 900) {
        _SEMI_STATIC_CACHE.setTtl(config.cacheTtlSemiStatic);
    }
    if (config.cacheTtlBalance !== undefined && config.cacheTtlBalance !== 10) {
        _BALANCE_CACHE.setTtl(config.cacheTtlBalance);
    }
    if (config.cacheTtlOrderbook !== undefined && config.cacheTtlOrderbook !== 1) {
        _ORDERBOOK_CACHE.setTtl(config.cacheTtlOrderbook);
    }
}

/**
 * Clear all four module-level caches. Test suites should call this in
 * `beforeEach` / `afterEach` to avoid cross-test contamination — the
 * singletons live for the whole process.
 */
export function clearAllCaches(): void {
    _STATIC_CACHE.clear();
    _SEMI_STATIC_CACHE.clear();
    _BALANCE_CACHE.clear();
    _ORDERBOOK_CACHE.clear();
}

/**
 * Reset the four module-level caches to fresh `MemoryCache` instances
 * with the default TTLs and sizes. Tests use this when they need to
 * assert against the default behavior after a `configureCaches` call.
 */
export function resetCachesForTesting(): void {
    _STATIC_CACHE = new MemoryCache(3600, 128);
    _SEMI_STATIC_CACHE = new MemoryCache(900, 256);
    _BALANCE_CACHE = new MemoryCache(10, 512);
    _ORDERBOOK_CACHE = new MemoryCache(1, 256);
}

/**
 * Cache an async instance method.
 *
 * The cache key combines the supplied prefix, the instance's
 * `apiBaseUrl` (so testnet and mainnet clients do not collide), and a
 * JSON serialization of the call's arguments. The instance itself is
 * NOT serialized — a strong reference to `this` would prevent garbage
 * collection of short-lived clients and would diverge cache keys for
 * the same logical call across instances.
 *
 * Stampede protection: concurrent callers for the same uncached key
 * coalesce on a shared `Promise`. The wrapped function runs exactly
 * once per key per fetch window; subsequent waiters receive the same
 * result (or the same error).
 *
 * Cache bypass: when `instance._cacheEnabled === false`, the wrapped
 * function is invoked directly with no cache interaction.
 */
export function withInstanceCache<T extends (...args: any[]) => Promise<any>>(
    instance: any,
    cache: MemoryCache,
    keyPrefix: string,
    fn: T
): T {
    return (async (...args: any[]): Promise<any> => {
        if (instance && instance._cacheEnabled === false) {
            return await fn(...args);
        }

        const apiBaseUrl: string =
            (instance && typeof instance.apiBaseUrl === 'string' && instance.apiBaseUrl) || '';
        const key = `${keyPrefix}|${apiBaseUrl}|${JSON.stringify(args)}`;

        const cached = cache.get<any>(key);
        if (cached !== null) {
            return cached;
        }

        // Stampede check: if another caller has an in-flight fetch
        // for this key, wait on the same Promise.
        const inFlight = cache.getPending<any>(key);
        if (inFlight !== undefined) {
            return await inFlight;
        }

        const promise = (async () => {
            const result = await fn(...args);
            cache.set(key, result);
            return result;
        })();
        cache.setPending(key, promise);

        try {
            return await promise;
        } finally {
            cache.deletePending(key);
        }
    }) as T;
}
