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

### 4-tier caching — per-instance, simpler than Python's

| Tier | TTL | Data |
|---|---|---|
| Static | 1h | Environments, deployments |
| Semi-Static | 15m | Tokens, trading pairs |
| Balance | 10s | Account balances |
| Orderbook | 1s | Order book snapshots |

**Divergences from the Python SDK worth knowing:**

- Caches are **per-instance** (constructed as fields on the client),
  not module-level singletons. Two `DexalotClient` instances do not
  share cache state. Tests don't have the cross-test contamination
  problem Python's module-level caches have.
- **No stampede protection.** Concurrent uncached reads for the same
  key each fire their own underlying call. The Python SDK's
  `async_ttl_cached` coalesces via `asyncio.Future`; we don't have
  an equivalent. If stampede prevention matters in a consumer's
  hot path, that needs adding.
- **No `apiBaseUrl` key namespacing.** Python keys caches by
  `api_base_url` so testnet/mainnet can share process space safely.
  We don't — so don't run multiple clients at different
  `parentEnv`s from the same process unless you disable caching on
  at least one.
- Cache cleanup runs on every `set` (not amortized every 50 writes
  like Python's). For small caches this is fine; if hot paths
  dominate, the cleanup cost is noticeable.
- Per-instance `_cacheEnabled` flag bypasses caching entirely.
- Use `withCache()` or `withInstanceCache()` from `utils/cache.ts`
  to wrap async methods that should be cached.

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

### Rate limiter serializes calls (FIFO), not a parallel token bucket

`AsyncRateLimiter` in `utils/rateLimit.ts` chains calls through a
`pending` promise to enforce strict FIFO ordering and the minimum
inter-call interval. **This differs from the Python SDK's token
bucket**, which allows multiple waiters to sleep concurrently. In
practice: burst behavior is more uniformly spaced here; raw
throughput for concurrent callers is lower. Default: 5 API req/s,
10 RPC req/s. Each client instance has its own limiters; multiple
clients do not share quotas.

### Nonce manager: correctness over throughput

`AsyncNonceManager` uses per-`(chainId, address)` promise-based
locks to enforce sequential nonce acquisition, matching the Python
SDK's correctness-first model. High-frequency batching contends on
these locks by design — this is intentional to prevent double-nonce
errors. Locks are per-instance, not global.

### Multi-provider RPC failover

`ProviderManager` in `utils/providerManager.ts` tracks failure counts
per provider and auto-recovers after a configurable cooldown
(default: 60s). Two-pass selection: first healthy, then any
cooldown-expired unhealthy. **No lock-free fast path** like the
Python version — but the model is synchronous and contention is not
a concern for this style.

Instantiated with `JsonRpcProvider` instances from `ethers`.

---

## Dev Workflow

- **Package manager**: `pnpm` — preferred. `npm ci` is what CI runs,
  `yarn` also works but is not tested.
- **Node version**: 22 (CI runner pin). Older Node versions may work
  locally but are not validated.
- **TypeScript**: `5.9.3`, pinned exactly. Strict mode enabled.
- **Setup**: `pnpm install && pnpm build`.
- **Test**: `pnpm test` (all) / `pnpm test:unit` (unit, fast) /
  `pnpm test:int` (integration, requires live env).
- **Build**: `pnpm build` (= `tsc -p tsconfig.build.json` →
  `dist/`). `tsconfig.build.json` excludes tests; `tsconfig.json` is
  the editor config.
- **Types**: `tsc` via the build is the type check. No `mypy`
  equivalent is needed — strict TypeScript covers it.
- **Lint/format**: no ESLint or Prettier config in-repo. Rely on
  `tsc --strict` and editor formatting. (This is a real gap vs the
  Python SDK's `ruff`; adding ESLint later is a candidate.)
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

## Non-Obvious Decisions

- **Package name is scoped**: `@dexalot/dexalot-sdk` on NPM, not
  bare `dexalot-sdk`. The bare name was never registered; any older
  docs showing the bare name are typos.
- **Private key in config**: `privateKey` is passed at config time
  and read when constructing the ethers signer; the config field is
  not zeroed afterward (unlike Python's `Account` flow). Passing a
  pre-built signer via the advanced path is the tighter option.
- **Cache key generation**: `${keyPrefix}:${JSON.stringify(args)}`.
  **`this` is captured as `args[0]` when methods go through
  `withCache`**, but `withInstanceCache` takes the instance
  separately. Object-arg stability (key ordering, prototype
  inclusion) depends on `JSON.stringify`, so avoid non-trivial
  class instances as cache arguments — prefer primitives or plain
  objects.
- **Cache is per-client, not shared**: no cross-client coordination.
  If a consumer creates many short-lived clients they get no cache
  benefit; recommend a single long-lived client.
- **No stampede protection** (see §Caching above). If adding: port
  the Python SDK's `async_ttl_cached` Future-coalescing pattern,
  implemented with `Promise` here.
- **Rate limiter FIFO vs token bucket**: documented above. Concurrent
  callers serialize; burst tolerance is low.
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
| Version | `version.ts` (synced by `scripts/version_manager.mjs`) |

---

## Gaps and TODOs

Known gaps where this repo trails the Python SDK. None are urgent;
all tracked informally.

- No remediation-plan doc tracking open security/perf items. Most
  Python remediation fixes landed in the TS SDK's initial release by
  design, but the lineage is not documented anywhere in-repo.
- `docs/` directory exists but is empty. Python SDK ships a full
  Zensical docs site (architecture, user guide, error handling,
  websocket, caching, simple-swap, rest-api, reference, remediation
  plan). Decide: mirror in TS, or keep the authoritative site on the
  Python side and point TS users there.
- No ESLint / Prettier config. Rely on `tsc --strict` and editor
  formatting for now.
- No cache stampede protection (Python has `async_ttl_cached`
  Future-coalescing).
- No `apiBaseUrl` cache-key namespacing (Python has it). Don't run
  multi-env clients in the same process without disabling caching.
- Rate limiter is FIFO-serialized, not a parallel token bucket
  (documented above). Consider porting Python's token bucket if
  concurrency becomes a real constraint.
- Provider failover has no lock-free fast path (Python's
  `ProviderManager` has one). Not a concern at current provider
  counts.
