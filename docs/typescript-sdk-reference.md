# API Reference

The TypeScript SDK exposes its public surface through three subpath entry points. Use `@dexalot/dexalot-sdk` for normal application code, `@dexalot/dexalot-sdk/internal` to compose your own mixin variants, and `@dexalot/dexalot-sdk/secrets-vault` only in Node-side tooling that needs to read/write the Fernet-encrypted vault file.

For protocol-level details see [REST API](rest-api.md), [WebSocket Protocol](websocket.md), and [Simple Swap](simple-swap.md).

---

## Module layout

```
src/
├── core/
│   ├── client.ts        ← DexalotClient (entry point)
│   ├── base.ts          ← BaseClient (auth, HTTP, ethers, cache, config)
│   ├── clob.ts          ← CLOBClient (order book, trading, market data)
│   ├── swap.ts          ← SwapClient (RFQ, simple swap)
│   ├── transfer.ts      ← TransferClient (balances, deposit, withdraw)
│   └── config.ts        ← DexalotConfig + createConfig + loadConfigFromEnv
├── utils/
│   ├── result.ts            ← Result<T>
│   ├── cache.ts             ← MemoryCache + module-level singletons
│   ├── decimal.ts           ← toWei, fromWei, Big, precision gates
│   ├── observability.ts     ← logger config, withRequestId, trackMethod
│   ├── rateLimit.ts         ← AsyncRateLimiter
│   ├── nonceManager.ts      ← AsyncNonceManager (FIFO chain per key)
│   ├── providerManager.ts   ← Multi-provider RPC failover
│   ├── retry.ts             ← asyncRetry with exponential backoff
│   ├── errorSanitizer.ts    ← Strip sensitive context
│   ├── inputValidators.ts   ← Validation helpers
│   ├── tokenNormalization.ts
│   ├── chainResolver.ts
│   ├── secretsVault.ts      ← Fernet-encrypted JSON vault (Node only)
│   └── websocketManager.ts
├── types/index.ts       ← Public type declarations
├── constants.ts
├── errors.ts            ← Revert reason parsing
├── index.ts             ← Public entry point
├── internal.ts          ← Mixin/composition subpath
└── secrets-vault.ts     ← Node-only secrets vault subpath
```

**Inheritance chain** (`DexalotClient` MRO, simplified):

```
DexalotClient
└── TransferClient        ← extends
    └── SwapClient        ← extends
        └── CLOBClient    ← extends
            └── BaseClient
```

TypeScript uses single inheritance; the three "mixins" are layered in a chain rather than mixed in horizontally. Each layer adds its domain methods on top of `BaseClient`'s shared infrastructure.

---

## Public entry point — `@dexalot/dexalot-sdk`

The default and most-used subpath. Exports:

| Symbol | Kind | Purpose |
|---|---|---|
| `DexalotClient` | class (default export too) | Top-level client. All CLOB / swap / transfer methods. |
| `createConfig(partial?)` | factory | Build a `DexalotConfig` from a partial, applying defaults and validation. |
| `loadConfigFromEnv()` | factory | Build a `DexalotConfig` from `DEXALOT_*` env vars + `.env`. |
| `DexalotConfig` | type | Shape of the config dict. |
| `Result` | class | `Result.ok(data)` / `Result.fail(error)`. |
| `MemoryCache` | class | The cache primitive (rarely needed by consumers). |
| `configureLogging(level?, format?)` | fn | Set log level (`debug`/`info`/`warn`/`error`) and format (`console`/`json`). |
| `getLogger(name)` | fn | Get a structured logger scoped to a component. |
| `withRequestId(id, fn)` | fn | Scope a `requestId` to a sync or async callback (every log inside the scope carries the field). |
| `setRequestId / getRequestId` | fns | Manual request-ID context management. |
| `getLogLevel / getLogFormat` | fns | Inspect current logger config. |
| `Logger` | type | Structured-logger interface. |
| `LogLevel` | type | Union of allowed log levels. |
| `version`, `getVersion()` | string / fn | The SDK's current semver. |

```ts
import {
    DexalotClient,
    createConfig,
    loadConfigFromEnv,
    Result,
    configureLogging,
    withRequestId,
    getLogger,
} from '@dexalot/dexalot-sdk';
```

---

## Mixin / composition subpath — `@dexalot/dexalot-sdk/internal`

Used by codebases that want to compose their own variant of `DexalotClient` (e.g. omitting Swap, layering custom telemetry between mixins, etc.). Exports `BaseClient`, `CLOBClient`, `SwapClient`, `TransferClient`, and a few internal types alongside the public surface. Browser-safe — does NOT pull in `node:fs` / `node:crypto`.

---

## Secrets-vault subpath — `@dexalot/dexalot-sdk/secrets-vault`

Node-only. Reads/writes Fernet-encrypted JSON at `~/.dexalot/secrets_vault.json` (configurable via `DEXALOT_SECRETS_VAULT_PATH`). Same on-disk format as the Python SDK's vault, so both toolchains can share a single file.

```ts
import {
    generateSecretsVaultKey,
    secretsVaultGet,
    secretsVaultSet,
    secretsVaultRemove,
    secretsVaultList,
} from '@dexalot/dexalot-sdk/secrets-vault';
```

Throws if loaded in a browser (the module uses `node:fs` and `node:crypto`).

---

## `DexalotClient`

Top-level client. Composes CLOB, Swap, and Transfer functionality on top of `BaseClient`. The public surface includes:

**Lifecycle:** `initializeClient()`, `reinitialize()`, `close()`, `closeWebsocket(graceS?)`, `setSigner(signer)`.

**Reads:** `getEnvironments()`, `getChains()`, `getTokens()`, `getClobPairs()`, `getSwapPairs(chain)`, `getOrderBook(pair)`, `getCandles(pair, interval, limit)`, `getMarketSnapshot()`, `get24hStats(pair)`, `getOrder(id)`, `getOrderByClientId(id)`, `getOpenOrders(pair?)`.

**Balances:** `getPortfolioBalance(token, address?)`, `getAllPortfolioBalances(address?)`, `getChainWalletBalance(chain, token, address?)`, `getChainWalletBalances(chain, address?)`, `getAllChainWalletBalances(address?)`, `getChainTokenBalances(chain, tokens, address?)`.

**Writes (CLOB):** `addOrder(req)`, `addLimitOrderList(orders)`, `cancelOrder(id)`, `cancelOrderByClientId(id)`, `cancelListOrdersByClientId(ids)`, `replaceOrder(id, newPrice, newAmount)`, `cancelAddList(replacements)`.

**Writes (Transfer / Swap):** `deposit(token, amount, sourceChain, useLayerZero?)`, `withdraw(token, amount, destChain, useLayerZero?)`, `transferPortfolio(token, amount, toAddress)`, `transferToken(token, amount, toAddress)`, `addGas(amount)`, `removeGas(amount)`, `getSwapFirmQuote(...)`, `getSwapSoftQuote(...)`, `executeRFQSwap(quote, waitForReceipt?)`.

**WebSocket:** `subscribeToEvents(topic, callback, isPrivate)`, `unsubscribeFromEvents(topic)`, `closeWebsocket(graceS?)`.

**Cache:** `invalidateCache(level)` — `'static' | 'semi_static' | 'balance' | 'orderbook' | 'all'`.

**Static helpers:** `DexalotClient.unitConversion(value, decimals, toBase)`, `DexalotClient.configureLogging(level, format)`, `DexalotClient.getVersion()`.

---

## `Result<T>`

```ts
type Result<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };
```

Factory helpers:

```ts
const ok = Result.ok({ key: 'value' });    // { success: true, data: {...}, error: null }
const failed = Result.fail('Token not found'); // { success: false, data: null, error: '...' }
```

Always discriminate on `success` before reading `data` — TypeScript will narrow the type automatically inside the conditional.

---

## `DexalotConfig`

Build via `createConfig(partial?)` or `loadConfigFromEnv()`. Every constructor field has a sensible default; selected fields:

| Field | Default | Purpose |
|---|---|---|
| `parentEnv` | `'fuji-multi'` | Environment selector — `fuji-multi` (testnet) or `production-multi` (mainnet). |
| `apiBaseUrl` | derived from `parentEnv` | Override the REST endpoint host. |
| `privateKey` | — | Set to enable write operations. Cleared from the config object after `Wallet` construction. |
| `cacheEnabled` | `true` | Master cache switch. |
| `cacheTtlStatic / SemiStatic / Balance / Orderbook` | 3600 / 900 / 10 / 1 (sec) | Per-tier TTLs. |
| `retryEnabled` | `true` | Retry transient failures. |
| `retryMaxAttempts / retryInitialDelay / retryMaxDelay / retryExponentialBase / retryOnStatus` | 3 / 1 / 30 / 2 / `[429, 500, 502, 503, 504]` | Exponential-backoff tuning. |
| `rateLimitEnabled` | `true` | Toggle the rate limiter. |
| `rateLimitRequestsPerSecond / rateLimitRpcPerSecond` | 5 / 10 | Per-client request-per-second budgets. |
| `nonceManagerEnabled` | `true` | Sequential nonce queue per `(chainId, address)`. |
| `providerFailoverEnabled / providerFailoverCooldown / providerFailoverMaxFailures` | `true` / 60 / 3 | Multi-provider RPC failover. |
| `wsManagerEnabled` | `false` | WebSocket manager (opt-in). |
| `wsPingInterval / wsPingTimeout` | 30 / 10 | Heartbeat tuning. |
| `wsReconnectInitialDelay / wsReconnectMaxDelay / wsReconnectExponentialBase / wsReconnectMaxAttempts` | 1 / 30 / 2 / 10 | Reconnection backoff. |
| `timeoutConnect / timeoutRead` | 5 / 30 (sec) | HTTP timeouts. |
| `erc20BalanceConcurrency` | 10 | Cap on concurrent `balanceOf` RPC calls in bulk fetches. |
| `allowInsecureRpc` | `false` | Permit plain `http://` RPC URLs (only for local dev). |
| `timestampedAuth` | `false` | Add `x-timestamp` header + `"dexalot{ts}"` signing message. |
| `logLevel / logFormat` | `'info'` / `'console'` | Structured-logger setup. |

See [Architecture](typescript-sdk-architecture.md) and [Caching Guide](sdk-caching.md) for the design intent behind each.

---

## `MemoryCache`

The TTL-LRU cache primitive used by all four tiers. Most consumers never construct one directly; the module-level singletons (`getStaticCache`/`getSemiStaticCache`/`getBalanceCache`/`getOrderbookCache`) are wired up automatically. Exposed publicly for adventurous users who want to plug their own cached helpers in alongside the SDK's.
