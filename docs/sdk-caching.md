# SDK Caching Guide (TypeScript)

Guide for configuring the caching layer in the Dexalot TypeScript SDK.

## Overview

The SDK uses TTL-based caching to reduce redundant API and RPC calls. Caches
are organized into four levels, each with its own default TTL tuned to how
frequently the underlying data changes.

Cache entries are stored in an in-memory `MemoryCache` ([`src/utils/cache.ts`](../src/utils/cache.ts))
with FIFO eviction (max 256 entries per instance). Storage is per-client
instance via `withInstanceCache` wrappers.

## Cache Levels

### 1. Static Cache (default: 3600 seconds / 1 hour)

**Purpose:** rarely-changing configuration data.

**Cached methods:**
- `getEnvironments()` — trading environments configuration
- `getChains()` — connected mainnet chains
- `getDeployment()` — deployment configuration

**When to customize:**
- Higher TTL (2–4 hours) to reduce API calls further.
- Lower TTL (e.g. 30 minutes) if deployment config might change mid-session.

```ts
const client = new DexalotClient(createConfig({
    cacheTtlStatic: 7200,  // 2 hours
}));
```

### 2. Semi-Static Cache (default: 900 seconds / 15 minutes)

**Purpose:** data that changes occasionally.

**Cached methods:**
- `getTokens()` — token metadata
- `getClobPairs()` — CLOB trading pairs
- `getSwapPairs(chainId)` — swap pairs for a chain
- `getTokenDetails(token)` — per-token details

**When to customize:**
- Higher TTL (30–60 minutes) for stable production environments.
- Lower TTL (5 minutes) when tokens or pairs are added frequently.

```ts
const client = new DexalotClient(createConfig({
    cacheTtlSemiStatic: 1800,  // 30 minutes
}));
```

### 3. Balance Cache (default: 10 seconds)

**Purpose:** user-specific balance data.

> **Status:** the `cacheTtlBalance` config is wired through to `DexalotConfig`
> but is not currently applied to balance-query methods
> (`getPortfolioBalance`, `getAllPortfolioBalances`, `getChainWalletBalance`,
> `getChainWalletBalances`, `getAllChainWalletBalances`). These methods
> currently return live data on every call. If you need client-side balance
> caching today, wrap the call in your own TTL cache.

Configurable for forward compatibility:

```ts
const client = new DexalotClient(createConfig({
    cacheTtlBalance: 5,  // 5 seconds
}));
```

### 4. Orderbook Cache (default: 1 second)

**Purpose:** real-time orderbook data.

**Cached methods:**
- `getOrderBook(pair)`

**When to customize:**
- Higher TTL (2–5 seconds) if slight delays are acceptable.
- Lower TTL (0.5 seconds) for high-frequency trading loops.
- Set to 0 to disable orderbook caching.

```ts
const client = new DexalotClient(createConfig({
    cacheTtlOrderbook: 0.5,  // 500 ms
}));
```

## Configuration Options

### Enable / disable

```ts
// Enable (default)
const client = new DexalotClient(createConfig({ cacheEnabled: true }));

// Disable all caching
const client = new DexalotClient(createConfig({ cacheEnabled: false }));
```

### Custom TTLs for all levels

```ts
const client = new DexalotClient(createConfig({
    cacheEnabled: true,
    cacheTtlStatic: 7200,      // 2 hours
    cacheTtlSemiStatic: 1800,  // 30 minutes
    cacheTtlBalance: 5,        // 5 seconds (no-op today — see note above)
    cacheTtlOrderbook: 0.5,    // 500 ms
}));
```

### Partial configuration

Unspecified fields fall back to defaults:

```ts
const client = new DexalotClient(createConfig({
    cacheTtlOrderbook: 0.5,  // only override orderbook TTL
}));
```

## Cache Invalidation

### All levels

```ts
client.invalidateCache();
```

### Specific level

`invalidateCache()` accepts `'static' | 'semi_static' | 'balance' | 'orderbook' | 'all'`
(default `'all'`):

```ts
client.invalidateCache('static');
client.invalidateCache('semi_static');
client.invalidateCache('balance');
client.invalidateCache('orderbook');
```

## Use Cases

### High-frequency trading

Minimize cache TTLs for near-real-time data:

```ts
const client = new DexalotClient(createConfig({
    cacheTtlStatic: 3600,
    cacheTtlSemiStatic: 300,    // 5 minutes for pairs
    cacheTtlOrderbook: 0.5,     // 500 ms
}));
```

### Dashboard / analytics

Maximize cache TTLs to reduce API load:

```ts
const client = new DexalotClient(createConfig({
    cacheTtlStatic: 7200,
    cacheTtlSemiStatic: 3600,   // 1 hour
    cacheTtlOrderbook: 5,       // 5 seconds
}));
```

### Development / testing

Disable caching for always-fresh data:

```ts
const client = new DexalotClient(createConfig({ cacheEnabled: false }));
```

### Production API server

Balance performance and freshness (defaults):

```ts
const client = new DexalotClient(createConfig({
    cacheTtlStatic: 3600,
    cacheTtlSemiStatic: 900,
    cacheTtlOrderbook: 1,
}));
```

## Best Practices

1. **Start with defaults.** The default TTLs are tuned for typical use.
2. **Monitor performance.** Adjust TTLs based on measured hit rate and
   freshness complaints.
3. **Disable caching during debugging** if you suspect stale data is masking
   a bug.
4. **Invalidate after writes.** After a state-changing call (place/cancel
   order, deposit, etc.) consider invalidating the relevant cache level
   rather than waiting for TTL expiry.
5. **Per-user balance data:** balance-level caching isn't wired today. If
   you build a per-user cache yourself, key it by address to avoid cross-user
   leakage.

## Performance Metrics

Expected API-call reduction with defaults:

| Data type | Without cache | With cache | Reduction |
|---|---|---|---|
| Static | Every request | 1 / hour | ~99.9% |
| Semi-static | Every request | 1 / 15 min | ~95% |
| Orderbook | Every request | 1 / sec | Depends on request rate |
| Balance | Every request | Every request (no cache today) | 0% |

## Troubleshooting

### Stale data

- Check TTL values — they may be too high for your use case.
- Manually invalidate: `client.invalidateCache()` (or a specific level).
- Temporarily disable caching to confirm the issue is cache-related.

### Cache appears to do nothing

- Verify `cacheEnabled: true` (or omitted — default is `true`).
- Confirm you're calling the same method with the same arguments repeatedly.
- Balance methods don't hit the cache today (see the Balance Cache note).

### Memory concerns

`MemoryCache` caps at 256 entries per cache with FIFO eviction
([`src/utils/cache.ts:12`](../src/utils/cache.ts)). In practice, hitting this
limit means your workload is broader than a single client session is tuned
for. Options:
- Reduce TTLs so entries expire faster.
- Disable caching for less-used data.
- Periodically call `invalidateCache()` during long-running processes.

## Technical Details

- **Implementation:** `MemoryCache` class, TTL stored in milliseconds
  (`ttlSeconds * 1000`). See [`src/utils/cache.ts`](../src/utils/cache.ts).
- **Scope:** per-client-instance via `withInstanceCache` wrappers, not
  module-level. Separate client instances do not share cache entries.
- **Thread safety:** JavaScript is single-threaded; no explicit
  synchronization. Safe within a single Node.js or browser event loop.
- **Persistence:** cache is lost when the process terminates.
- **Max size:** 256 entries per cache, FIFO eviction.

## See Also

- [`src/core/config.ts`](../src/core/config.ts) — cache config fields and defaults
- [`src/core/base.ts`](../src/core/base.ts) — `invalidateCache()` implementation
- [`src/utils/cache.ts`](../src/utils/cache.ts) — `MemoryCache` implementation
