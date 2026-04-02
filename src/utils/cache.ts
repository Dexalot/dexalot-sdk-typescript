
interface CacheEntry<T> {
    value: T;
    expiry: number;
}

export class MemoryCache {
    private store: Map<string, CacheEntry<any>> = new Map();
    private ttl: number;
    private maxSize: number;

    constructor(ttlSeconds: number, maxSize: number = 256) {
        this.ttl = ttlSeconds * 1000; // Convert to ms
        this.maxSize = maxSize;
    }

    private cleanup() {
        const now = Date.now();
        // Remove expired
        for (const [key, entry] of this.store.entries()) {
            if (now > entry.expiry) {
                this.store.delete(key);
            }
        }
        
        if (this.store.size > this.maxSize) {
            const numToRemove = this.store.size - this.maxSize;
            const keys = this.store.keys();
            for (let i = 0; i < numToRemove; i++) {
                const keyToRemove = keys.next().value;
                if (keyToRemove) this.store.delete(keyToRemove);
            }
        }
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

    public set(key: string, value: any) {
        this.store.set(key, {
            value,
            expiry: Date.now() + this.ttl
        });
        this.cleanup();
    }

    public clear(): void {
        this.store.clear();
    }
}

/**
 * Decorator-like wrapper for caching async function calls.
 * TypeScript decorators on functions are experimental/limited, so using a wrapper function pattern.
 * Automatically respects _cacheEnabled flag on instance.
 */
export function withCache<T extends (...args: any[]) => Promise<any>>(
    cache: MemoryCache,
    keyPrefix: string,
    fn: T
): T {
    return (async (...args: any[]): Promise<any> => {
        // Check if this is an instance method and if caching is disabled
        // First argument is typically 'this' for instance methods
        if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
            const instance = args[0] as any;
            if (instance._cacheEnabled === false) {
                // Bypass cache entirely - call function directly
                return await fn(...args);
            }
        }
        
        const key = `${keyPrefix}:${JSON.stringify(args)}`;
        const cached = cache.get<any>(key);
        if (cached !== null) {
            return cached;
        }
        
        const result = await fn(...args);
        cache.set(key, result);
        return result;
    }) as T;
}

/**
 * Create a cached method that respects instance _cacheEnabled flag.
 * Use this for instance methods that need caching.
 * 
 * @param instance - The instance object (for checking _cacheEnabled)
 * @param cache - The cache instance to use
 * @param keyPrefix - Prefix for cache keys
 * @param fn - The async function to cache
 * @returns Cached version of the function
 */
export function withInstanceCache<T extends (...args: any[]) => Promise<any>>(
    instance: any,
    cache: MemoryCache,
    keyPrefix: string,
    fn: T
): T {
    return (async (...args: any[]): Promise<any> => {
        // Check if caching is disabled on instance
        if (instance._cacheEnabled === false) {
            return await fn(...args);
        }
        
        const key = `${keyPrefix}:${JSON.stringify(args)}`;
        const cached = cache.get<any>(key);
        if (cached !== null) {
            return cached;
        }
        
        const result = await fn(...args);
        cache.set(key, result);
        return result;
    }) as T;
}
