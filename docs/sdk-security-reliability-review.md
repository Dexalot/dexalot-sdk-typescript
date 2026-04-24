# SDK Security and Reliability Review (TypeScript)

This document describes the security and reliability features implemented in
the Dexalot TypeScript SDK. The SDK covers seven key areas: input
validation, error message sanitization, nonce management, observability,
provider management, rate limiting, and retry mechanisms.

**Related documentation:**
- [SDK Caching Guide](sdk-caching.md) — cache layer configuration
- Consumer docs in the Dexalot AI apps (`chatkit-backend`) and MCP servers
  cover how these features are surfaced to end users.

---

## 1. Input Validation

**Implementation:** [`src/utils/inputValidators.ts`](../src/utils/inputValidators.ts)

Validators are synchronous functions that return `Result<null>` so the
SDK's error-handling pattern stays consistent. Pre-compiled regex patterns
are defined at module level for performance.

**Validators:**
- `validatePositiveFloat(value, fieldName?)` — positive, finite, not NaN
- `validatePositiveInt(value, fieldName?)` — positive integer
- `validateNonNegativeFloat(value, fieldName?)` — `>= 0`, finite
- `validateAddress(address, fieldName?)` — `0x` + 40 hex characters
- `validatePairFormat(pair)` — `BASE/QUOTE`, uppercase alphanumerics
- `validateOrderIdFormat(orderId)` — hex string, decimal, UTF-8, or bytes32
- `validateTokenSymbol(symbol)` — 1–10 uppercase alphanumeric characters
- `validateChainIdentifier(identifier)` — int `> 0` or non-empty string name
- `validateOrderParams({ pair, amount, price?, orderType })` — composed
  check for order placement; price required for `LIMIT`
- `validateTransferParams({ token, amount, toAddress })` — composed
  check for deposits/withdrawals
- `validateSwapParams({ fromToken, toToken, amount })` — composed check
  for swap; rejects same-token swaps

**Intended usage:** public methods call a validator first and short-circuit
with `Result.fail(...)` if it returns an error. For example,
`CLOBMixin.addOrder()` calls `validateOrderParams` before constructing
a transaction.

**Configuration:** none. Validators are stateless.

**Notable design choices:**
- Token symbol validation is strict (uppercase only, max 10 characters).
  This is intentionally tighter than some back-end validation — if the
  Dexalot token list introduces a symbol that violates this, update the
  validator to match.
- Order IDs are permissive: string-typed client IDs are accepted as-is if
  they don't look like hex; hex-prefixed IDs are format-checked.

---

## 2. Error Message Sanitization

**Implementation:** [`src/utils/errorSanitizer.ts`](../src/utils/errorSanitizer.ts)

Prevents sensitive information from leaking into user-facing error
messages.

**Exports:**
- `sanitizeErrorMessage(message)` — main sanitization. Removes:
  - Unix and Windows file paths
  - URLs (http/https/ws/wss)
  - Stack trace lines (`at function (file:line:col)`)
  - IP addresses
  - Private keys (64-hex sequences) and common API-key patterns
  - Email addresses
  - Error codes mapped to user-friendly messages
    (`ECONNREFUSED` → `"Connection refused"`, `ETIMEDOUT` → `"Connection timed out"`, etc.)
- `extractUserMessage(message)` — more aggressive sanitization used when
  returning errors directly to an LLM or end user. Trims to first
  sentence, strips technical prefixes.
- `createSafeError(original)` — returns a new `Error` with sanitized
  message while preserving the original error class.

**Intended usage:**
- `BaseClient._sanitizeError()` calls these internally. Full error
  details (including stack traces) are logged; only the sanitized message
  is returned to callers.
- `SwapMixin.getSwapQuote()` and other user-facing methods sanitize caught
  exceptions before surfacing them.

**Configuration:** none. Patterns are hardcoded for security — the
point is that they can't be turned off.

---

## 3. Nonce Management

**Implementation:** [`src/utils/nonceManager.ts`](../src/utils/nonceManager.ts) —
class `AsyncNonceManager`.

Prevents transaction race conditions when the same address submits
multiple transactions concurrently across different code paths.

**Key features:**
- Per-`(chainId, address)` tracking with Promise-based locking
  (JavaScript is single-threaded, but multiple in-flight async calls can
  still interleave; the Promise-chain lock enforces FIFO ordering).
- Lazy initialization: first call fetches the current nonce from chain
  with the `'pending'` block parameter.
- Automatic incrementing: each `getNonce()` call returns the current
  cached value and then increments.
- Keyed by `"${chainId}:${address.toLowerCase()}"` for case-insensitive
  address matching.

**Methods:**
- `getNonce(provider, address, chainId?)` — primary interface
- `resetNonce(...)` — fetch a fresh nonce from chain
- `clearNonce(...)` — drop cached nonce; next `getNonce` will fetch
- `clearAll()` — drop all cached nonces
- `getCachedNonce(...)` — debug helper to inspect current cached value
  without fetching

**Intended usage:** `BaseClient` uses the nonce manager automatically
before building signed transactions. Integrated with ethers.js providers
via `provider.getTransactionCount(address, 'pending')`.

**Configuration:** none — nonce management is always on. If external
nonce coordination is ever needed (e.g. an external service), the
application can call `clearNonce` before each transaction to force a
chain-read, but there's no config switch to disable the manager.

---

## 4. Observability

**Implementation:** [`src/utils/observability.ts`](../src/utils/observability.ts)

Structured logging with request-ID propagation for distributed tracing.

**Logging configuration:**
- `configureLogging(level, format)` — `level` is `"debug" | "info" | "warn" | "error"`;
  `format` is `"console" | "json"`. No environment-variable driver — set
  programmatically at startup (typically from your application's log
  config).

**Request-ID tracking:**
- Uses `AsyncLocalStorage` when available (Node.js 12.17+); falls back
  gracefully in browsers or older Node.
- `setRequestId(id)`, `getRequestId()`, `withRequestId(id, fn)` —
  propagate an ID across the async call stack so all log lines emitted
  during a single inbound request share the same identifier.

**Operation tracking:**
- `trackOperation(name, fn, context?)` wraps an async function with
  automatic start/completion/error logging. Duration is measured in
  milliseconds.
- Emits log entries at `info` for start and completion, `error` for
  failure (including the error message after sanitization).

**Method decorator:**
- `@trackMethod(component)` applies the same treatment to class methods.
  Requires `experimentalDecorators: true` in `tsconfig.json`. Use
  sparingly — the decorator is considered experimental and may change
  when ES decorators become stable.

**Log formats:**
- **JSON:** `{ timestamp, level, logger, message, requestId, context }`
- **Console:** `{timestamp} {level} [{logger}] ({requestId}) {message} {context}`

**Intended usage:**
- Call `configureLogging()` once during client setup.
- Wrap inbound request handlers with `withRequestId()` so every SDK log
  line inherits the ID.
- Use `trackOperation()` for long-running methods where duration is
  interesting for performance analysis.

---

## 5. Provider Management

**Implementation:** [`src/utils/providerManager.ts`](../src/utils/providerManager.ts) —
class `ProviderManager`.

Manages multiple ethers.js providers per chain with health tracking and
automatic failover.

**Configuration (`ProviderManagerConfig`):**
- `failoverCooldown` — milliseconds before retrying a failed provider
  (default: `60000` = 60 seconds)
- `maxFailures` — consecutive failures before marking unhealthy
  (default: `3`)

**Methods:**
- `addProviders(chainName, rpcUrls)` — register multiple providers for
  a chain
- `getProvider(chainName)` — returns the first healthy provider;
  retries unhealthy providers only after `failoverCooldown` elapses
- `markFailure(chainName, provider)` — increment failure count; mark
  unhealthy if threshold reached
- `markSuccess(chainName, provider)` — reset failure count
- `getProviderIndex(chainName, provider)` — find a provider's index
- `getProviderCount(chainName)` — total registered for a chain
- `getHealthStatus(chainName)` — debug helper: per-provider health info
- `resetChain(chainName)` — mark all providers for a chain as healthy
  (manual recovery)
- `getChainNames()` — list all registered chains

**Health tracking (`ProviderHealth`):**
- `failureCount` — consecutive failures
- `lastFailure` — timestamp of the last failure (ms since epoch)
- `isHealthy` — boolean, updated by `markFailure`/`markSuccess`

**Intended usage:**
- Instantiated in `BaseClient` with config at construction time.
- `addProviders()` called during environment fetching (once RPC URLs
  are known).
- `getProvider()` returned the active provider for each RPC call;
  `markFailure` / `markSuccess` are called after each call based on
  the result.

**Strategy:** fail-fast with cooldown recovery. On failure, the next
call automatically rotates to the next healthy provider. Unhealthy
providers become eligible again after `failoverCooldown`.

---

## 6. Rate Limiting

**Implementation:** [`src/utils/rateLimit.ts`](../src/utils/rateLimit.ts) —
class `AsyncRateLimiter`.

Token-bucket rate limiter ensuring operations are spaced by a minimum
interval, enforced with FIFO ordering across concurrent callers.

**Configuration (via `DexalotConfig`):**
- `rateLimitRequestsPerSecond` — for API requests (default: `5`)
- `rateLimitRpcPerSecond` — for RPC calls (default: `10`)

Separate limiters are used for HTTP and on-chain RPC traffic.

**Methods:**
- `acquire()` — returns after enough time has passed since the last
  `acquire()` call to satisfy the rate. Concurrent callers queue in
  FIFO order via Promise chaining.
- `reset()` — reset the limiter state (primarily for tests)
- `getMinInterval()` — returns the minimum spacing in milliseconds
  (= `1000 / callsPerSecond`)

**Helper:**
- `withRateLimit(fn, limiter)` — wraps an async function so every
  invocation calls `acquire()` before running.

**Intended usage:**
- HTTP limiter: `acquire()` called in `_apiCall()` before any fetch.
- RPC limiter: same, before each ethers.js call.
- Both are automatic — no application-level code needed.

**Algorithm:** simple token bucket. Current implementation tracks the
last-acquired timestamp and delays new acquisitions to maintain
`minInterval` spacing.

---

## 7. Retry Mechanism

**Implementation:** [`src/utils/retry.ts`](../src/utils/retry.ts)

Exponential backoff with jitter for transient HTTP and network errors.

**Functions:**
- `asyncRetry(fn, options)` — wraps `fn` and re-runs it on qualifying
  errors until success or `maxAttempts` is hit. Re-throws the last
  exception on exhaustion.
- `asyncRetryResult(fn, options)` — same logic but returns `Result<T>`
  instead of throwing, for callers that prefer the Result pattern.

**Configuration (`RetryOptions`):**
- `maxAttempts` — maximum attempts (default: `3`)
- `initialDelay` — initial delay in ms (default: `1000`)
- `maxDelay` — max delay in ms (default: `10000`)
- `exponentialBase` — base for exponential growth (default: `2.0`)
- `retryOnStatus` — HTTP status codes that trigger retry
  (default: `[429, 500, 502, 503, 504]`)
- `retryOnNetworkError` — whether to retry on connection errors
  (default: `true`)

**Delay formula:**
`delay = min(maxDelay, initialDelay * (exponentialBase ^ attempt))`
with a **±10% jitter** applied after calculation to prevent thundering-
herd effects when many clients retry simultaneously.

**Error detection:**
- Axios-style errors (`error.response.status`)
- Fetch-style errors (`error.status`)
- Network errors detected by pattern matching on the error message:
  `network`, `econnrefused`, `timeout`, `socket`, `fetch failed`

**Intended usage:**
- `_apiCall()` wraps each HTTP request in `asyncRetry` using
  sensible defaults.
- Use `asyncRetryResult` from code that already threads `Result<T>`
  through its call stack.

---

## Summary

The TypeScript SDK implements seven layers of defense against common
failure modes:

| Layer | What it does | Default behavior |
|---|---|---|
| Input validation | Reject bad arguments before any work | Always on (stateless helpers) |
| Error sanitization | Strip paths/URLs/keys/IPs/stack traces from user-facing errors | Always on |
| Nonce management | Serialize per-address transactions, avoid conflicts | Always on |
| Observability | Structured logs + request-ID propagation + operation timing | Programmatic config only |
| Provider management | Multi-provider RPC failover with health tracking and cooldown | 3 failures → unhealthy, 60s cooldown |
| Rate limiting | Token bucket for HTTP + RPC traffic | 5 req/s HTTP, 10 req/s RPC |
| Retry | Exponential backoff with jitter for transient failures | 3 attempts, 1s → 10s, ±10% jitter |

Three are always on (validation, sanitization, nonce management). Four
have configurable behavior via `DexalotConfig` / `ProviderManagerConfig`
/ `RetryOptions`. None of them require application-level code to
activate — the SDK wires them in at the client-construction level.

For caching (the 8th operational concern), see
[SDK Caching Guide](sdk-caching.md).
