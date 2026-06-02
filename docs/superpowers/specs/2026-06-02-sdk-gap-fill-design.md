# SDK gap-fill — design spec

**Date:** 2026-06-02
**Branch:** `feat/sdk-gap-fill`
**Status:** Draft awaiting maintainer review

## Context

The Dexalot Trade Kit (`dexalot-trade-kit`, an MCP server + CLI built on this SDK) routes ~48 of its 80 tools through REST because `@dexalot/dexalot-sdk` has no matching method. Within the SDK's stated charter — *"trading operations, cross-chain transfers, and portfolio management"* — five real gaps remain:

1. **Order history per account (paginated)** — SDK has open-orders + single-order reads, no closed history.
2. **Portfolio USD valuation** — token USD prices (snapshot, daily, hourly).
3. **Combined transfer history** — SDK ships every transfer *write*, no read for unified history.
4. **`getDeployment` filters** — existing method takes no params; REST exposes `env` / `contracttype` / `returnabi`.
5. **REST error body preservation** — axios interceptor swallows `{reasonCode, reason}`, callers see generic `"status 400"`.

Out of scope by SDK design (deliberately not added): analytics, leaderboard, vaults, info, PnL, rewards, trader_history. Those are backend reporting endpoints; the trade-kit's REST mountpoints cover them.

## Constraints

- **Parity-first with Python SDK** — `dexalot-sdk-typescript/CLAUDE.md` states new design should land in Python first, then mirror to TS. This PR explicitly violates that ordering with user approval. A "Python parity notes" section at the end documents the shape for mechanical backport.
- **100% unit-test coverage gate** enforced by `coverageThreshold` in `jest.config.js`. Every new branch must be tested.
- **Tag-driven OIDC release** — this PR adds code only. No version bump; release manager handles `pnpm run version:bump:patch` + tag.
- **No new public files** — all additions extend `src/core/{base,clob,transfer}.ts`. New types go in the same files (or `src/types.ts` if it exists).
- **Follow existing patterns**: `Result<T>` returns, snake_case → camelCase field normalization, cache tier assignment, signed-vs-public auth, input validation via `utils/inputValidators.ts`.

## Design

### 1. `getOrderHistory` (CLOB)

**File:** `src/core/clob.ts` — `CLOBClient` mixin.

**Signature:**
```ts
async getOrderHistory(
  account?: string,
  opts?: {
    pair?: string;
    status?: 'NEW' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'KILLED';
    limit?: number;   // default 100, max 500
    offset?: number;  // default 0
  }
): Promise<Result<Order[]>>
```

- `account` defaults to `this.walletAddress` (resolved via existing helper; throws via `Result.fail` if no wallet configured).
- Returns `Order[]` using the **same canonical shape** as `getOpenOrders` — `internalOrderId`, `clientOrderId`, `tradePairId`, `pair`, `price`, `totalAmount`, `quantity`, `quantityFilled`, `totalFee`, `traderAddress`, `side`, `type1`, `type2`, `status`, `createBlock`, `updateBlock`, `createTs`, `updateTs`, `tx`. No new types.
- REST: signed GET to the backend's order history endpoint (path determined at implementation; trade-kit currently hits `/trading/signed/orders?traderaddress=…`). Auth: `x-signature` header via existing signing flow.
- Normalization uses the same `_normalizeOrder` helper that `getOpenOrders` already uses.

### 2. Portfolio USD valuation (3 methods)

**File:** `src/core/transfer.ts` — `TransferClient` mixin (portfolio lives here per existing convention).

```ts
async getTokenUsdPrices(env?: string): Promise<Result<Record<string, number>>>

async getTokenPriceHistory(token: string, opts: {
  from: number;  // unix seconds
  to: number;
}): Promise<Result<PricePoint[]>>

async getTokenHourlyPriceHistory(token: string, opts: {
  from: number;
  to: number;
}): Promise<Result<PricePoint[]>>
```

**New type** (export from the same file):
```ts
export interface PricePoint {
  timestamp: number;  // unix seconds, normalized from API's `ts` / `timestamp` / `time`
  price: number;      // USD
}
```

- `env` defaults to `this.config.parentEnv`.
- `getTokenUsdPrices` returns `{ ALOT: 0.32, USDC: 1.0, … }`.
- Both history methods return ascending-time-ordered arrays.
- Public endpoints — **no auth header**.

### 3. `getCombinedTransfers` (Transfer)

**File:** `src/core/transfer.ts` — `TransferClient` mixin.

**Signature:**
```ts
async getCombinedTransfers(opts?: {
  kind?: 'deposit' | 'withdraw' | 'p2p' | 'gas';
  from?: number;  // unix seconds
  to?: number;
  limit?: number;   // default 100
  offset?: number;
}): Promise<Result<Transfer[]>>
```

**New type:**
```ts
export interface Transfer {
  kind: 'deposit' | 'withdraw' | 'p2p' | 'gas';
  token: string;             // symbol
  amount: number;            // human-readable, decoded from wei using token decimals
  fromChain?: string;        // present for deposit/withdraw
  toChain?: string;
  address: string;           // user address
  counterparty?: string;     // present for p2p
  txHash: string;
  blockNumber: number | null;
  timestamp: number;         // unix seconds
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
}
```

- Signed GET; auth header required.
- Normalization layer maps API fields (`tx`, `txhash`, `block_number`, `chain`, `dest_chain`, etc.) to camelCase + canonical shape, matching how `_normalizeOrder` handles aliases.

### 4. `getDeployment` extension

**File:** `src/core/base.ts` — extend existing method.

**Old:** `getDeployment(): Promise<Result<Deployment[]>>`
**New:**
```ts
async getDeployment(opts?: {
  env?: string;             // defaults to this.config.parentEnv
  contractType?:            // defaults to 'All'
    | 'All'
    | 'Portfolio'
    | 'TradePairs'
    | 'MainnetRFQ'
    | 'PortfolioMain'
    | 'PortfolioSub'
    | 'OrderBooks'
    | string;               // open-ended for forward-compat
  returnAbi?: boolean;      // defaults to true
}): Promise<Result<Deployment[]>>
```

- **Backward compatible**: no-args call uses the existing defaults. All callers continue to work.
- Cache key changes to include the new params (otherwise filter variants collide). Cache stays Static (1h).

### 5. REST error body preservation (cross-cutting fix)

**File:** `src/core/base.ts` — modify error handling in `_apiCall` (or wherever axios errors are translated).

**Current behavior:** axios throws `AxiosError` with `message = "Request failed with status code 400"`. The SDK's error path re-throws or wraps without extracting `response.data`.

**New behavior:** before re-throw, inspect `error.response?.data`. If present:
- If `data.reasonCode` (or `reason_code`): compose `${reasonCode}: ${reason ?? message}`.
- Else if `data.reason` (or `data.message`): use that.
- Else: fall through to original error.

**Pseudo:**
```ts
catch (e) {
  if (axios.isAxiosError(e) && e.response?.data) {
    const body = e.response.data as Record<string, unknown>;
    const reasonCode = (body.reasonCode ?? body.reason_code) as string | undefined;
    const reason = (body.reason ?? body.message) as string | undefined;
    if (reasonCode) {
      throw new Error(`${reasonCode}: ${reason ?? e.message}`);
    }
    if (reason) {
      throw new Error(reason);
    }
  }
  throw e;
}
```

This is ~15 LOC in one function, but the *behavior change* propagates through every SDK method that touches a REST endpoint. After this lands, `getSwapQuote` failures surface `"FQ-015: insufficient liquidity"` instead of `"Request failed with status code 400"`.

**Sanitizer interaction:** the SDK already runs error messages through `errorSanitizer` (strips file paths, URLs, stack traces). The composed `"FQ-015: …"` form passes the sanitizer cleanly — reason codes contain no PII or paths.

## Caching + auth summary

| Method | Tier | TTL | Auth |
|---|---|---|---|
| `getOrderHistory` | Balance | 10s | signed |
| `getTokenUsdPrices` | Semi-Static | 15m | public |
| `getTokenPriceHistory` (daily) | Static | 1h | public |
| `getTokenHourlyPriceHistory` | Static | 1h | public |
| `getCombinedTransfers` | Balance | 10s | signed |
| `getDeployment` (with filters) | Static | 1h | public |

Cache keys follow the existing namespacing rule: `${keyPrefix}|${apiBaseUrl}|${JSON.stringify(args)}`. Signed methods include the resolved address in the args so per-user slots don't collide.

## Testing strategy

100% line/branch/function/statement coverage gate. Each new method gets unit tests in the matching `tests/unit/*.test.ts` file, following existing patterns:

- **Happy path** — mocked axios response, asserts return shape + normalization
- **Empty result** — array length 0
- **API error response** — axios rejection with `response.data.reasonCode` → asserts new error message shape
- **Network error** — axios rejection with no response → falls through to original behavior
- **Pagination boundaries** — limit/offset edge values (where applicable)
- **Auth path** — signed methods verify `x-signature` header was set on the request
- **No-wallet path** — signed methods called without a wallet return `Result.fail(…)` cleanly
- **Cache hit** — second call within TTL doesn't re-hit axios

For the **error preservation fix**: a focused new test in `tests/unit/base.test.ts` covers each branch of the `if` ladder (reasonCode present, reason present, neither). Existing tests that assert exact error strings will need updates — audit during implementation. Expected impact: 5-10 existing assertions.

## README updates

Inline edits only, no restructure. Specifically:

- **Cached Methods** section: add the 5 new methods under their tier.
- **API Field Name Standardization** section: add entries for the new payloads — `PricePoint` fields, `Transfer` field aliases.
- **Error Handling** section: short paragraph noting "Backend reason codes (`FQ-…`, `P-…`, `T-…`, `RF-…`) are preserved in thrown error messages and `Result.fail()` errors."
- **Quick Start / Usage** section: one short snippet showing `getOrderHistory` usage (highest-value new method).

## Out of scope (deliberate)

- **Analytics, leaderboard, vaults, info, PnL, rewards, trader_history endpoints** — by SDK design these belong outside the trading/transfer/portfolio charter.
- **Version bump** — release manager's call.
- **Python backport** — separate PR in `dexalot-sdk-python` (see notes below).
- **Integration tests** — 100% gate is unit-only; integration tests run against live env and aren't part of the coverage threshold.
- **README restructure** — additions only.
- **WebSocket subscriptions for any of the new endpoints** — the trade-kit polls; v2 work.

## Python parity backport notes

When this lands in Python (`dexalot-sdk-python`), the shapes should mirror exactly:

| TS method | Python equivalent |
|---|---|
| `getOrderHistory(account?, opts?)` | `get_order_history(account=None, *, pair=None, status=None, limit=100, offset=0)` |
| `getTokenUsdPrices(env?)` | `get_token_usd_prices(env=None)` |
| `getTokenPriceHistory(token, opts)` | `get_token_price_history(token, *, from_ts, to_ts)` |
| `getTokenHourlyPriceHistory(token, opts)` | `get_token_hourly_price_history(token, *, from_ts, to_ts)` |
| `getCombinedTransfers(opts?)` | `get_combined_transfers(*, kind=None, from_ts=None, to_ts=None, limit=100, offset=0)` |
| `getDeployment(opts?)` | extend `get_deployment(*, env=None, contract_type='All', return_abi=True)` |
| Error body preservation | mirror in Python's REST error path |

The `PricePoint` and `Transfer` types map to typed dicts / dataclasses in Python with snake_case field names.

## Implementation order (for the implementation plan)

Suggested phasing within the single PR (low-risk → high-risk):

1. **Error body preservation** in `base.ts` + tests (smallest blast radius; sets up the test pattern for richer errors).
2. **`getDeployment` filter extension** + cache key change + tests (small, backward-compatible).
3. **`getTokenUsdPrices` + history methods** in `transfer.ts` + tests (public endpoints, no auth complexity).
4. **`getCombinedTransfers`** in `transfer.ts` + tests (signed; canonicalizes the `Transfer` shape).
5. **`getOrderHistory`** in `clob.ts` + tests (signed; reuses canonical `Order` shape).
6. **README updates** as the final commit.

Each step is one or two commits on the feature branch, each green on `pnpm test:unit` and `pnpm typecheck`.

## Open questions

None blocking. Two minor implementation-time decisions left to the implementer:

- The exact REST path for `getOrderHistory`. The trade-kit's `clob_get_orders_by_account` knows it; copy verbatim during implementation.
- Whether `getCombinedTransfers` decodes amounts to human-readable (multiplying by `10^-decimals`) at the SDK boundary, or leaves them as wei strings. The canonical-Transfer shape above assumes decoded — matches `Order` quantity handling. Confirmable from existing transfer-read patterns in the SDK.
