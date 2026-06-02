# SDK Gap-Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close five real gaps in `@dexalot/dexalot-sdk` (TypeScript), mirror to `dexalot-sdk` (Python), and update `dexalot-trade-kit` to route through SDK methods that already exist plus the new ones once published.

**Architecture:** Phased single plan. Phase 1 (TS SDK) implements per the approved spec at `docs/superpowers/specs/2026-06-02-sdk-gap-fill-design.md`. Phase 2 (Python SDK) mirrors phase 1 using the parity table from the spec. Phase 3 (trade-kit immediate) routes three trade-kit tools through SDK methods that already shipped. Phase 4 (trade-kit post-release) is BLOCKED on the SDK npm publish that follows Phase 1 — documented in full so the future engineer can execute it cold.

**Tech Stack:** TypeScript 5.9 + jest (TS SDK), Python 3.11 + pytest (Python SDK), TypeScript + Node ≥18 + tsup (trade-kit). All three repos use `pnpm`/`uv` package managers and have strict coverage gates.

---

## Pre-flight: repository state

Before starting, confirm:

```bash
# TS SDK
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript branch --show-current  # expect: feat/sdk-gap-fill
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript status --short          # expect: clean

# Python SDK (no branch yet)
git -C /Users/craftlabs/mcp/dexalot-sdk-python branch --show-current        # expect: main
git -C /Users/craftlabs/mcp/dexalot-sdk-python status --short               # expect: clean

# Trade-kit
git -C /Users/craftlabs/mcp/dexalot-trade-kit branch --show-current         # expect: main
git -C /Users/craftlabs/mcp/dexalot-trade-kit status --short                # expect: clean
git -C /Users/craftlabs/mcp/dexalot-trade-kit log --oneline -1              # last commit b8ff825 expected
```

If any tree is dirty, stash or commit before proceeding.

---

## File structure (across all three repos)

| Repo | File | Action |
|---|---|---|
| TS SDK | `src/core/base.ts` | modify `_apiCall` error path; modify `getDeployment` |
| TS SDK | `src/core/clob.ts` | add `getOrderHistory` |
| TS SDK | `src/core/transfer.ts` | add `getTokenUsdPrices`, `getTokenPriceHistory`, `getTokenHourlyPriceHistory`, `getCombinedTransfers`; add `PricePoint` + `Transfer` types |
| TS SDK | `tests/unit/base.test.ts` | tests for error preservation + getDeployment extension |
| TS SDK | `tests/unit/clob.test.ts` | tests for `getOrderHistory` |
| TS SDK | `tests/unit/transfer.test.ts` | tests for the four new transfer/portfolio methods |
| TS SDK | `README.md` | inline additions to Cached Methods / Field Standardization / Error Handling |
| Python SDK | `src/dexalot_sdk/core/base.py` | mirror of TS base.ts changes |
| Python SDK | `src/dexalot_sdk/core/clob.py` | add `get_order_history` |
| Python SDK | `src/dexalot_sdk/core/transfer.py` | mirror 4 new methods + types |
| Python SDK | `tests/unit/test_base.py` | mirror error + getDeployment tests |
| Python SDK | `tests/unit/test_clob.py` | mirror `get_order_history` tests |
| Python SDK | `tests/unit/test_transfer.py` | mirror 4 new method tests |
| Python SDK | `README.md` | mirror README additions |
| Trade-kit | `packages/core/src/tools/market.ts` | route `market_get_candles` to `sdk.getCandles` |
| Trade-kit | `packages/core/src/tools/analytics.ts` | route `analytics_get_24h_stats` to `sdk.get24hStats` |
| Trade-kit | `packages/core/test/market.test.ts` | update assertions to SDK path |
| Trade-kit | `packages/core/test/analytics.test.ts` | same |
| Trade-kit (Phase 4) | `packages/core/package.json` | bump `@dexalot/dexalot-sdk` after release |
| Trade-kit (Phase 4) | `packages/core/src/tools/clob-read.ts` | route `clob_get_orders_by_account` to `sdk.getOrderHistory` |
| Trade-kit (Phase 4) | `packages/core/src/tools/portfolio.ts` | route the 3 USD-price tools to SDK |
| Trade-kit (Phase 4) | `packages/core/src/tools/transfer.ts` | route `transfer_get_combined_transfers` to SDK |
| Trade-kit (Phase 4) | `packages/core/src/tools/market.ts` | route `market_get_deployed_contracts` to `sdk.getDeployment({env, contractType, returnAbi})` |

---

# PHASE 1 — TypeScript SDK gap-fill (session-actionable)

**Branch:** `feat/sdk-gap-fill` (already created off `main`)
**Working directory:** `/Users/craftlabs/mcp/dexalot-sdk-typescript`
**Coverage gate:** 100% line/branch/function/statement (enforced by `jest.config.js`)

---

### Task 1.1 — Error body preservation in `_apiCall`

The lowest-blast-radius change first. Adds a branch in the catch path of `_apiCall` to lift `reasonCode` + `reason` from axios error response bodies. Existing tests that assert exact axios error strings will need updates (we'll find them in Step 3).

**Files:**
- Modify: `src/core/base.ts` — find the `_apiCall` method's catch block
- Modify: `tests/unit/base.test.ts` — add new test cases

- [ ] **Step 1.1.1: Read the existing `_apiCall` shape**

```bash
grep -n "_apiCall\|axios.isAxiosError\|catch" /Users/craftlabs/mcp/dexalot-sdk-typescript/src/core/base.ts | head -30
```

Note the exact line range of the current catch block — the edit replaces only the throw inside it.

- [ ] **Step 1.1.2: Write the failing test for `reasonCode` extraction**

Add to `tests/unit/base.test.ts`:

```ts
describe('_apiCall error preservation', () => {
  it('extracts reasonCode + reason from axios response body', async () => {
    const client = new DexalotClient(createConfig({ parentEnv: 'fuji-multi' }));
    const axiosInstance = (client as any)._axiosInstance; // or however the test harness exposes it
    const axiosError = Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true,
      response: { status: 400, data: { reasonCode: 'FQ-015', reason: 'insufficient liquidity' } },
    });
    jest.spyOn(axiosInstance, 'get').mockRejectedValueOnce(axiosError);
    const result = await (client as any)._apiCall('get', '/test');
    expect(result.success).toBe(false);
    expect(result.error).toBe('FQ-015: insufficient liquidity');
  });

  it('falls back to reason alone when no reasonCode', async () => {
    // similar setup with response.data = { reason: 'something else' }
    // expect result.error === 'something else'
  });

  it('falls back to original error when response.data is empty', async () => {
    // axiosError.response.data = {}; expect original message preserved
  });

  it('falls back to original error when not an axios error', async () => {
    // throw new Error('generic'); expect 'generic' preserved
  });
});
```

- [ ] **Step 1.1.3: Run the test to confirm it fails**

```bash
cd /Users/craftlabs/mcp/dexalot-sdk-typescript && pnpm test:unit -- tests/unit/base.test.ts -t "error preservation"
```

Expected: FAIL — `result.error` is "Request failed with status code 400", not "FQ-015: insufficient liquidity".

- [ ] **Step 1.1.4: Implement the lift in `base.ts`**

In `src/core/base.ts`, inside `_apiCall`'s catch block, before the existing throw/return:

```ts
if (axios.isAxiosError(e) && e.response?.data && typeof e.response.data === 'object') {
  const body = e.response.data as Record<string, unknown>;
  const reasonCode = (body.reasonCode ?? body.reason_code) as string | undefined;
  const reason = (body.reason ?? body.message) as string | undefined;
  if (typeof reasonCode === 'string') {
    return Result.fail(`${reasonCode}: ${reason ?? (e as Error).message}`);
  }
  if (typeof reason === 'string') {
    return Result.fail(reason);
  }
}
```

Insert before the original `return Result.fail(...)` / throw at the end of the catch. Verify the function still returns the `Result<T>` shape (not raw throw) — match existing pattern in this file.

- [ ] **Step 1.1.5: Run tests to confirm all pass**

```bash
pnpm test:unit -- tests/unit/base.test.ts
```

Expected: PASS, including the four new cases. If existing tests fail because they asserted exact "Request failed with status code 400" messages, update those assertions to match the new richer error strings, OR update the test fixtures to not include `reasonCode`/`reason` in the mock response body.

- [ ] **Step 1.1.6: Run the full test suite + coverage**

```bash
pnpm test:unit
pnpm cov
```

Expected: all green, coverage stays at 100%.

- [ ] **Step 1.1.7: Commit**

```bash
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript add src/core/base.ts tests/unit/base.test.ts
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript commit -m "feat(base): preserve REST error bodies (reasonCode + reason) in _apiCall

Backend reason codes (FQ-, P-, T-, RF-) now surface in Result.fail
messages instead of being swallowed as 'Request failed with status code N'.
Matches the trade-kit's REST client's own reasonCode handling.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 1.2 — `getDeployment` filter extension

Backward-compatible addition of optional `{env, contractType, returnAbi}` opts. No-args call still works (unchanged defaults).

**Files:**
- Modify: `src/core/base.ts` — `getDeployment` method
- Modify: `tests/unit/base.test.ts` (or wherever `getDeployment` is tested)

- [ ] **Step 1.2.1: Read existing `getDeployment` signature**

```bash
grep -n "getDeployment\|deployment/params" /Users/craftlabs/mcp/dexalot-sdk-typescript/src/core/base.ts
```

Identify the current implementation: REST path, default query, cache key.

- [ ] **Step 1.2.2: Write failing tests for the new options**

In `tests/unit/base.test.ts`:

```ts
describe('getDeployment with filters', () => {
  it('passes env, contractType, returnAbi as query params when provided', async () => {
    const client = new DexalotClient(createConfig({ parentEnv: 'production-multi-avax' }));
    const spy = jest.spyOn((client as any), '_apiCall').mockResolvedValueOnce(Result.ok([]));
    await client.getDeployment({ env: 'fuji-multi-avax', contractType: 'Portfolio', returnAbi: false });
    expect(spy).toHaveBeenCalledWith('get', expect.stringContaining('deployment/params'), expect.objectContaining({
      params: { env: 'fuji-multi-avax', contracttype: 'Portfolio', returnabi: false },
    }));
  });

  it('defaults env to config.parentEnv, contractType to All, returnAbi to true', async () => {
    const client = new DexalotClient(createConfig({ parentEnv: 'production-multi-avax' }));
    const spy = jest.spyOn((client as any), '_apiCall').mockResolvedValueOnce(Result.ok([]));
    await client.getDeployment();
    expect(spy).toHaveBeenCalledWith('get', expect.stringContaining('deployment/params'), expect.objectContaining({
      params: { env: 'production-multi-avax', contracttype: 'All', returnabi: true },
    }));
  });

  it('uses distinct cache slots per param combination', async () => {
    // call getDeployment({env: 'A'}) then getDeployment({env: 'B'}) and assert the underlying _apiCall fired twice
  });
});
```

- [ ] **Step 1.2.3: Run tests to confirm failure**

```bash
pnpm test:unit -- tests/unit/base.test.ts -t "getDeployment with filters"
```

Expected: FAIL with type error or "no options accepted" (depending on current shape).

- [ ] **Step 1.2.4: Extend the method signature + implementation**

In `src/core/base.ts`:

```ts
public async getDeployment(opts?: {
  env?: string;
  contractType?: 'All' | 'Portfolio' | 'TradePairs' | 'MainnetRFQ' | 'PortfolioMain' | 'PortfolioSub' | 'OrderBooks' | string;
  returnAbi?: boolean;
}): Promise<Result<Deployment[]>> {
  const env = opts?.env ?? this.config.parentEnv;
  const contracttype = opts?.contractType ?? 'All';
  const returnabi = opts?.returnAbi ?? true;
  return withInstanceCache(
    this,
    getStaticCache(),
    `getDeployment|${env}|${contracttype}|${returnabi}`,  // cache key includes all params
    async () => this._apiCall('get', '/api/deployment/params', { params: { env, contracttype, returnabi } }),
  );
}
```

Match the exact cache pattern used by other methods in this file. Note the lowercase query param names (`contracttype`, `returnabi`) — the backend expects them lowercase.

- [ ] **Step 1.2.5: Run all tests + verify backward compat**

```bash
pnpm test:unit -- tests/unit/base.test.ts
```

Expected: PASS. Importantly, any existing `getDeployment()` no-args calls in other tests still work.

- [ ] **Step 1.2.6: Commit**

```bash
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript add src/core/base.ts tests/unit/base.test.ts
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript commit -m "feat(base): extend getDeployment with env/contractType/returnAbi filters

Backward-compatible. No-args call still returns the same default
shape. Cache key includes filter params so variants don't collide.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 1.3 — `getTokenUsdPrices` (public)

**Files:**
- Modify: `src/core/transfer.ts` — add method to `TransferClient`
- Modify: `tests/unit/transfer.test.ts`

- [ ] **Step 1.3.1: Identify the REST path**

Check the trade-kit's `portfolio_get_token_usd_prices` handler at `/Users/craftlabs/mcp/dexalot-trade-kit/packages/core/src/tools/portfolio.ts` for the exact endpoint and query shape. Copy the path verbatim.

```bash
grep -n "usd-prices\|usdprices\|usd_prices" /Users/craftlabs/mcp/dexalot-trade-kit/packages/core/src/tools/portfolio.ts | head -5
```

- [ ] **Step 1.3.2: Write the failing test**

In `tests/unit/transfer.test.ts`:

```ts
describe('getTokenUsdPrices', () => {
  it('returns a token-symbol → USD-price map from the public endpoint', async () => {
    const client = new DexalotClient(createConfig({ parentEnv: 'production-multi-avax' }));
    const mockResponse = [{ symbol: 'ALOT', price: 0.32 }, { symbol: 'USDC', price: 1.0 }];
    const spy = jest.spyOn((client as any), '_apiCall').mockResolvedValueOnce(Result.ok(mockResponse));
    const result = await client.getTokenUsdPrices();
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ALOT: 0.32, USDC: 1.0 });
    expect(spy).toHaveBeenCalledWith('get', expect.stringContaining('usdprices'), expect.anything());
  });

  it('uses provided env over config.parentEnv', async () => {
    // pass env: 'fuji-multi-avax'; assert request query carries it
  });

  it('returns Result.fail on API error', async () => {
    // spy resolves to Result.fail; expect propagation
  });
});
```

- [ ] **Step 1.3.3: Verify failure**

```bash
pnpm test:unit -- tests/unit/transfer.test.ts -t "getTokenUsdPrices"
```

- [ ] **Step 1.3.4: Implement the method in `transfer.ts`**

```ts
public async getTokenUsdPrices(env?: string): Promise<Result<Record<string, number>>> {
  const targetEnv = env ?? this.config.parentEnv;
  return withInstanceCache(
    this,
    getSemiStaticCache(),
    `getTokenUsdPrices|${targetEnv}`,
    async () => {
      const raw = await this._apiCall<Array<{ symbol: string; price: number }>>(
        'get',
        '/api/info/usdprices',                       // confirm path against trade-kit
        { params: { env: targetEnv } },
      );
      if (!raw.success) return Result.fail(raw.error);
      const map: Record<string, number> = {};
      for (const row of raw.data ?? []) {
        if (typeof row.symbol === 'string' && typeof row.price === 'number') {
          map[row.symbol] = row.price;
        }
      }
      return Result.ok(map);
    },
  );
}
```

Use `getSemiStaticCache()` per the spec (15min TTL).

- [ ] **Step 1.3.5: Run tests + verify**

```bash
pnpm test:unit -- tests/unit/transfer.test.ts
```

- [ ] **Step 1.3.6: Commit**

```bash
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript add src/core/transfer.ts tests/unit/transfer.test.ts
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript commit -m "feat(transfer): add getTokenUsdPrices for portfolio USD valuation

Returns token-symbol → USD-price map from the public /info/usdprices
endpoint. Cached at Semi-Static tier (15m TTL).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 1.4 — `getTokenPriceHistory` + `getTokenHourlyPriceHistory` (public)

Add the `PricePoint` type + two timeseries methods. Same file as 1.3.

**Files:**
- Modify: `src/core/transfer.ts`
- Modify: `tests/unit/transfer.test.ts`

- [ ] **Step 1.4.1: Identify REST paths**

```bash
grep -n "price.history\|pricehistory\|hourly" /Users/craftlabs/mcp/dexalot-trade-kit/packages/core/src/tools/portfolio.ts | head -10
```

- [ ] **Step 1.4.2: Define + export `PricePoint` type**

At the top of `src/core/transfer.ts` (or in `src/types.ts` if that's the convention):

```ts
export interface PricePoint {
  timestamp: number;  // unix seconds
  price: number;      // USD
}
```

- [ ] **Step 1.4.3: Write failing tests for both methods**

```ts
describe('getTokenPriceHistory', () => {
  it('returns ascending-time-ordered PricePoint[] for a token', async () => {
    const client = new DexalotClient(createConfig({ parentEnv: 'production-multi-avax' }));
    const raw = [{ ts: 1717200000, price: 0.30 }, { ts: 1717286400, price: 0.31 }];
    jest.spyOn((client as any), '_apiCall').mockResolvedValueOnce(Result.ok(raw));
    const result = await client.getTokenPriceHistory('ALOT', { from: 1717200000, to: 1717286400 });
    expect(result.data).toEqual([
      { timestamp: 1717200000, price: 0.30 },
      { timestamp: 1717286400, price: 0.31 },
    ]);
  });
  // + edge cases: empty result, error path, alias normalization (ts vs timestamp)
});

describe('getTokenHourlyPriceHistory', () => {
  // mirrors above
});
```

- [ ] **Step 1.4.4: Implement both methods**

```ts
public async getTokenPriceHistory(token: string, opts: { from: number; to: number }): Promise<Result<PricePoint[]>> {
  return withInstanceCache(
    this,
    getStaticCache(),
    `getTokenPriceHistory|${token}|${opts.from}|${opts.to}`,
    async () => this._fetchPriceHistory('/api/info/pricehistory', token, opts),
  );
}

public async getTokenHourlyPriceHistory(token: string, opts: { from: number; to: number }): Promise<Result<PricePoint[]>> {
  return withInstanceCache(
    this,
    getStaticCache(),
    `getTokenHourlyPriceHistory|${token}|${opts.from}|${opts.to}`,
    async () => this._fetchPriceHistory('/api/info/hourlypricehistory', token, opts),
  );
}

private async _fetchPriceHistory(path: string, token: string, opts: { from: number; to: number }): Promise<Result<PricePoint[]>> {
  const raw = await this._apiCall<Array<{ ts?: number; timestamp?: number; price: number }>>(
    'get',
    path,
    { params: { token, from: opts.from, to: opts.to } },
  );
  if (!raw.success) return Result.fail(raw.error);
  const points: PricePoint[] = (raw.data ?? []).map((r) => ({
    timestamp: (r.ts ?? r.timestamp ?? 0) as number,
    price: r.price,
  }));
  return Result.ok(points);
}
```

- [ ] **Step 1.4.5: Run tests + verify**

```bash
pnpm test:unit -- tests/unit/transfer.test.ts -t "PriceHistory"
```

- [ ] **Step 1.4.6: Commit**

```bash
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript add src/core/transfer.ts tests/unit/transfer.test.ts
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript commit -m "feat(transfer): add price history methods (daily + hourly)

getTokenPriceHistory and getTokenHourlyPriceHistory return ascending-
time-ordered PricePoint[] from /info/pricehistory and /info/hourlypricehistory.
Static-tier cached (1h TTL) since past prices don't change.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 1.5 — `getCombinedTransfers` (signed)

**Files:**
- Modify: `src/core/transfer.ts` — add method + `Transfer` type
- Modify: `tests/unit/transfer.test.ts`

- [ ] **Step 1.5.1: Identify the REST path + auth pattern**

```bash
grep -n "combined.transfers\|combinedtransfers" /Users/craftlabs/mcp/dexalot-trade-kit/packages/core/src/tools/transfer.ts | head -10
```

Confirm: signed endpoint, expects `x-signature` header.

- [ ] **Step 1.5.2: Define the `Transfer` type**

```ts
export interface Transfer {
  kind: 'deposit' | 'withdraw' | 'p2p' | 'gas';
  token: string;
  amount: number;               // decoded from wei via token decimals
  fromChain?: string;
  toChain?: string;
  address: string;
  counterparty?: string;
  txHash: string;
  blockNumber: number | null;
  timestamp: number;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
}
```

- [ ] **Step 1.5.3: Write failing tests**

```ts
describe('getCombinedTransfers', () => {
  it('requires a wallet for the signed call', async () => {
    const client = new DexalotClient(createConfig({ parentEnv: 'production-multi-avax' }));
    // no privateKey configured
    const result = await client.getCombinedTransfers();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/wallet/i);
  });

  it('normalizes API field aliases (tx → txHash, etc.)', async () => {
    // mock with raw API shape, assert normalized output
  });

  it('forwards kind/from/to/limit/offset to the query', async () => {
    // spy on _apiCall, assert params
  });

  it('decodes amount to human-readable using token decimals', async () => {
    // mock returns amount in wei string; assert decoded
  });
});
```

- [ ] **Step 1.5.4: Implement the method**

```ts
public async getCombinedTransfers(opts?: {
  kind?: 'deposit' | 'withdraw' | 'p2p' | 'gas';
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}): Promise<Result<Transfer[]>> {
  if (!this.walletAddress) {
    return Result.fail('getCombinedTransfers requires a configured wallet');
  }
  const address = this.walletAddress;
  return withInstanceCache(
    this,
    getBalanceCache(),
    `getCombinedTransfers|${address}|${JSON.stringify(opts ?? {})}`,
    async () => {
      const raw = await this._apiCall<Array<Record<string, unknown>>>(
        'get',
        '/privapi/transfers/combined',                  // confirm path
        {
          params: {
            traderaddress: address,
            kind: opts?.kind,
            from: opts?.from,
            to: opts?.to,
            limit: opts?.limit ?? 100,
            offset: opts?.offset ?? 0,
          },
          signed: true,
        },
      );
      if (!raw.success) return Result.fail(raw.error);
      const transfers = (raw.data ?? []).map((r) => this._normalizeTransfer(r));
      return Result.ok(transfers);
    },
  );
}

private _normalizeTransfer(r: Record<string, unknown>): Transfer {
  const kind = String(r.kind ?? r.type ?? 'deposit') as Transfer['kind'];
  const token = String(r.token ?? r.symbol ?? '');
  const decimals = this._getTokenDecimals(token); // reuse existing helper
  const amountRaw = r.amount ?? r.value;
  const amount = typeof amountRaw === 'number'
    ? amountRaw
    : Number(fromWei(String(amountRaw), decimals));
  return {
    kind,
    token,
    amount,
    fromChain: r.fromChain ?? r.from_chain ?? r.chain,
    toChain: r.toChain ?? r.to_chain ?? r.dest_chain,
    address: String(r.address ?? r.traderaddress ?? ''),
    counterparty: r.counterparty as string | undefined,
    txHash: String(r.txHash ?? r.tx ?? r.txhash ?? ''),
    blockNumber: r.blockNumber ?? r.block_number ?? null,
    timestamp: Number(r.timestamp ?? r.ts ?? 0),
    status: String(r.status ?? 'COMPLETED').toUpperCase() as Transfer['status'],
  } as Transfer;
}
```

If `_getTokenDecimals` isn't an existing helper, use whatever pattern existing transfer methods use to resolve decimals (likely `this._tokens[symbol]?.evmDecimals`).

- [ ] **Step 1.5.5: Run + verify**

- [ ] **Step 1.5.6: Commit**

```bash
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript commit -m "feat(transfer): add getCombinedTransfers for unified history

Signed GET to /privapi/transfers/combined. Returns canonical Transfer[]
(camelCase, normalized aliases) with kind/from/to/limit/offset filters.
Balance-tier cached (10s TTL).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 1.6 — `getOrderHistory` (signed)

**Files:**
- Modify: `src/core/clob.ts` — add method
- Modify: `tests/unit/clob.test.ts`

- [ ] **Step 1.6.1: Identify the REST endpoint**

```bash
grep -n "orders_by_account\|get_orders_by_account\|traderaddress" /Users/craftlabs/mcp/dexalot-trade-kit/packages/core/src/tools/clob-read.ts | head -10
```

Copy the path verbatim.

- [ ] **Step 1.6.2: Write failing tests**

```ts
describe('getOrderHistory', () => {
  it('requires wallet when no account argument', async () => {
    const client = new DexalotClient(createConfig({ parentEnv: 'production-multi-avax' }));
    const result = await client.getOrderHistory();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/wallet/i);
  });

  it('returns canonical Order[] from the signed endpoint', async () => {
    // mock raw API order shape; assert normalized output via _normalizeOrder
  });

  it('forwards pair/status/limit/offset to the query', async () => {
    // assert params
  });

  it('passes explicit account argument over wallet', async () => {
    // configure wallet + call getOrderHistory('0xother'); assert traderaddress=0xother
  });
});
```

- [ ] **Step 1.6.3: Implement**

```ts
public async getOrderHistory(
  account?: string,
  opts?: {
    pair?: string;
    status?: 'NEW' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'KILLED';
    limit?: number;
    offset?: number;
  },
): Promise<Result<Order[]>> {
  const address = account ?? this.walletAddress;
  if (!address) {
    return Result.fail('getOrderHistory requires either an account argument or a configured wallet');
  }
  return withInstanceCache(
    this,
    getBalanceCache(),
    `getOrderHistory|${address}|${JSON.stringify(opts ?? {})}`,
    async () => {
      const raw = await this._apiCall<Array<Record<string, unknown>>>(
        'get',
        '/privapi/trading/orders',                       // confirm path
        {
          params: {
            traderaddress: address,
            pair: opts?.pair,
            status: opts?.status,
            limit: opts?.limit ?? 100,
            offset: opts?.offset ?? 0,
          },
          signed: true,
        },
      );
      if (!raw.success) return Result.fail(raw.error);
      const orders = (raw.data ?? []).map((r) => this._normalizeOrder(r));
      return Result.ok(orders);
    },
  );
}
```

`_normalizeOrder` is the existing helper used by `getOpenOrders`. Reuse — do not duplicate.

- [ ] **Step 1.6.4: Run + verify**

- [ ] **Step 1.6.5: Commit**

```bash
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript commit -m "feat(clob): add getOrderHistory for paginated per-account history

Signed GET; returns canonical Order[] (same shape as getOpenOrders).
Accepts pair/status/limit/offset filters. Balance-tier cached (10s).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 1.7 — Full-suite coverage check + README updates

- [ ] **Step 1.7.1: Run the full test suite + coverage report**

```bash
cd /Users/craftlabs/mcp/dexalot-sdk-typescript && pnpm test:unit && pnpm cov
```

Expected: all tests pass, 100% coverage maintained. If coverage dropped, identify uncovered branches and add tests before continuing.

- [ ] **Step 1.7.2: Update README — Cached Methods section**

In `/Users/craftlabs/mcp/dexalot-sdk-typescript/README.md`, find "Cached Methods" section. Add:

```markdown
**Semi-Static Data (15 minutes):**
- … (existing entries) …
- `getTokenUsdPrices(env?)`

**Static Data (1 hour):**
- … (existing entries) …
- `getTokenPriceHistory(token, opts)`
- `getTokenHourlyPriceHistory(token, opts)`

**Balance Data (10 seconds):**
- … (existing entries) …
- `getOrderHistory(account?, opts?)`
- `getCombinedTransfers(opts?)`
```

- [ ] **Step 1.7.3: Update README — API Field Name Standardization section**

Add after existing entries:

```markdown
**Price History API:**
- `timestamp` (from `ts`, `timestamp`, `time`)
- `price`

**Combined Transfers API:**
- `kind` (from `kind`, `type`)
- `txHash` (from `tx`, `txhash`, `tx_hash`)
- `blockNumber` (from `blockNumber`, `block_number`)
- `fromChain` (from `fromChain`, `from_chain`, `chain`)
- `toChain` (from `toChain`, `to_chain`, `dest_chain`)
- `timestamp` (from `timestamp`, `ts`)
- `address` (from `address`, `traderaddress`)
```

- [ ] **Step 1.7.4: Update README — Error Handling section**

Add a paragraph:

```markdown
### Backend reason codes

Errors from the Dexalot REST API include structured `reasonCode` (e.g. `FQ-015`, `P-AFNE-02`, `T-TMDQ-01`, `RF-IMV-01`) and human `reason` fields. These are now preserved in `Result.fail()` error messages — you'll see `"FQ-015: insufficient liquidity"` rather than the generic `"Request failed with status code 400"`. Catch and pattern-match on the code prefix to react programmatically.
```

- [ ] **Step 1.7.5: Add a Quick-Start snippet for `getOrderHistory`**

In README "Usage" section, after the existing examples:

```markdown
### Order history

```typescript
const result = await client.getOrderHistory(undefined, {
  pair: 'ALOT/USDC',
  status: 'FILLED',
  limit: 50,
});
if (result.success) {
  for (const order of result.data) {
    console.log(`${order.pair} ${order.side} ${order.quantity} @ ${order.price}`);
  }
}
```
```

- [ ] **Step 1.7.6: Commit README updates**

```bash
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript add README.md
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript commit -m "docs(readme): document 5 new methods + error preservation

Adds new methods to Cached Methods lists, field-normalization entries
for PricePoint + Transfer payloads, an Error Handling paragraph on
preserved reason codes, and a getOrderHistory usage snippet.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 1.8 — Push branch + open PR

- [ ] **Step 1.8.1: Confirm full local green**

```bash
cd /Users/craftlabs/mcp/dexalot-sdk-typescript && pnpm typecheck && pnpm test:unit && pnpm cov && pnpm audit:high
```

All must pass.

- [ ] **Step 1.8.2: Push the branch**

```bash
git -C /Users/craftlabs/mcp/dexalot-sdk-typescript push -u origin feat/sdk-gap-fill
```

- [ ] **Step 1.8.3: Open the PR via `gh`**

```bash
gh pr create --repo dexalot/dexalot-sdk-typescript \
  --title "feat: gap-fill — order history, USD prices, combined transfers, getDeployment filters, error preservation" \
  --body "$(cat <<'EOF'
## Summary
Closes five gaps inside the SDK's trading/transfers/portfolio charter:
- `getOrderHistory(account?, opts?)` — paginated per-account history
- `getTokenUsdPrices(env?)`, `getTokenPriceHistory`, `getTokenHourlyPriceHistory` — portfolio USD valuation
- `getCombinedTransfers(opts?)` — unified transfer history
- `getDeployment({env, contractType, returnAbi})` — extended with backward-compatible filters
- `_apiCall` error path now preserves `reasonCode`/`reason` from REST response bodies (FQ-, P-, T-, RF- codes survive into Result.fail)

## Design
Full design doc: `docs/superpowers/specs/2026-06-02-sdk-gap-fill-design.md`

## Parity caveat
This lands TS-first, violating the parity-first policy in CLAUDE.md with maintainer approval. Python backport tracked separately at dexalot-sdk-python; design shapes are identical (see Python parity notes in the spec).

## Test plan
- [x] `pnpm typecheck` green
- [x] `pnpm test:unit` all green
- [x] `pnpm cov` — 100% coverage maintained
- [x] `pnpm audit:high` clean
EOF
)"
```

- [ ] **Step 1.8.4: Note the PR URL**

Save it for cross-reference in Phase 2 and Phase 4 commit messages.

---

# PHASE 2 — Python SDK mirror (session-actionable after Phase 1)

**Branch:** `feat/sdk-gap-fill` (create off `main`)
**Working directory:** `/Users/craftlabs/mcp/dexalot-sdk-python`
**Coverage tool:** pytest + coverage; check `pyproject.toml` for the threshold (mirror TS's 100%)

Before starting, **read** `/Users/craftlabs/mcp/dexalot-sdk-typescript/docs/superpowers/specs/2026-06-02-sdk-gap-fill-design.md` (the spec) to refresh design intent — especially the Python parity table at the end. Each Python task is the direct mirror of its TS counterpart.

### Task 2.1 — Setup branch + read structure

- [ ] **Step 2.1.1: Create branch**

```bash
git -C /Users/craftlabs/mcp/dexalot-sdk-python checkout -b feat/sdk-gap-fill
```

- [ ] **Step 2.1.2: Read Python SDK core modules**

```bash
ls /Users/craftlabs/mcp/dexalot-sdk-python/src/dexalot_sdk/core/
cat /Users/craftlabs/mcp/dexalot-sdk-python/src/dexalot_sdk/core/base.py | head -200
```

Note the patterns: async methods, `Result[T]` shape (from `utils.result`), cache decorator usage, `_api_call` signature, signed-call mechanism.

### Task 2.2 — Error preservation in `_api_call` (Python mirror of 1.1)

**Files:**
- Modify: `src/dexalot_sdk/core/base.py` — `_api_call` exception handling
- Modify: `tests/unit/test_base.py` — new test cases

- [ ] **Step 2.2.1: Write failing tests**

```python
@pytest.mark.asyncio
async def test_api_call_preserves_reason_code_in_error():
    client = DexalotClient(parent_env="production-multi-avax")
    # mock httpx response with reasonCode + reason body
    mock_response = httpx.Response(400, json={"reasonCode": "FQ-015", "reason": "insufficient liquidity"})
    with respx.mock(base_url="https://api.dexalot.com") as mock:
        mock.get("/test").mock(return_value=mock_response)
        result = await client._api_call("get", "/test")
    assert result.success is False
    assert result.error == "FQ-015: insufficient liquidity"
```

Add 3 more cases mirroring the TS tests (reason only, empty body, non-HTTP error).

- [ ] **Step 2.2.2: Verify failure**

```bash
cd /Users/craftlabs/mcp/dexalot-sdk-python && pytest tests/unit/test_base.py::test_api_call_preserves_reason_code_in_error -v
```

- [ ] **Step 2.2.3: Implement the lift in `base.py`**

Inside `_api_call`'s exception handler:

```python
except httpx.HTTPStatusError as e:
    body: dict | None = None
    try:
        body = e.response.json() if e.response is not None else None
    except (ValueError, json.JSONDecodeError):
        body = None
    if isinstance(body, dict):
        reason_code = body.get("reasonCode") or body.get("reason_code")
        reason = body.get("reason") or body.get("message")
        if isinstance(reason_code, str):
            return Result.fail(f"{reason_code}: {reason or str(e)}")
        if isinstance(reason, str):
            return Result.fail(reason)
    return Result.fail(str(e))
```

Match the actual http client and exception type used (likely `httpx.HTTPStatusError` or `requests.HTTPError` — check existing code).

- [ ] **Step 2.2.4: Run + commit**

```bash
pytest tests/unit/test_base.py -v
git -C /Users/craftlabs/mcp/dexalot-sdk-python add src/dexalot_sdk/core/base.py tests/unit/test_base.py
git -C /Users/craftlabs/mcp/dexalot-sdk-python commit -m "feat(base): preserve REST error bodies (reasonCode + reason) in _api_call

Mirror of TS SDK gap-fill commit. Backend reason codes (FQ-, P-, T-,
RF-) now surface in Result.fail messages.

See dexalot-sdk-typescript PR <URL-from-1.8.4>.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 2.3 — `get_deployment` filter extension (mirror of 1.2)

**Files:**
- Modify: `src/dexalot_sdk/core/base.py` — `get_deployment` method
- Modify: `tests/unit/test_base.py`

Mirror TS task 1.2. Python signature:

```python
async def get_deployment(
    self,
    *,
    env: str | None = None,
    contract_type: str = "All",
    return_abi: bool = True,
) -> Result[list[Deployment]]:
    target_env = env or self.config.parent_env
    return await with_instance_cache(
        self,
        get_static_cache(),
        f"get_deployment|{target_env}|{contract_type}|{return_abi}",
        lambda: self._api_call("get", "/api/deployment/params", params={
            "env": target_env,
            "contracttype": contract_type,
            "returnabi": return_abi,
        }),
    )
```

Test signature mirrors TS. Commit.

### Task 2.4 — `get_token_usd_prices` (mirror of 1.3)

Mirror TS 1.3. Python method on `TransferClient` (likely in `transfer.py`). Same caching tier (Semi-Static, 15m). Tests mirror TS shapes.

### Task 2.5 — Price history methods (mirror of 1.4)

Add `PricePoint` dataclass:

```python
@dataclass
class PricePoint:
    timestamp: int
    price: float
```

Then `get_token_price_history` and `get_token_hourly_price_history`. Static cache tier. Tests + commit.

### Task 2.6 — `get_combined_transfers` (mirror of 1.5)

Add `Transfer` dataclass mirroring TS shape. Method on `TransferClient`. Signed call. Balance cache tier. Tests + commit.

### Task 2.7 — `get_order_history` (mirror of 1.6)

Method on `CLOBClient`. Uses existing `_normalize_order` helper. Tests + commit.

### Task 2.8 — README + coverage + push

- [ ] **Step 2.8.1: Update `/Users/craftlabs/mcp/dexalot-sdk-python/README.md`**

Mirror the additions made to the TS README in 1.7: Cached Methods entries, Field Standardization entries, Error Handling paragraph, usage snippet (in Python).

- [ ] **Step 2.8.2: Run the full check**

```bash
cd /Users/craftlabs/mcp/dexalot-sdk-python && uv run pytest --cov=src/dexalot_sdk --cov-report=term-missing tests/unit && uv run mypy src && uv run ruff check src
```

Expected: all green, 100% coverage (or whatever the Python threshold is).

- [ ] **Step 2.8.3: Push + PR**

```bash
git -C /Users/craftlabs/mcp/dexalot-sdk-python push -u origin feat/sdk-gap-fill
gh pr create --repo dexalot/dexalot-sdk-python --title "feat: gap-fill mirror of TS SDK" --body "Mirror of dexalot-sdk-typescript#<N>"
```

---

# PHASE 3 — Trade-kit immediate routings (SESSION-ACTIONABLE NOW)

**Branch:** `feat/sdk-immediate-routings` (create off `main`)
**Working directory:** `/Users/craftlabs/mcp/dexalot-trade-kit`

These three routing changes can ship **immediately** without waiting on any SDK release — the methods (`getCandles`, `get24hStats`, `getChainTokenBalances`) already exist in the published `@dexalot/dexalot-sdk@^0.5.17`.

### Task 3.1 — Branch + verify SDK methods exist

- [ ] **Step 3.1.1: Create branch**

```bash
git -C /Users/craftlabs/mcp/dexalot-trade-kit checkout -b feat/sdk-immediate-routings
```

- [ ] **Step 3.1.2: Confirm SDK methods are present**

```bash
grep "getCandles\|get24hStats\|getChainTokenBalances" /Users/craftlabs/mcp/dexalot-trade-kit/node_modules/@dexalot/dexalot-sdk/dist/core/*.d.ts
```

Expected: each name shows up at least once. If anything's missing, the SDK version in `node_modules` is older than expected — check `packages/core/package.json` and re-run `pnpm install`.

### Task 3.2 — Route `market_get_candles` through SDK

**Files:**
- Modify: `packages/core/src/tools/market.ts` — find the candles handler (around line 167-210)
- Modify: `packages/core/test/market.test.ts`

- [ ] **Step 3.2.1: Update the test first**

In `packages/core/test/market.test.ts`, find the existing `market_get_candles` test that asserts REST routing. Rewrite to assert SDK routing:

```ts
describe("market_get_candles (SDK)", () => {
  const tool = registerMarketTools().find((t) => t.name === "market_get_candles")!;
  it("routes through SDK getCandles", async () => {
    const { recorded, contract } = stubContract({ candles: [] });
    contract.get = async () => ({ getCandles: async (pair: string, periodfrom: number, periodto: number, intervalnum: number, intervalstr: string) => {
      recorded.push(`getCandles:${pair}|${periodfrom}|${periodto}|${intervalnum}|${intervalstr}`);
      return { success: true, data: { candles: [] } };
    }});
    await tool.handler(
      { pair: "ALOT/USDC", periodfrom: "2026-05-24", periodto: "2026-05-25", intervalnum: 1, intervalstr: "hours" },
      { config: BASE_CONFIG, client: {} as any, contract },
    );
    assert.match(recorded[0]!, /^getCandles:ALOT\/USDC/);
  });
});
```

(Match the actual `stubContract` helper signature in the existing test file.)

- [ ] **Step 3.2.2: Run failing test**

```bash
cd /Users/craftlabs/mcp/dexalot-trade-kit && pnpm --filter @dexalot/trade-core test:unit
```

Expected: FAIL.

- [ ] **Step 3.2.3: Update the handler**

In `packages/core/src/tools/market.ts`, replace the `client.tradeGet("candlechart/params", ...)` call with:

```ts
handler: async (args, { contract }) => {
  const sdk = await contract.get();
  const pair = requireString(args, "pair");
  const periodfrom = requireString(args, "periodfrom");
  const periodto = requireString(args, "periodto");
  const intervalnum = readNumber(args, "intervalnum");
  const intervalstr = requireString(args, "intervalstr");
  if (intervalnum === undefined) throw new ValidationError("intervalnum is required");
  const data = contract.unwrap(
    await sdk.getCandles(pair, periodfrom, periodto, intervalnum, intervalstr),
    "market.getCandles",
  );
  return { endpoint: "SDK getCandles", requestTime: new Date().toISOString(), data };
},
```

(Match the exact signature `sdk.getCandles` exposes — verify with `grep getCandles node_modules/@dexalot/dexalot-sdk/dist/core/transfer.d.ts` or wherever it lives.)

- [ ] **Step 3.2.4: Verify all tests pass**

```bash
pnpm --filter @dexalot/trade-core test:unit
```

- [ ] **Step 3.2.5: Live smoke against devnet**

```bash
pnpm build && node packages/cli/dist/index.js market get-candles --pair ALOT/USDC --periodfrom 2026-05-24 --periodto 2026-05-25 --intervalnum 1 --intervalstr hours --network devnet | head -20
```

Expected: real candles returned. If 400/error, the SDK signature differs from what we wrote — adjust.

- [ ] **Step 3.2.6: Commit**

```bash
git -C /Users/craftlabs/mcp/dexalot-trade-kit add packages/core/src/tools/market.ts packages/core/test/market.test.ts
git -C /Users/craftlabs/mcp/dexalot-trade-kit commit -m "feat(market): route get_candles through sdk.getCandles

The SDK already exposes getCandles; previously we routed through REST.
Closes one more REST gap per the SDK-first policy.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 3.3 — Route `analytics_get_24h_stats` through SDK

Same pattern as Task 3.2. Identify the analytics handler around line 119 of `packages/core/src/tools/analytics.ts`, write the test in `packages/core/test/analytics.test.ts`, then update the handler to call `sdk.get24hStats(...)`. Smoke + commit.

### Task 3.4 — (Optional) Route bulk balances through `getChainTokenBalances`

Check whether any tool in `packages/core/src/tools/portfolio.ts` does a manual multi-token loop that could collapse into one SDK call. If yes, refactor + test + smoke + commit. If no (and the existing per-chain methods already use the SDK), skip.

```bash
grep -n "balance" /Users/craftlabs/mcp/dexalot-trade-kit/packages/core/src/tools/portfolio.ts | head -20
```

### Task 3.5 — Update docs + push + PR

- [ ] **Step 3.5.1: Update `ARCHITECTURE.md` §5 (SDK boundary table)**

Move `market_get_candles` and `analytics_get_24h_stats` (and `portfolio` bulk balances if changed) from the "REST-only" table to the "SDK-native" table.

- [ ] **Step 3.5.2: Update `CLAUDE.md` SDK-boundary section** to match.

- [ ] **Step 3.5.3: Full build + test + commit**

```bash
cd /Users/craftlabs/mcp/dexalot-trade-kit && pnpm build && pnpm typecheck && pnpm test:unit
git -C /Users/craftlabs/mcp/dexalot-trade-kit add ARCHITECTURE.md CLAUDE.md
git -C /Users/craftlabs/mcp/dexalot-trade-kit commit -m "docs: move candles + 24h-stats to SDK-native column in §5 table"
```

- [ ] **Step 3.5.4: Push + PR**

```bash
git -C /Users/craftlabs/mcp/dexalot-trade-kit push -u origin feat/sdk-immediate-routings
gh pr create --repo dexalot/dexalot-trade-kit --title "feat: route candles + 24h-stats through SDK (already-available methods)" --body "Two more REST gaps closed using @dexalot/dexalot-sdk methods that already shipped. No SDK version bump needed."
```

---

# PHASE 4 — Trade-kit post-release routings (BLOCKED on SDK npm publish)

> **This phase cannot execute until Phase 1's PR is merged AND the SDK maintainer tags a new release (e.g. `v0.5.20`) AND that release is published to npm.** Document everything here so the future engineer can execute it cold without re-deriving design.

### Task 4.1 — Bump SDK dep version

Once the new SDK is on npm (check `npm view @dexalot/dexalot-sdk version`):

**Files:**
- Modify: `packages/core/package.json` — bump `@dexalot/dexalot-sdk` to the new version

- [ ] **Step 4.1.1: Update version**

In `packages/core/package.json`:
```json
"@dexalot/dexalot-sdk": "^0.5.20"  // or whatever the published version is
```

- [ ] **Step 4.1.2: Reinstall + verify build**

```bash
cd /Users/craftlabs/mcp/dexalot-trade-kit && pnpm install && pnpm build && pnpm typecheck && pnpm test:unit
```

### Task 4.2 — Route `clob_get_orders_by_account` to `sdk.getOrderHistory`

**Files:**
- Modify: `packages/core/src/tools/clob-read.ts`
- Modify: `packages/core/test/clob.test.ts`

Test stub additions:
```ts
getOrderHistory: async (...args: unknown[]) => {
  recorded.push({ method: "sdk.getOrderHistory", args });
  return { success: true, data: [] };
},
```

Handler update:
```ts
handler: async (args, { contract }) => {
  contract.requireWallet();
  const sdk = await contract.get();
  const a = asRecord(args);
  const account = readString(a, "account");
  const pair = readString(a, "pair");
  const status = readString(a, "status");
  const limit = readNumber(a, "limit");
  const offset = readNumber(a, "offset");
  const data = contract.unwrap(
    await sdk.getOrderHistory(account, { pair, status, limit, offset }),
    "clob.getOrderHistory",
  );
  return { endpoint: "SDK getOrderHistory", requestTime: new Date().toISOString(), data };
},
```

Live smoke (signed) + commit.

### Task 4.3 — Route the three portfolio USD-price tools to SDK

For each of `portfolio_get_token_usd_prices`, `portfolio_get_token_price_history`, `portfolio_get_token_hourly_price_history`:
1. Update test stub to mock the matching SDK method.
2. Replace REST handler with `await contract.get()` then `sdk.getTokenUsdPrices(env)` / `sdk.getTokenPriceHistory(token, {from, to})` / `sdk.getTokenHourlyPriceHistory(token, {from, to})`.
3. Live smoke (devnet).
4. Commit each.

### Task 4.4 — Route `transfer_get_combined_transfers` to SDK

Mirror Task 4.2 for the transfer handler at `packages/core/src/tools/transfer.ts`. Signed call. Smoke + commit.

### Task 4.5 — Route `market_get_deployed_contracts` to extended `sdk.getDeployment`

The existing trade-kit tool already supports env/contracttype/returnabi params. Update the handler to call `sdk.getDeployment({env, contractType, returnAbi})` instead of `client.tradeGet("deployment/params", ...)`. Test stub + handler swap + smoke + commit.

### Task 4.6 — Update ARCHITECTURE.md §5 table + CLAUDE.md

Move all five tools (orders-by-account → SDK getOrderHistory, the 3 USD-price tools, transfer combined, deployed-contracts with filters) from REST-only to SDK-native columns. Update CLAUDE.md SDK-boundary section to match.

### Task 4.7 — Full smoke + push + PR

```bash
cd /Users/craftlabs/mcp/dexalot-trade-kit
pnpm build && pnpm typecheck && pnpm test:unit
# Run devnet smoke on each newly-SDK-routed tool
git push -u origin feat/sdk-post-release-routings
gh pr create --title "feat: route 5 more tools through SDK @ v0.5.20+" --body "Depends on SDK release with gap-fill methods."
```

---

## Self-Review Notes

**Spec coverage check** (re-confirmed during plan authoring):
- ✓ Task 1.1 covers spec §5 (error preservation)
- ✓ Task 1.2 covers spec §4 (getDeployment filters)
- ✓ Task 1.3, 1.4 cover spec §2 (USD valuation)
- ✓ Task 1.5 covers spec §3 (combined transfers)
- ✓ Task 1.6 covers spec §1 (order history)
- ✓ Task 1.7 covers spec README section
- ✓ Phase 2 covers spec "Python parity backport notes"
- ✓ Phase 3 + 4 cover trade-kit consumer side (not in spec but explicit user request)

**Known soft references** (acceptable — implementer resolves at exec time):
- Exact REST paths for new endpoints (specified as best-known; implementer verifies against trade-kit's current REST handlers in the same step that's reading them).
- Exact `_normalizeOrder` helper name in `clob.ts` — implementer reuses whatever the SDK already has.
- Python equivalents of TS test helpers — implementer follows existing test patterns in each repo.

These are NOT "TBD" placeholders; the implementer has unambiguous instructions on where to look in each step.

---

## Execution dependency graph

```
Phase 1 (TS SDK, ~8 tasks) ──┬─→ Phase 2 (Python SDK, ~8 tasks)
                             │
                             └─→ [external: SDK maintainer tags + releases v0.5.20]
                                              │
                                              ↓
                                  Phase 4 (Trade-kit post-release, ~7 tasks)

Phase 3 (Trade-kit immediate, ~5 tasks) — parallel to all of the above, independent
```

**Recommended order if executed continuously:** Phase 3 → Phase 1 → Phase 2. Phase 3 ships value today regardless of SDK release; Phase 1 unblocks Phase 4; Phase 2 closes parity once Phase 1 stabilizes.

**Total tasks:** ~28 across all phases (8 + 8 + 5 + 7).
