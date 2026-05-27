# Error Handling

The SDK uses a `Result<T>` return type for its async operational methods. Expected failure conditions (network errors, validation failures, contract reverts) are returned as `Result.fail(...)`, while some configuration or programmer errors can still raise immediately. This guide covers the full error model, debugging workflow, and common errors.

---

## `Result<T>` in depth

Every async operational SDK method returns a `Result` instance with three fields:

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | `true` if the operation succeeded |
| `data` | `T \| null` | The return value on success; `null` on failure |
| `error` | `string \| null` | Human-readable error message on failure; `null` on success |

```ts
const result = await client.addOrder({
    pair: 'ALOT/USDC',
    side: 'BUY',
    amount: 100.0,
    price: 0.15,
    type: 'LIMIT',
});

if (result.success) {
    const txHash = result.data!.txHash;
} else {
    console.error(result.error);
}
```

**Type narrowing:** TypeScript narrows `result.data` to non-null inside the `if (result.success)` branch — no `!` needed if you're using strict mode (the example above uses `!` for clarity; in normal code, the narrowing is automatic).

**Factory methods** (used internally; useful when building wrappers):

```ts
const ok = Result.ok({ key: 'value' });        // { success: true, data: {...}, error: null }
const failed = Result.fail('Token not found'); // { success: false, data: null, error: '...' }
```

**Generic type parameter** — `result.data` is typed as `T` when `success === true`:

```ts
const result: Result<Order[]> = await client.getOpenOrders({ pair: 'ALOT/USDC' });
if (result.success) {
    const orders = result.data;  // Order[]
}
```

---

## Failure categories

### 1. Input validation

Caught before any network call. Common causes:

- Empty or malformed pair symbol (`'ALOT'` instead of `'ALOT/USDC'`)
- Quantity or price ≤ 0
- Invalid side value
- Missing signer for write operations
- Display-precision violation (e.g. `amount: 0.123` on a pair with `base_display_decimals: 2`)

```ts
const result = await client.addOrder({
    pair: 'ALOT/USDC',
    side: 'BUY',
    amount: 100.0,
    price: -1.0,
    type: 'LIMIT',
});
// result.success === false
// result.error === 'price must be positive, got -1'
```

### 2. Network / HTTP errors

Returned when the REST API is unreachable, returns a non-200 status, or the request times out. Retry logic (if enabled) runs before the final failure is returned.

```ts
const result = await client.getClobPairs();
// result.success === false
// result.error === 'HTTP 503: service unavailable'  (sanitized)
```

### 3. Blockchain / contract reverts

Returned when a submitted transaction reverts on-chain. Where possible the SDK surfaces the tx hash, block number, and decoded revert reason in the error string.

```ts
const result = await client.executeRFQSwap(quote);
// result.success === false
// result.error === 'Transaction reverted: tx=0xabc..., block=12345, reason=RF-EXP-01'
```

For RFQ swaps specifically, `swap.ts` replays the failed transaction as `eth_call` at the reverting block to extract the `execution reverted: X` reason. The replay is best-effort — if the node can't replay, the `reason=` segment is omitted.

---

## Revert reasons

`client.getRevertReason(errorMsg)` maps known Dexalot error codes (`T-*`, `P-*`, `RF-*`, etc.) to human-readable descriptions:

```ts
const raw = 'execution reverted: T-TMDQ-01';
const description = client.getRevertReason(raw);
// → 'T-TMDQ-01: Trade amount precision exceeded display decimals'
```

If no matching code is found, the original message is returned unchanged. Use this to log user-facing messages from failed transactions:

```ts
const result = await client.addOrder({ ... });
if (!result.success) {
    const reason = client.getRevertReason(result.error!);
    console.error(`Order failed: ${reason}`);
}
```

---

## Error sanitization

In production the SDK strips sensitive context from error messages before returning them:

- File paths (e.g. `/home/user/app/client.ts:42`)
- Stack traces
- Raw RPC URLs
- Internal library error details

This prevents accidental exposure of infrastructure details in logs or API responses.

**What gets returned instead:** a concise, user-facing description, e.g. `'network error'` instead of the full stack trace with connection details.

**Locally**, enable `'debug'` log level to see the full unsanitized context in logs:

```ts
import { configureLogging } from '@dexalot/dexalot-sdk';
configureLogging('debug', 'console');
```

At `debug` level, the logger emits full exception details with stack traces before sanitization. `result.error` is still sanitized — the raw context is only in the log output.

---

## Debugging checklist

When an operation fails unexpectedly:

1. **Enable debug logging** to see full error context:
   ```ts
   import { configureLogging } from '@dexalot/dexalot-sdk';
   configureLogging('debug', 'console');
   ```

2. **Disable cache** to rule out stale data:
   ```ts
   import { DexalotClient, createConfig } from '@dexalot/dexalot-sdk';
   const client = new DexalotClient(createConfig({ cacheEnabled: false }));
   ```

3. **Use testnet** (`PARENTENV=fuji-multi`) to avoid real-money risk while debugging.

4. **Inspect `.error`** — the sanitized message usually gives enough context even in production.

5. **Call `getRevertReason()`** on transaction failures to decode on-chain error codes.

6. **Add a `requestId`** to scope logs from a logical operation:
   ```ts
   import { withRequestId } from '@dexalot/dexalot-sdk';
   await withRequestId('checkout-tx-42', async () => {
       const result = await client.addOrder({ ... });
       // every log line emitted during this scope carries requestId=checkout-tx-42
   });
   ```

---

## Common errors

| Error message (approx.) | Likely cause | Fix |
|---|---|---|
| `'Signer required for ...'` | Write operation called without a signer | Set `PRIVATE_KEY` env var, or pass a `Signer` directly to the constructor |
| `'Pair X/Y not found'` | Invalid trading pair symbol | Check `getClobPairs()` for valid symbols (pairs missing display decimals are dropped at ingest) |
| `'Insufficient available balance'` | Portfolio balance too low for the trade | Check `getPortfolioBalance()` first |
| `'price must be positive'` | `price <= 0` passed to `addOrder` | Validate price before calling |
| `'... has more than N decimals'` | Display-precision violation | Round to the pair's `base_display_decimals` / `quote_display_decimals` before calling |
| `'Trade notional ... below min_trade_amount'` | Order notional too small | Check `pair.min_trade_amount`; reduce or increase notional accordingly |
| `'HTTP 401'` | Auth header invalid or expired | Call `reinitialize()` to refresh auth |
| `'HTTP 429'` | Rate limit exceeded server-side | Lower `rateLimitRequestsPerSecond`, add backoff |
| `'fetching ...'` | Sanitized network error | Check network; retry logic runs automatically if enabled |
| `'Insecure RPC URL(s) rejected'` | Plain `http://` RPC at provider setup | Use `https://` or set `allowInsecureRpc: true` for local dev |
| `'Cannot execute failed quote: ...'` | Soft failure envelope (`{success: false}`) from the RFQ backend | Re-fetch a fresh quote |
| `'Transaction reverted: tx=..., block=..., reason=...'` | On-chain revert | Decode the reason via `getRevertReason()` |
