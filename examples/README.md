# Dexalot SDK Examples

Nine runnable scripts that mirror the Python SDK's [`examples/`](https://github.com/Dexalot/dexalot-sdk-python/tree/main/examples)
catalog. Each is self-contained — no shared helper module — and is
documented at the top with what it demonstrates.

## Running an example

```bash
# One-time setup
pnpm install
cp .env.example .env
$EDITOR .env   # fill in PRIVATE_KEY (optional) and any other overrides

# Run any example
pnpm exec tsx examples/async-basic.ts
pnpm exec tsx examples/configuration-advanced.ts
# ...
```

The `tsx` executor type-strips on the fly — no separate build step is
needed for the example scripts. The same files are also type-checked
in CI via `tsconfig.examples.json`, so the SDK API surface and the
example call-sites stay in sync.

## Catalog

| Script | LOC | What it demonstrates |
|---|---|---|
| [`async-basic.ts`](./async-basic.ts) | 158 | Client construction, the `Result<T>` pattern, and the simplest read operations (`getTokens`, `getClobPairs`, `getOrderBook`, `getAllPortfolioBalances`). |
| [`async-parallel.ts`](./async-parallel.ts) | 175 | Concurrent reads via `Promise.all` and `Promise.allSettled`; sequential-vs-parallel timing comparison; mixed-operation fan-out. |
| [`caching-demo.ts`](./caching-demo.ts) | 235 | All four cache tiers, custom TTLs, `invalidateCache`, the `cacheEnabled: false` bypass, the stampede-protection coalesce. |
| [`configuration-advanced.ts`](./configuration-advanced.ts) | 247 | Every knob of `DexalotConfig` — retry, rate limiting, provider failover, WebSocket tuning, timeouts; the env-variable surface and precedence rules. |
| [`error-handling.ts`](./error-handling.ts) | 222 | Validation errors, network errors, `Result.fail` patterns, manual retry, and converting SDK errors into user-friendly messages. |
| [`logging-console.ts`](./logging-console.ts) | 36 | Console-format logging at INFO level for local development. |
| [`logging-json.ts`](./logging-json.ts) | 41 | JSON-line logging for production (pipe through `jq` to pretty-print). |
| [`logging-request-id.ts`](./logging-request-id.ts) | 71 | `withRequestId` scoping — every log line inside the callback carries the same `requestId` field for distributed tracing. |
| [`websocket-manager.ts`](./websocket-manager.ts) | 322 | Persistent subscriptions, multi-topic fan-out, private (authenticated) subscriptions, automatic reconnection, heartbeat monitoring, proper cleanup. |

## What you need before running

- **Read-only examples** (`async-basic`, `async-parallel`,
  `caching-demo`, `configuration-advanced`, `error-handling`,
  `logging-*`, market-data sections of `websocket-manager`) work
  without any wallet. The default `parentEnv` is `fuji-multi` (Fuji
  testnet), so you can run them against a public testnet endpoint.
- **Write or balance examples** (`async-basic`'s balance section,
  `error-handling`'s order paths, `websocket-manager`'s private
  subscription) need `PRIVATE_KEY` set in `.env`. The examples skip
  these sections with a clear message when no signer is configured.

## Running against mainnet

Set `PARENTENV=production-multi` in your `.env` (or export it before
running). The same scripts run unchanged against either environment;
the SDK's module-level caches are keyed by `apiBaseUrl` so testnet
and mainnet data never collide if you run both in the same process.
