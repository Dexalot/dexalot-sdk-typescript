# Dexalot TypeScript SDK — Claude Code Context

TypeScript/JavaScript SDK for the Dexalot DEX. Published to NPM as
`@dexalot/dexalot-sdk`.

> **Release priority**: This repo (and `dexalot-mcp-typescript`) is
> treated as **secondary** while `dexalot-sdk-python` and
> `dexalot-mcp-python` drive production-readiness effort. Investment
> here is deliberately lighter: in-repo docs are sparse compared to
> the Python SDK, and there is no remediation-plan tracker yet.
> Parity-driven features (same API surface as the Python SDK,
> translated to TypeScript idiom) land in both repos roughly in
> lockstep; new design work should land in the Python SDK first and
> be mirrored here once stable.

---

## Architecture Decisions

### Parity-first with the Python SDK

This SDK mirrors `dexalot-sdk-python`'s module layout, feature
surface, and naming conventions. `src/core/{client,base,clob,swap,
transfer,config}.ts` maps 1:1 to the Python `core/` tree; `src/utils/`
mirrors the utilities suite (cache, retry, rateLimit, nonceManager,
providerManager, errorSanitizer, observability, inputValidators,
websocketManager, tokenNormalization, chainResolver). **When
uncertain about intended behavior, consult the Python SDK's source
and `CLAUDE.md` — design decisions are shared across the pair.**

Surface translation rules:

- Python `snake_case` → TypeScript `camelCase` on method and field
  names (`get_clob_pairs` → `getClobPairs`, `client_order_id` →
  `clientOrderId`, `tx_hash` → `txHash`).
- Python `Result[T]` → TypeScript `Result<T>`. Same `success` / `data`
  / `error` shape.
- File names use camelCase (`nonceManager.ts`, not `nonce_manager.ts`).

### Modular client via functional mixins

`DexalotClient` is composed from `CLOBClient`, `SwapClient`, and
`TransferClient` over `BaseClient` via functional mixins — **not**
Python's multiple inheritance pattern. Core files live in `src/core/`.

### Three package entrypoints

Declared in `package.json` `exports`:

- **`@dexalot/dexalot-sdk`** — default `DexalotClient`, plus
  `DexalotConfig` (type), `createConfig`, `loadConfigFromEnv`,
  `MemoryCache`, `Result`, `getLogger` / `Logger`, `version`,
  `getVersion()`.
- **`@dexalot/dexalot-sdk/secrets-vault`** — Node-only secrets vault:
  `generateSecretsVaultKey`, `secretsVaultGet`/`Set`/`List`/`Remove`.
  Uses `node:fs` / `node:crypto`; will not run in the browser.
- **`@dexalot/dexalot-sdk/internal`** — `BaseClient`, per-domain
  clients, `Utils`, types, constants for advanced consumers.

### Result<T> pattern — no exceptions

Most operational SDK methods return `Result(success, data, error)`.
Construction, validation, and a few helper / WebSocket paths can
still throw on programmer or configuration errors. Callers should
check `.success` before accessing `.data` on Result-returning
methods. Factory helpers live in `utils/result.ts`.

### 4-tier caching — module-level singletons, matches Python

| Tier | TTL | Max size | Data |
|---|---|---|---|
| Static | 1h | 128 | Environments, deployments |
| Semi-Static | 15m | 256 | Tokens, trading pairs |
| Balance | 10s | 512 | Account balances |
| Orderbook | 1s | 256 | Order book snapshots |

**Key invariants:**

- Caches are **module-level singletons** in `utils/cache.ts`
  (`_STATIC_CACHE`, `_SEMI_STATIC_CACHE`, `_BALANCE_CACHE`,
  `_ORDERBOOK_CACHE`); all client instances share them so a
  long-lived process never re-fetches the same key across instances.
  Access via `getStaticCache()` / `getSemiStaticCache()` /
  `getBalanceCache()` / `getOrderbookCache()`.
- **Cache keys are namespaced by `apiBaseUrl`** so testnet and
  mainnet clients in the same process do not collide on
  `(method, args)`. Key format:
  `keyPrefix|apiBaseUrl|JSON.stringify(args)`. The instance itself
  is **never** serialized — including `this` in the key would
  prevent GC of short-lived clients and diverge slots for the same
  logical call.
- **Stampede protection** via in-flight Promise coalescing inside
  each `MemoryCache`. Concurrent callers for the same uncached key
  see one in-flight fetch and share the result (or the same error).
- **Amortized TTL-expiry sweep** runs once per `CLEANUP_INTERVAL`
  (50) writes; size enforcement (`trim`) runs on every write. The
  previous "cleanup on every set" pattern was wasteful.
- Per-instance `_cacheEnabled = false` bypasses caching entirely
  for that instance.
- `configureCaches(config)` applies non-default TTLs in place
  (`setTtl`); the singleton identity is preserved so any references
  already held by clients continue to point at the live cache.
  `clearAllCaches()` clears all four; `resetCachesForTesting()`
  replaces the singletons with fresh instances at defaults.
- **Tests must clear caches between runs.** A
  `setupFilesAfterEnv` hook (`jest.setupAfterEnv.js`) calls
  `resetCachesForTesting()` + `clearAllCaches()` before each test;
  do not remove it without replacing the isolation mechanism.
- Use `withInstanceCache()` from `utils/cache.ts` to wrap async
  methods that should be cached. The previous `withCache()` was
  unused and removed.

### Config loading and validation

Precedence: constructor args → env vars (`loadConfigFromEnv()`) →
defaults (`createConfig()`). `validateConfig()` is called **inside
`createConfig()`** — invalid configs throw at config construction,
not at client construction. This differs slightly from Python, where
`config.validate()` runs inside `DexalotBaseClient.__init__`.

`PARENTENV` selects environment: `fuji-multi` (testnet, default) or
`production-multi-avax` / `production-multi-subnet` (mainnet).
`apiBaseUrl` auto-detects from `parentEnv` when unset; trailing
slashes are stripped.

### WebSocket uses native async, not threading

`WebsocketManager` in `utils/websocketManager.ts` uses the standard
`ws` / native WebSocket async surface; no worker threads. WebSocket
is opt-in (`wsManagerEnabled: false` by default). Callbacks run on
the same event loop and can `await` normally.

### Rate limiter: concurrent sleeps, not chained FIFO

`AsyncRateLimiter` in `utils/rateLimit.ts` maintains a `nextSlot`
wall-clock cursor. Each `acquire()` synchronously reads the cursor,
advances it by `minInterval`, then sleeps independently until its
slot opens. Multiple concurrent callers therefore sleep in parallel
rather than chaining through a single in-flight Promise — request
body preparation and response handling can overlap with previous
callers' rate-limit waits. After a quiet period the cursor is reset
to `now` so we don't issue a burst to "catch up". Default: 5 API
req/s, 10 RPC req/s. Each client instance has its own limiters;
multiple clients do not share quotas.

### Nonce manager: FIFO promise chain per (chainId, address)

`AsyncNonceManager` serializes nonce acquisitions through a
Promise-chain queue keyed by `(chainId, address)`. Each caller
reads the previous tail from the `locks` map and publishes its own
"released" Promise as the new tail synchronously (no microtask
boundary between the read and the publish), so concurrent
acquisitions for the same key never lose their place in line.
Different keys never block each other. Memory: the map only holds
the latest tail per key; older Promises are referenced only by
still-waiting closures and are GC'd as they drain. High-frequency
batching contends on the chain by design — this prevents
double-nonce errors. Per-instance, not global.

### Multi-provider RPC failover

`ProviderManager` in `utils/providerManager.ts` tracks failure counts
per provider and auto-recovers after a configurable cooldown
(default: 60s). Two-pass selection: first healthy, then any
cooldown-expired unhealthy. The selection path is synchronous and
allocation-free — `getProvider` walks the array once per call;
there are no locks or async waits. Instantiated with
`JsonRpcProvider` instances from `ethers`.

---

## Dev Workflow

- **Package manager**: `pnpm` — preferred. Both `pnpm-lock.yaml` and
  `package-lock.json` are committed; the release workflow uses
  `npm ci` from `package-lock.json`, day-to-day CI uses `pnpm
  install --frozen-lockfile`. Keep both lockfiles in sync after
  dependency changes (run `pnpm install` then `npm install`).
- **Node version**: `engines.node >= 20`. CI matrices against
  Node 20, 22, and 24; the release workflow pins Node 22.
- **TypeScript**: `5.9.3`, pinned exactly. Strict mode enabled.
- **Setup**: `pnpm install && pnpm build`.
- **Test**: `pnpm test` (all) / `pnpm test:unit` (unit, fast) /
  `pnpm test:int` (integration, requires live env). The unit suite
  enforces **100% line / branch / function / statement coverage** via
  `coverageThreshold` in `jest.config.js`; any drop fails CI.
- **Type check**: `pnpm typecheck` (= `tsc --noEmit`). The build
  config (`tsc -p tsconfig.build.json`) is what CI runs and what
  the release workflow runs pre-publish — it excludes the test
  files and produces 0 errors.
- **Coverage**: `pnpm cov` (= `jest tests/unit --coverage`).
- **Audit**: `pnpm audit:high` (= `pnpm audit --audit-level=high`).
- **Lint/format**: no ESLint or Prettier config in-repo yet. Rely
  on `tsc --strict` and editor formatting. Adding ESLint +
  Prettier with the existing style is tracked as a follow-up
  rather than rolled into this round of parity work.
- **Version**: `pnpm run version:validate` / `pnpm run version:bump:patch`
  — syncs `package.json`, `VERSION`, and `src/version.ts` via
  `scripts/version_manager.mjs`.
- **Coverage**: 100% unit coverage is the target and was achieved at
  `4bd89fe` (2026-04-03). New code should maintain it.

Unit tests in `tests/unit/` have no external dependencies. Integration
tests in `tests/integration/` require a live API environment and a
funded test wallet.

### GitHub-installable builds — do not change

TypeScript is intentionally in `dependencies` (not `devDependencies`),
and a `prepare` script runs `tsc -p tsconfig.build.json` on install.
Both choices together enable consumers to install straight from the
repo (`pnpm add github:Dexalot/dexalot-sdk-typescript`) without a
post-install build step. Moving TypeScript to `devDependencies` or
removing the `prepare` script breaks `github:` installs — **don't**.

### `.env` files

- `.env` is gitignored; use `env.example` as the template.
- `env.example` is the canonical reference for operator env vars —
  update it whenever a new `DexalotConfig` field or `DEXALOT_*`
  env var is added.
- Secrets vault env: `DEXALOT_SECRETS_VAULT_KEY` (Fernet key),
  `DEXALOT_SECRETS_VAULT_PATH` (default `~/.dexalot/secrets_vault.json`).

---

## CI Workflow

`.github/workflows/ci.yml` runs on every PR, every push to `main`, a
weekly Monday 12:00 UTC cron, and `workflow_dispatch`. The job
matrices against Node 20, 22, and 24 (fail-fast off).

**Steps, in order:**

1. **Type check** — `tsc --noEmit -p tsconfig.build.json`. The build
   config excludes test files, so this gate is clean (the loose
   editor-config `tsconfig.json` has known test-only errors that
   pre-date the parity work).
2. **Unit tests with coverage gate** — `jest --ci tests/unit`. The
   100% line/branch/function/statement threshold is enforced by
   `coverageThreshold` in `jest.config.js`; any drop fails CI.
3. **`pnpm audit --audit-level=high`** — refuse high-severity
   advisories against `pnpm-lock.yaml`.
4. **OSV scanner** — cross-checks `pnpm-lock.yaml` against the OSV
   CVE database (catches advisories that haven't propagated to npm's
   feed yet).

**Permissions:** `contents: read` only. **Concurrency:** in-progress
runs for the same ref are cancelled when a new push lands.

ESLint, Prettier, and a dedicated SAST step are intentionally **not**
in the pipeline yet; they're a follow-up rather than a parity
blocker. The Python SDK's `ruff`/`bandit` gates fill that role on
the other side.

---

## Non-Obvious Decisions

- **Package name is scoped**: `@dexalot/dexalot-sdk` on NPM, not
  bare `dexalot-sdk`. The bare name was never registered; any older
  docs showing the bare name are typos.
- **Private key in config is cleared after Wallet construction**:
  `BaseClient._setupSignerFromPrivateKey()` constructs the ethers
  `Wallet` inside a `try/finally` and unconditionally sets
  `config.privateKey = undefined` afterward — in both the success
  and the throwing branches. Pre-built-signer constructor branch
  never reads `config.privateKey`, so it is left untouched. Do not
  reintroduce `new Wallet(this.config.privateKey)` directly in the
  constructor — always route through the helper.
- **HTTP method allowlist on `_apiCall`**: the parameter is typed as
  `'get' | 'post' | 'put' | 'delete'`, but `_apiCall` *also* runtime-
  checks `method.toLowerCase()` against a module-level Set before
  any axios call. Defense in depth against `as any` bypasses and
  the type-erased `axios.request({ method })` shape. Case-insensitive.
- **RPC dispatch must stay closure-typed, not string-based**: RPC
  calls go through `withRpcFailover(chain, p => p.method())`. The
  provider is a `JsonRpcProvider` with a typed surface and there is
  no `provider[methodName]()` dispatch. Future RPC code MUST follow
  this closure pattern — do NOT introduce dynamic property access
  on the provider; doing so would re-open the door to a string-name
  attack surface that the typed closure inherently prevents.
- **ERC20 allowance revoke on tx failure**: when `_ensureAllowance`
  grants `MaxUint256` and the subsequent `depositToken` /
  `withdrawToken` then reverts (rejected promise OR `receipt.status
  !== 1`), the deposit/withdraw paths call `_revokeAllowance` as a
  best-effort cleanup. The secondary revoke is itself wrapped in a
  try/catch so a revoke failure never overrides the original tx
  error — the original error wins. Logged at `debug` via the
  observability logger.
- **Cache key generation**: `${keyPrefix}|${apiBaseUrl}|${JSON.stringify(args)}`.
  The instance is **never** in the key — `withInstanceCache` takes
  the instance separately, reads `apiBaseUrl` and `_cacheEnabled`
  off it, and serializes ONLY the method args. Object-arg stability
  (key ordering, prototype inclusion) depends on `JSON.stringify`,
  so avoid non-trivial class instances as cache arguments — prefer
  primitives or plain objects.
- **Caches are module-level singletons, shared across clients**:
  long-lived processes amortize fetches across instances; cache
  keys are env-namespaced by `apiBaseUrl` so testnet and mainnet
  clients do not collide. Test suites use a global
  `resetCachesForTesting()` + `clearAllCaches()` hook before each
  test to avoid cross-test contamination.
- **Stampede protection** is built into `withInstanceCache`:
  concurrent callers for the same uncached key share a single
  in-flight Promise; the wrapped function runs once per key per
  fetch window.
- **Rate limiter advances a wall-clock cursor synchronously**:
  concurrent acquires reserve distinct slots before any of them
  sleep, so callers' sleeps run in parallel and request preparation
  / response handling can overlap with previous callers' waits.
  Total wall-clock for N concurrent calls at R rps is
  `(N - 1) / R` seconds (same as chained-FIFO), but the CPU is
  free between caller wake-ups.
- **`AsyncNonceManager` uses a Promise-chain queue per key**: the
  read-from-tail / publish-new-tail sequence is synchronous — no
  microtask boundary between them — so the previous "two waiters
  overwrite each other's resolver" race cannot fire. The `locks`
  map only holds the latest tail per key; older Promises drop out
  of reach as their waiters drain.
- **Provider failover has no fast path**: every `getProvider` call
  walks the health list. At typical provider counts (1–3 per chain)
  this is fine; at higher counts consider caching the first-healthy
  index.
- **Config validation timing**: runs inside `createConfig`, not
  inside client construction. Invalid configs throw at
  `createConfig()` or `loadConfigFromEnv()`, before the client exists.
- **ERC20 balance concurrency**: `erc20BalanceConcurrency` (default 10)
  caps concurrent `balanceOf` RPC calls in bulk fetches, same as Python.
- **RPC security enforcement**: plain `http://` RPC URLs are rejected
  at provider setup time unless `allowInsecureRpc: true`. Fail-fast
  before any traffic is sent over plaintext. Same as Python.
- **`timestampedAuth` flag**: supports timestamped signing
  (`dexalot{ts}` + `x-timestamp` header) via `timestampedAuth: true`
  (env: `DEXALOT_TIMESTAMPED_AUTH=true`). Defaults to `false` — the
  backend currently only accepts the static `"dexalot"` message.
  Enable only after backend confirms timestamp window validation
  (see Python SDK remediation plan item C-2).
- **Canonical order shape aligned across sources**: contract-path
  reads and REST-API reads both produce the same canonical order
  object with camelCase fields (`internalOrderId`, `clientOrderId`,
  `tradePairId`, `pair`, `price`, `totalAmount`, `quantity`,
  `quantityFilled`, `totalFee`, `traderAddress`, `side`, `type1`,
  `type2`, `status`, `updateBlock`, `createBlock`, `createTs`,
  `updateTs`). Enum-style fields (`side`, `type1`, `type2`, `status`)
  are human-readable strings. Block fields are integers, not hex
  strings. Raw API aliases (`id`, `clientordid`, `tx`,
  `traderaddress`) are normalized away. Landed same day as the
  Python equivalent (`261a965`, 2026-04-03).
- **Null-safe block-field coercion**: order handling tolerates
  nullable block fields in API responses and safely coerces to
  integers (2026-04-05, `8da19d2`). Don't re-introduce strict
  coercion — the REST API does emit nulls.
- **Secrets vault is Node-only**: the `/secrets-vault` subpath uses
  `node:fs` and `node:crypto`, so it will **not** run in a browser
  build. Storage format is Fernet-encrypted JSON at
  `~/.dexalot/secrets_vault.json`, **matching the Python SDK's
  vault format** so both toolchains can read the same file.
- **Error sanitization is lossy**: regex stripping of file paths,
  URLs, and stack traces makes production debugging harder. Use
  `logLevel: 'debug'` locally to get full context.
- **Decimal arithmetic uses Big.js, never float multiplication**:
  human-readable amounts route through `toWei(value, decimals)` from
  `src/utils/decimal.ts`, which evaluates
  `BigInt(new Big(String(value)).times(new Big(10).pow(decimals)).toFixed(0, Big.roundDown))`.
  Float multiplication like `BigInt(Math.floor(2933.0 * 10**18))`
  silently drops 262144 wei and the contract rejects the order with
  `T-TMDQ-01`. Big.js is pinned to an exact version; do not widen the
  range. `Big` is re-exported from `src/utils` so callers can import
  it without depending on the dep path directly.
- **All four CLOB write paths route through `_normalizeOrderAmounts`**:
  `addOrder`, `addOrderList`, `replaceOrder`, and `cancelAddList`
  share a single normalization helper that runs the display-decimal
  REJECT-with-tolerance gate (`checkDisplayPrecision`) on price and
  amount, then the quote-token notional bounds check
  (`checkTradeAmountBounds`) against the pair's `min_trade_amount`
  / `max_trade_amount`. After normalization, encoding to wei uses
  `toWei(value, decimals)`. Do not reintroduce
  `parseFloat(value.toFixed(N))` rounding in any write path — that is
  silent slippage (a stop at 99.99 silently becoming 99.9).
- **Public market-data endpoints live under `/api/`, not `/privapi/`**:
  most SDK calls hit `/privapi/...`, but `getCandles` and
  `getMarketSnapshot` (and therefore `get24hStats`) hit
  `/api/trading/candle-chunk` and `/api/stats/market-snapshot`
  because those routes are only mounted on the public `/api/` tree
  on the backend. Same host, different prefix — see
  `ENDPOINTS.TRADING_CANDLE_CHUNK` and `ENDPOINTS.STATS_MARKET_SNAPSHOT`
  in `constants.ts`. Do not move them to the `privapi` prefix.
- **`getChainTokenBalances` cache key is order-insensitive**: the
  public method coerces `tokens: string[]` into a sorted deduped
  array via `Array.from(new Set(tokens.map(normalizeToken))).sort()`
  before delegating to the cached internal, so `['AVAX', 'USDC']`
  and `['USDC', 'AVAX']` share a cache slot. Token symbols are also
  canonicalized through `normalizeToken` so casing variants and
  known aliases collapse.
- **RFQ firm quotes arrive as `{success, quote: {...}}` envelopes**:
  the backend wraps the executable quote in an outer envelope and
  also uses `{success: false, reason: ...}` to signal soft failures
  on HTTP 200. `_transformQuoteFromAPI` unwraps the envelope on the
  inner shape; `getSwapQuote` detects envelope-layer failure BEFORE
  the transform and returns `Result.fail(\`Cannot execute failed
  quote: ${reason}\`)` so executeRFQSwap never operates on a
  failure payload. Callers that hand a raw envelope to
  `executeRFQSwap` are also fine — the same unwrap runs there.
- **There is no `secureQuote` layer in real firm-quote responses**:
  the executable signature and order live at the top level of the
  inner quote dict (`quote.signature`, `quote.order`). The
  `SwapQuote.secureQuote` field was removed in a clean break — any
  code that read `secureQuote.data` / `secureQuote.order` is wrong
  and must be ported to read `quote.signature` / `quote.order`.
- **MainnetRFQ requires `msg.value == takerAmount` for native sells**:
  when `order.takerAsset` is the zero address (case-insensitive),
  the SDK sends `msg.value = takerAmount`; for ERC20 takers it
  sends `msg.value = 0`. `_computeMsgValue` is the single source
  of truth and is also passed to `simpleSwap.estimateGas` so the
  estimator sees the same call shape the contract validates.
  Calling `simpleSwap` without this hardware would revert with
  `_checkValue` on any native sell.
- **Failed-swap errors carry tx hash, block number, and revert reason**:
  on `receipt.status !== 1` the error string is
  `\`Transaction reverted: tx=0x..., block=N, reason=<reason>\``
  with the `block=` and `reason=` segments conditionally appended
  when each piece is available. The reason is recovered via
  `_extractRevertReason`, which replays the tx as `eth_call` at the
  reverting block and parses the node's `execution reverted: X`
  message. Best-effort: returns `null` if the node can't replay.
- **`rfq_pairs` fetch failures are logged at debug, not warn**:
  chains without an RFQ deployment legitimately return 404 here, so
  warning on every initialize would be noise. `_fetchRfqPairsForChain`
  catches all failures and logs them at `debug`.
- **All TRANSFER write paths route through `toWei`**: `deposit`,
  `withdraw`, `transferPortfolio`, `addGas`, `removeGas`, and
  `getDepositBridgeFee` all encode their user-supplied amount via
  `toWei(amount, decimals)` from `src/utils/decimal.ts`. The previous
  `BigInt(Utils.unitConversion(amount, dec, true))` pattern was
  removed in favor of the direct helper. `Utils.unitConversion` is
  still used for the read-side (`formatUnits`-backed) display
  conversion, which is already precision-safe via ethers internally.
  Do not reintroduce `BigInt(Math.floor(amount * 10**N))` anywhere —
  that pattern silently drops 262144 wei at `2933.0 * 10**18`.
- **Display-decimal precision uses REJECT-with-tolerance**: a `1e-10`
  tolerance band absorbs binary-float-representation noise (e.g.
  `0.1 + 0.2 = 0.30000000000000004` snaps to `0.3` at 1 display
  decimal). Genuine over-precision is rejected with a clear error
  message — callers must round explicitly. The constant is exported
  as `DISPLAY_PRECISION_TOLERANCE`.
- **Pairs without display decimals are dropped at ingest**: the
  `getClobPairs` loop excludes any pair whose API record lacks
  `base_display_decimals` or `quote_display_decimals` and logs a
  WARNING via the observability logger. Downstream callers see "pair
  not found". `0` is a valid display-decimals value — the check uses
  `== null` to admit it. Display decimals are contractual; defaulting
  them masks the contract's `T-TMDQ-01` rejection downstream. The
  `Pair` type reflects this — `base_display_decimals` and
  `quote_display_decimals` are required, not optional.
- **`min_trade_amount` / `max_trade_amount` are enforced client-side**:
  quote-token-denominated bounds checked by `checkTradeAmountBounds`
  inside `_normalizeOrderAmounts`. A bound of `0` means "no bound"
  (some pairs legitimately omit). When `price` is `null` (market
  order with `addOrderList`), the bounds check is skipped — there is
  no client-side notional to compute.
- **`validatePositiveNumber` accepts more than `number`**: signature
  is `(value: unknown, paramName: string)` and accepts `number`,
  numeric `string`, `bigint`, and `Big` instances. Booleans are
  rejected explicitly so `true`/`false` cannot slip through as
  `amount=1`/`amount=0`. The previous name `validatePositiveFloat`
  has been removed in a clean break — no alias kept — so future
  imports must use `validatePositiveNumber`.

---

## Release Workflow

Releases are **tag-driven**. Pushing a `v*` tag to `main` triggers
`.github/workflows/npm.yml`, which publishes to NPM via trusted
publishing (OIDC, `id-token: write`) with `--provenance` supply-chain
attestation.

**Gates, all enforced by the workflow:**

1. `github.ref_type` must be `tag` (not branch).
2. `git merge-base --is-ancestor $GITHUB_SHA origin/main` — the
   tagged commit must be reachable from `origin/main`. This
   prevents publish from dangling commits on throwaway branches
   (stricter than the Python SDK's equivalent workflow, and added
   after the 2026-04-06 iteration uncovered the need).
3. Tag name must equal `v{package.json version}`.
4. `npm audit --audit-level=high` — refuse to publish a tag that
   would introduce known high-severity advisories.
5. OSV scanner against `package-lock.json` — cross-checks the npm
   advisory feed.
6. `tsc --noEmit -p tsconfig.build.json` — strict typecheck on the
   build set (test files excluded).
7. `jest --ci tests/unit` — 100% coverage gate (enforced by
   `coverageThreshold` in `jest.config.js`).

Steps:

1. `pnpm run version:bump:patch` — syncs `package.json`, `VERSION`,
   `src/version.ts`.
2. Commit, PR, merge to `main`.
3. From `main`: `git tag -a v<new-version> -m "Release v<new-version>"
   && git push origin v<new-version>`.
4. Watch the **Publish to NPM** workflow; on green, verify at
   <https://npmjs.com/package/@dexalot/dexalot-sdk>.

**Version-number quirks:**

- The package opens at `v0.5.7`, not `v0.1.0`, for parity with the
  Python SDK that had already reached that line.
- Released versions `v0.5.15` through `v0.5.17` are the real NPM
  history.
- During the 2026-04-06 workflow iteration, two orphan tags
  (`v0.5.18`, `v0.5.19`) were created locally but never pushed to
  origin; they have since been deleted locally. Those numbers were
  never published to NPM and should not be reused to avoid operator
  confusion. Next release after `v0.5.17` should start at `v0.5.20`
  or later.
- Once a version is published to NPM, it cannot be re-uploaded under
  the same number; `npm deprecate` is the available remediation.

---

## Key File Reference

All paths relative to `src/`.

| Component | Path |
|---|---|
| Entry point | `core/client.ts` |
| Config | `core/config.ts` |
| Base client | `core/base.ts` |
| CLOB client | `core/clob.ts` |
| Swap client | `core/swap.ts` |
| Transfer client | `core/transfer.ts` |
| Caching | `utils/cache.ts` |
| Result type | `utils/result.ts` |
| Retry | `utils/retry.ts` |
| Rate limiting | `utils/rateLimit.ts` |
| Nonce manager | `utils/nonceManager.ts` |
| Provider failover | `utils/providerManager.ts` |
| WebSocket | `utils/websocketManager.ts` |
| Error sanitizer | `utils/errorSanitizer.ts` |
| Observability | `utils/observability.ts` |
| Input validation | `utils/inputValidators.ts` |
| Token/pair normalization | `utils/tokenNormalization.ts`, `data/tokenAliases.json` |
| Chain resolver | `utils/chainResolver.ts`, `data/chainAliases.json` |
| Secrets vault | `utils/secretsVault.ts` (impl), `secrets-vault.ts` (public entrypoint) |
| ABIs | `abis/abi_{TradePairs,Portfolio,MainnetRFQ}.json` |
| Main entrypoint | `index.ts` |
| Internal entrypoint | `internal.ts` |
| Decimal helpers | `utils/decimal.ts` (`toWei`, `fromWei`, `Big`, precision gates) |
| Version | `version.ts` (synced by `scripts/version_manager.mjs`) |
| Examples | `examples/*.ts` — runnable via `pnpm exec tsx examples/<name>.ts`; type-checked in CI via `tsconfig.examples.json` |
| Docs | `docs/*.md` — user guide, API reference, architecture, error handling, caching, websocket, simple-swap, REST API |

---

## Gaps and TODOs

The parity port from `dexalot-sdk-python` v0.5.15 is complete as of
this commit. All ten parity PRs have landed (security hardening,
decimal foundation, CLOB precision, transfer precision, market-data
helpers, swap functional fixes, cache hygiene, perf round-up, CI /
release gates, docs and examples). What remains is incremental:

- **ESLint / Prettier config** — the Python SDK has `ruff` for
  lint+format; we rely on `tsc --strict` and editor formatting.
  Adding ESLint with a permissive baseline (e.g. `@typescript-eslint/
  recommended` + `prettier`) is a candidate follow-up that would
  churn existing files; doing it as a focused PR with the relevant
  config + autofix is the cleanest path.
- **SAST step in CI** — `pnpm audit` and OSV are wired up for CVE
  coverage; a SAST sweep (`eslint-plugin-security` or `semgrep ci`)
  would catch class-of-error issues earlier.
- **Browser bundle** — the `internal` subpath is browser-safe by
  construction (no `node:*` imports outside `/secrets-vault`), but
  no published artifact is bundled for the browser yet. A separate
  `@dexalot/dexalot-sdk-browser` build would be additive.

Items that previously trailed the Python SDK and are now at parity
(no longer gaps):

- Module-level cache singletons with stampede protection and
  `apiBaseUrl` key namespacing (PR 7).
- Rate limiter with independent concurrent sleeps (PR 8).
- ProviderManager lock-free reads — verified (PR 8).
- AsyncNonceManager FIFO Promise-chain queue per `(chainId, address)`
  (PR 8).
- Decimal-safe `_formatOrderData` via `fromWei` (PR 8).
- `getCandles`, `getMarketSnapshot`, `get24hStats`,
  `getChainTokenBalances` (PR 5).
- Functional RFQ execution — envelope unwrap, `msg.value` for native
  sells, revert-reason surfacing (PR 6).
- CI workflow with 100% coverage gate, `pnpm audit`, OSV scan; release
  workflow with pre-publish audit + provenance + ancestor-of-main
  check (PR 9).
- Full docs and runnable examples ports (this PR).
