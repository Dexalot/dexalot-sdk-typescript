# Architecture Overview

Internal architecture of the Dexalot TypeScript SDK for contributors and advanced users. The TypeScript implementation tracks the [Python SDK's architecture](https://github.com/Dexalot/dexalot-sdk-python/blob/main/docs/python-sdk-architecture.md) — the same concepts apply, with language-specific deviations called out.

---

## Client composition

`DexalotClient` is assembled via single-inheritance class chaining (TypeScript doesn't have Python-style multiple inheritance):

```
DexalotClient
└── TransferClient        ← extends
    └── SwapClient        ← extends
        └── CLOBClient    ← extends
            └── BaseClient
```

`BaseClient` carries the shared infrastructure: HTTP client (axios), signer, nonce manager, rate limiters, cache references, provider manager. Each subclass adds its domain methods on top. The chain order is fixed; if you need to slot your own layer between two of them, use the `internal` subpath which exposes each class directly.

---

## 4-tier cache

Cache instances are **module-level singletons** defined in `src/utils/cache.ts`. They are shared across all `DexalotClient` instances in the same process.

| Tier | Accessor | Default TTL | Max size | Data |
|---|---|---|---|---|
| Static | `getStaticCache()` | 3600 s (1 h) | 128 | Environments, deployments |
| Semi-Static | `getSemiStaticCache()` | 900 s (15 m) | 256 | Tokens, trading pairs |
| Balance | `getBalanceCache()` | 10 s | 512 | Portfolio and wallet balances |
| Orderbook | `getOrderbookCache()` | 1 s | 256 | Order book snapshots, candles, market snapshot |

TTLs are configurable via `DexalotConfig.cacheTtl*` fields. `BaseClient.constructor` calls `configureCaches(config)` which mutates the singleton's TTL in place (via `setTtl`), preserving the singleton's identity so any references that other code already captured stay live.

**Cache key structure:** `` `${keyPrefix}|${apiBaseUrl}|${JSON.stringify(args)}` ``. The instance itself is **never** in the key — including `this` would prevent GC of short-lived clients and would diverge slots for the same logical call. Keys are namespaced by `apiBaseUrl`, so testnet and mainnet clients in the same process have independent cache namespaces.

**Stampede protection:** `withInstanceCache` consults a per-`MemoryCache` `pending: Map<string, Promise<any>>` on every read. Concurrent callers for the same uncached key share a single in-flight Promise; the underlying fetch runs exactly once per key per fetch window. Failures propagate to all waiters.

**Cache cleanup:** `MemoryCache.set` increments a write counter and runs the full TTL-expiry sweep once per `CLEANUP_INTERVAL` (50) writes. The size-cap trim runs on every write. Cleanup is amortized; trimming is immediate.

**Bypassing the cache:** Pass `cacheEnabled: false` to `createConfig` for a per-instance bypass, or call `client.invalidateCache('all')` to clear all tiers. `client.invalidateCache(level)` supports `'static' | 'semi_static' | 'balance' | 'orderbook' | 'all'`.

**Multi-env caveat:** Running testnet and mainnet clients simultaneously in the same process is safe because cache keys are namespaced by `apiBaseUrl`. Test suites that populate the singletons must reset between tests — the SDK exposes `clearAllCaches()` and `resetCachesForTesting()` for that purpose, and the repo's `jest.setupAfterEnv.js` wires them into a global `beforeEach`.

See [Caching Guide](sdk-caching.md) for TTL tuning.

---

## Async model

All I/O is built on Promises and `async/await`. The SDK targets the Node.js event loop — no worker threads, no `child_process`.

**HTTP:** `axios` with a configurable connection pool. A single `AxiosInstance` is created per `BaseClient` and reused for the lifetime of the client. `initializeClient()` does the first round of static / semi-static fetches.

**WebSocket:** Node's `ws` library, wrapped by `WebSocketManager`. Pinned to `ws@^8.18.0` via `package.json` `pnpm.overrides` to clear a transitive moderate advisory in older ws versions reached through ethers' transitive tree. `subscribeToEvents()` and `unsubscribeFromEvents()` are async-and-sync respectively; `closeWebsocket()` shuts the manager down cleanly. WebSocket is opt-in via `wsManagerEnabled: true` in the config.

**Callbacks:** WebSocket message callbacks run on the same event loop and can `await` normally.

---

## Rate limiting

Each client instance has its own rate limiter:

- **API limiter:** `rateLimitRequestsPerSecond` (default: 5 req/s)
- **RPC limiter:** `rateLimitRpcPerSecond` (default: 10 req/s)

`AsyncRateLimiter` advances a wall-clock cursor (`nextSlot`) synchronously per `acquire()` call, then sleeps the caller until its slot opens. Multiple concurrent callers reserve distinct slots before any of them sleep, so each caller's sleep runs in parallel — request body preparation and response handling can overlap with previous callers' waits.

**Multi-client caveat:** Multiple concurrent `DexalotClient` instances do not share quotas and can collectively exceed the server-side limit. There is no centralized rate limiter.

---

## Nonce manager

`AsyncNonceManager` enforces sequential nonce acquisition per `(chainId, address)` pair via a Promise-chain queue:

- Each `acquireLock(key)` reads the previous tail from the `locks` map and publishes its own "released" Promise as the new tail **synchronously** (no microtask boundary between the read and the publish). Concurrent acquisitions for the same key never lose their place in line.
- Different keys never block each other.
- The `locks` map only holds the latest tail per key; older Promises stay alive only as long as their waiters hold them in closure scope, then GC.

This is "correctness over throughput" by design — high-frequency transaction batching contends on the per-key chain to prevent double-nonce errors.

---

## RPC provider failover

`ProviderManager` (`src/utils/providerManager.ts`) tracks failure counts per provider URL:

- A provider is marked unhealthy after `providerFailoverMaxFailures` consecutive failures (default: 3).
- Unhealthy providers enter a cooldown of `providerFailoverCooldown` seconds (default: 60 s) before being retried.
- If all providers are unhealthy, the first cooldown-expired one is reset and reused; if none have cooled down, `getProvider` returns `null` and the caller surfaces a failure.

`getProvider` is **synchronous and allocation-free** — it walks the health list once per call with no locks or async waits.

RPC URLs can be overridden per chain via `DEXALOT_RPC_<CHAIN_ID>` environment variables (comma-separated for multiple providers):

```bash
DEXALOT_RPC_43114=https://primary.rpc.example.com,https://backup.rpc.example.com
```

---

## Security decisions

### Private key handling

After `Wallet` construction, `config.privateKey` is cleared from the config object in both the success and the throwing branches (`BaseClient._setupSignerFromPrivateKey`). Prefer passing a pre-built `Signer` to the constructor so the raw key never touches the config at all.

### HTTP method allowlist

`_apiCall` rejects any method outside `{'get','post','put','delete'}` at runtime, on top of the TypeScript-level union type. Defense-in-depth against `as any` bypasses and against the type-erased `axios.request({ method })` shape.

### Insecure RPC rejection

`_rejectInsecureRpcUrls()` in `base.ts` rejects plain `http://` RPC endpoints at provider setup time unless `allowInsecureRpc: true` is set. Fail-fast before any traffic is sent over plaintext.

### ERC20 allowance revoke on tx failure

When `deposit` / `withdraw` grants an allowance via `_ensureAllowance(MaxUint256)` and the subsequent `depositToken` / `withdrawToken` then reverts, the path calls `_revokeAllowance(token, spender, 0n)` as a best-effort cleanup. The original tx error is always rethrown; secondary revoke failures are logged at debug and swallowed.

### Error sanitization

`errorSanitizer.ts` strips file paths, RPC URLs, and stack traces from user-facing error messages. At `logLevel: 'debug'` the logger emits full context to logs before sanitization — `result.error` is always sanitized regardless of log level.

### Timestamped auth

`timestampedAuth: true` (env: `DEXALOT_TIMESTAMPED_AUTH=true`) enables the `"dexalot{ts}"` signing message plus `x-timestamp` header. Default is `false` — the backend currently only accepts the static `"dexalot"` message. Enable only after the backend confirms timestamp-window validation.

---

## Precision-safe arithmetic

Every amount and price on a write path goes through Big.js. The `toWei(value, decimals)` helper in `src/utils/decimal.ts` evaluates `BigInt(new Big(String(value)).times(new Big(10).pow(decimals)).toFixed(0, Big.roundDown))` — precision-exact for `number`, `string`, `bigint`, and `Big` inputs. Float multiplication like `BigInt(Math.floor(2933.0 * 10**18))` silently drops 262144 wei and the contract rejects the order with `T-TMDQ-01`. Big.js is pinned to an exact version; the helper is the single source of truth for the four CLOB write paths plus the six TRANSFER write paths plus the bridge-fee preflight.

Display-decimal precision uses a **REJECT-with-tolerance** gate (`checkDisplayPrecision`) — over-precise inputs raise `Result.fail`, but residuals within `1e-10` of a representable value (binary-float noise like `0.1 + 0.2 = 0.30000000000000004`) snap to the nearest displayable value rather than failing. Silent rounding would be dangerous in a trading SDK — a stop at `99.99` quietly becoming `99.9` is silent slippage. Pairs whose API record lacks `base_display_decimals` or `quote_display_decimals` are **dropped at ingest** with a logged warning rather than silently defaulted.

---

## Key files

All paths relative to `src/`.

| Component | Path | Purpose |
|---|---|---|
| Entry point | `core/client.ts` | `DexalotClient` — user-facing class |
| Base client | `core/base.ts` | Auth, HTTP, ethers, cache wiring |
| Config | `core/config.ts` | `DexalotConfig`, `createConfig`, `loadConfigFromEnv` |
| CLOB | `core/clob.ts` | Order book, trading, market data |
| Swap | `core/swap.ts` | RFQ and simple swap |
| Transfer | `core/transfer.ts` | Balances, deposits, withdrawals, transfers |
| Result type | `utils/result.ts` | `Result<T>` — no-exception return type |
| Cache | `utils/cache.ts` | `MemoryCache` + module-level singletons + `withInstanceCache` |
| Decimal | `utils/decimal.ts` | `toWei`, `fromWei`, `Big`, precision gates |
| Rate limiter | `utils/rateLimit.ts` | Independent-sleep `AsyncRateLimiter` |
| Retry | `utils/retry.ts` | `asyncRetry` with exponential backoff |
| Nonce manager | `utils/nonceManager.ts` | Per-`(chainId, address)` FIFO Promise-chain queue |
| Provider mgr | `utils/providerManager.ts` | Multi-provider RPC failover |
| WebSocket | `utils/websocketManager.ts` | WebSocket lifecycle and subscription management |
| Error sanitizer | `utils/errorSanitizer.ts` | Strip sensitive context from error messages |
| Observability | `utils/observability.ts` | Logging configuration, structured events, request-ID scoping |
| Input validators | `utils/inputValidators.ts` | Validation helpers used across the chain |
| Secrets vault | `utils/secretsVault.ts` | Fernet-encrypted JSON vault (Node only) |
