# User Guide

End-to-end guide from installation to production usage of the Dexalot TypeScript SDK.

---

## Prerequisites & installation

**Node.js ≥ 20** is supported. CI matrices against Node 20, 22, and 24.

```bash
pnpm add @dexalot/dexalot-sdk
# or: npm install @dexalot/dexalot-sdk
```

### Environment setup

Copy `env.example` to `.env` and fill in the required fields:

```bash
cp env.example .env
```

Minimum required fields for read-only access:

```bash
PARENTENV=fuji-multi   # testnet; use "production-multi" for mainnet
```

For signing transactions, add:

```bash
PRIVATE_KEY=0x...      # hex-encoded private key; cleared from config after Wallet construction
```

Prefer passing a pre-built `Signer` (from `ethers`) to the constructor instead of setting `PRIVATE_KEY` — this keeps the raw key out of the config entirely.

---

## Core concepts

### `Result<T>` — result-first operational API

Async operational methods return a `Result` object. Expected failures (network errors, validation errors, contract reverts) are returned as `Result.fail(...)`. Some configuration or programmer errors can still raise immediately, so always check `.success` before accessing `.data` on Result-returning calls:

```ts
const result = await client.getClobPairs();
if (result.success) {
    const pairs = result.data!;
} else {
    console.error(result.error);  // sanitized, human-readable
}
```

See [Error Handling](typescript-sdk-error-handling.md) for the full `Result<T>` reference.

### Async-first

All I/O methods return Promises. Use `await` from any async context. The SDK targets the Node.js event loop — no worker threads.

### Lifecycle: construct, initialize, close

```ts
import { DexalotClient } from '@dexalot/dexalot-sdk';

const client = new DexalotClient();
try {
    await client.initializeClient();
    const result = await client.getClobPairs();
    // ... use the client ...
} finally {
    await client.close();
}
```

`initializeClient()` fetches environments, tokens, deployments, RFQ pairs, and CLOB pairs in parallel — run it once before any trading or contract-dependent calls. `close()` shuts down the HTTP keep-alive pool and, if open, the WebSocket connection.

---

## Getting started

### List trading pairs and fetch an order book

```ts
import { DexalotClient } from '@dexalot/dexalot-sdk';

async function main() {
    const client = new DexalotClient();
    try {
        await client.initializeClient();

        const pairsResult = await client.getClobPairs();
        if (!pairsResult.success) {
            console.error(`Error: ${pairsResult.error}`);
            return;
        }

        for (const pair of Object.keys(client.pairs).slice(0, 5)) {
            console.log(pair);  // e.g. "ALOT/USDC"
        }

        const ob = await client.getOrderBook('ALOT/USDC');
        if (ob.success) {
            console.log('Best bid:', ob.data!.bids[0]);
            console.log('Best ask:', ob.data!.asks[0]);
        }
    } finally {
        await client.close();
    }
}

main();
```

### Read-only with explicit config

```ts
import { DexalotClient, createConfig } from '@dexalot/dexalot-sdk';

const config = createConfig({
    parentEnv: 'fuji-multi',
    logLevel: 'debug',
    cacheEnabled: false,
});

const client = new DexalotClient(config);
try {
    await client.initializeClient();
    const result = await client.getTokens();
} finally {
    await client.close();
}
```

---

## Trading — CLOB

### Place a limit order

```ts
import { DexalotClient, createConfig } from '@dexalot/dexalot-sdk';
import { Wallet } from 'ethers';

const signer = new Wallet('0x...');

const client = new DexalotClient(signer);
try {
    await client.initializeClient();
    const result = await client.addOrder({
        pair: 'ALOT/USDC',
        side: 'BUY',
        amount: 100.0,
        price: 0.15,
        type: 'LIMIT',
    });
    if (result.success) {
        console.log('Tx:', result.data!.txHash);
        console.log('Client order ID:', result.data!.clientOrderId);
    } else {
        console.error('Failed:', result.error);
    }
} finally {
    await client.close();
}
```

> **Precision note:** `amount` and `price` accept `number`, numeric `string`, `bigint`, and `Big.js` instances. The SDK converts to wei via Big.js — never float multiplication — so exact values like `2933.0` round-trip cleanly. Precision exceeding the pair's `base_display_decimals` / `quote_display_decimals` is **rejected** rather than silently rounded; pass `new Big('2.0')` or round explicitly. See the architecture doc's "Precision-safe arithmetic" section for the full contract.

### Cancel an order

```ts
const result = await client.cancelOrder('0xabc...');
if (result.success) {
    console.log('Cancelled. tx:', result.data!.txHash);
}
```

### Batch operations

Place multiple orders in one transaction:

```ts
const orders = [
    { pair: 'ALOT/USDC', side: 'BUY' as const, amount: 50.0, price: 0.14, type: 'LIMIT' as const },
    { pair: 'ALOT/USDC', side: 'BUY' as const, amount: 75.0, price: 0.13, type: 'LIMIT' as const },
];
const result = await client.addLimitOrderList(orders);
```

Atomic cancel-and-replace (`cancelAddList`):

```ts
const result = await client.cancelAddList([
    {
        order_id: '0xold...',
        pair: 'ALOT/USDC',
        side: 'BUY',
        amount: 100.0,
        price: 0.16,
    },
]);
if (result.success) {
    console.log('New client IDs:', result.data!.clientOrderIds);
    console.log('Cancelled client IDs:', result.data!.cancelledClientOrderIds);
}
```

### Query open orders

```ts
const result = await client.getOpenOrders('ALOT/USDC');
if (result.success) {
    for (const order of result.data!) {
        console.log(
            order.internalOrderId,
            order.clientOrderId,
            order.pair,
            order.side,
            order.type1,
            order.status,
            order.price,
            order.quantity,
            order.createBlock,
        );
    }
}
```

Order reads return the SDK's full canonical order shape with normalized identifiers and human-readable enum labels. Both the contract-backed path (`getOrder` / `getOrderByClientId`) and the REST-backed path (`getOpenOrders`) produce the same canonical fields with the same types.

### Get a specific order

```ts
const r1 = await client.getOrder('0xabc...');
const r2 = await client.getOrderByClientId('my-order-1');
```

---

## Market data — candles, ticker, snapshot

CLOB market-data helpers are read-only and require no signer. They wrap the public endpoints documented in [REST API](rest-api.md). Note: these live under `/api/...`, NOT `/privapi/...`.

### Historical candles (count-back)

`getCandles(pair, interval, limit)` returns up to `limit` OHLCV bars ending at "now", in chronological order. Allowed intervals: `'1m'`, `'5m'`, `'15m'`, `'30m'`, `'1h'`, `'4h'`, `'1d'`. Server caps `limit` at 500; the SDK rejects out-of-range values before any HTTP call.

```ts
const candles = await client.getCandles('AVAX/USDC', '1h', 100);
if (candles.success) {
    const last = candles.data![candles.data!.length - 1];
    console.log(`Latest 1h close: ${last.close}  (vol ${last.volume})`);
}
```

Each row carries `date`, `open`, `high`, `low`, `close`, `volume`, `quote_volume`, `change`.

### Per-pair 24h stats

```ts
const stats = await client.get24hStats('AVAX/USDC');
if (stats.success) {
    const s = stats.data!;
    console.log(`AVAX/USDC last=${s.close} Δ24h=${s.change} vol=${s.volume}`);
}
```

### Whole-exchange snapshot

```ts
const snap = await client.getMarketSnapshot();
if (snap.success) {
    const rows = snap.data!.market_snapshot;
    console.log(`${rows.length} pairs in snapshot`);
}
```

`get24hStats` filters the cached `getMarketSnapshot` envelope client-side, so calling it for many pairs in close succession costs at most one network round trip.

---

## Simple Swap — RFQ

The swap flow is: soft quote → firm quote → execute. See [Simple Swap](simple-swap.md) for protocol details and the corresponding `MainnetRFQ` contract semantics.

### Soft quote (indicative, no commitment)

```ts
const result = await client.getSwapSoftQuote('ALOT', 'USDC', 100.0);
if (result.success) {
    console.log('Indicative quote:', result.data);
}
```

### Firm quote (binding, starts a ~30 s expiry)

```ts
const result = await client.getSwapFirmQuote('ALOT', 'USDC', 100.0);
if (result.success) {
    const quote = result.data!;
    console.log('Firm quote ID:', quote.quoteId);
}
```

### Execute swap

```ts
const result = await client.executeRFQSwap(quote);
if (result.success) {
    console.log('Swap tx:', result.data!.txHash);
} else {
    // result.error includes tx hash + block + revert reason when the receipt reverts
    console.error('Swap failed:', result.error);
}
```

For native sells (e.g. AVAX → USDC), `msg.value` is computed from the quote's `takerAmount` automatically — the `MainnetRFQ` contract reverts otherwise. The SDK handles this internally; no caller action needed.

---

## Portfolio & transfers

### Check portfolio balances

```ts
const result = await client.getAllPortfolioBalances();
if (result.success) {
    for (const [token, balance] of Object.entries(result.data!)) {
        console.log(token, balance.total, balance.available);
    }
}
```

Single token:

```ts
const r = await client.getPortfolioBalance('USDC');
```

### Chain wallet balances

```ts
const all = await client.getAllChainWalletBalances();
```

For a known subset of tokens, `getChainTokenBalances` returns a flat `{symbol: balance}` map and errors if any requested token isn't available on the chain:

```ts
const result = await client.getChainTokenBalances(
    'Avalanche',
    ['AVAX', 'USDC', 'ALOT'],  // sorted+deduped internally, so cache key is order-insensitive
);
if (result.success) {
    for (const [symbol, balance] of Object.entries(result.data!)) {
        console.log(`${symbol}: ${balance}`);
    }
}
```

### Deposit

```ts
const result = await client.deposit('USDC', 100.0, 'Avalanche');
if (result.success) {
    console.log('Deposit tx:', result.data!.txHash);
}
```

### Withdraw

```ts
const result = await client.withdraw('USDC', 50.0, 'Avalanche');
```

### Add / remove gas

```ts
await client.addGas(0.1);     // deposit native ALOT to the wallet
await client.removeGas(0.05); // withdraw native ALOT back into the portfolio
```

### Estimate bridge fee

```ts
const result = await client.getDepositBridgeFee('USDC', 100.0, 'Avalanche');
```

---

## Real-time events — WebSocket

The WebSocket manager is opt-in via `wsManagerEnabled: true` in the config. `subscribeToEvents()` takes a topic string and a callback; it throws if the manager is disabled.

```ts
import { DexalotClient, createConfig } from '@dexalot/dexalot-sdk';
import { Wallet } from 'ethers';

const signer = new Wallet('0x...');
const config = createConfig({ wsManagerEnabled: true });
const client = new DexalotClient(config);
client.signer = signer;

try {
    await client.initializeClient();

    await client.subscribeToEvents(
        'OrderBook/ALOT/USDC',
        (event) => {
            console.log(event.type, event);
        },
        false,  // isPrivate
    );

    // Keep running
    await new Promise((r) => setTimeout(r, 60_000));

    client.unsubscribeFromEvents('OrderBook/ALOT/USDC');
} finally {
    await client.close();
}
```

Callbacks run on the event loop and may `await` normally.

See [WebSocket Protocol](websocket.md) for the full event schema.

---

## Configuration deep-dive

All options can be set via `createConfig({...})`, environment variables, or a `.env` file. Constructor arguments take precedence.

| Category | Key options |
|---|---|
| Environment | `parentEnv` (`PARENTENV`): `'fuji-multi'` / `'production-multi'` |
| Signer | Pass `new Wallet(...)` directly, or set `PRIVATE_KEY` |
| Cache | `cacheEnabled`, `cacheTtlStatic/SemiStatic/Balance/Orderbook` |
| Retry | `retryEnabled`, `retryMaxAttempts`, `retryInitialDelay`, `retryMaxDelay` |
| Rate limit | `rateLimitEnabled`, `rateLimitRequestsPerSecond`, `rateLimitRpcPerSecond` |
| WebSocket | `wsManagerEnabled`, `wsPingInterval`, `wsReconnectMaxAttempts` |
| Logging | `logLevel` (`'debug'` / `'info'` / …), `logFormat` (`'console'` / `'json'`) |
| RPC | `DEXALOT_RPC_<CHAIN_ID>=url1,url2` overrides |

See [API Reference](typescript-sdk-reference.md#dexalotconfig) for the full field table.

### Disable caching for debugging

```ts
const client = new DexalotClient(createConfig({ cacheEnabled: false }));
```

### Use mainnet

```ts
const client = new DexalotClient(createConfig({ parentEnv: 'production-multi' }));
```

### Tune retry behavior

```ts
const config = createConfig({
    retryMaxAttempts: 5,
    retryInitialDelay: 0.5,
    retryMaxDelay: 30.0,
});
```

---

## Secrets vault

The secrets vault stores sensitive values (private keys, tokens) in a Fernet-encrypted local file at `~/.dexalot/secrets_vault.json` (overridable via `DEXALOT_SECRETS_VAULT_PATH`). The file uses the **shared Dexalot JSON vault format** so the Python SDK, TypeScript SDK, and MCP server can read the same encrypted store. The file is created with owner-only permissions (0o600). Values are encrypted at rest; only key names are stored in plaintext.

### One-time setup (CLI)

```bash
# 1. Generate an encryption key and save it in a password manager
pnpm exec secrets-vault keygen

# 2. Store your private key
pnpm exec secrets-vault add PRIVATE_KEY 0xabc123...

# 3. Verify
pnpm exec secrets-vault list
pnpm exec secrets-vault get PRIVATE_KEY
```

### Providing the vault key at runtime

| Method | How |
|---|---|
| Environment variable | `DEXALOT_SECRETS_VAULT_KEY=<key>` — for containers and CI |
| Interactive prompt | Leave the env var unset; the CLI prompts at startup |
| Neither | SDK falls back to `PRIVATE_KEY` (if set), otherwise read-only mode |

### Using the vault in code

The vault helpers live on the `/secrets-vault` subpath because they pull in `node:fs` and `node:crypto` (not browser-safe):

```ts
import {
    generateSecretsVaultKey,
    secretsVaultGet,
    secretsVaultSet,
    secretsVaultList,
    secretsVaultRemove,
} from '@dexalot/dexalot-sdk/secrets-vault';

const key = generateSecretsVaultKey();    // generate once, save safely
secretsVaultSet('~/.dexalot/secrets_vault.json', 'PRIVATE_KEY', '0x...', key);

const result = secretsVaultGet('~/.dexalot/secrets_vault.json', 'PRIVATE_KEY', key);
if (result.success) {
    const privateKey = result.data!;
}
```

### Safe practices

- **Never** commit the vault key or your `.env` file to version control.
- Store the vault key in a password manager or secrets manager (1Password, AWS Secrets Manager, HashiCorp Vault, etc.).
- The vault file itself is safe to back up — it is encrypted and useless without the key.
- Prefer the secrets-vault flow over `PRIVATE_KEY=...` in `.env` for anything beyond a local throwaway key.

---

## Error handling best practices

1. **Always check `.success`** before accessing `.data`.
2. **Use `result.error`** to log failures; it is already sanitized for production.
3. **Enable `debug` logging** locally to get full context including stack traces and raw error messages.
4. **Use `getRevertReason()`** to translate on-chain revert codes to human-readable descriptions.

```ts
import { configureLogging } from '@dexalot/dexalot-sdk';
configureLogging('debug', 'console');
```

See [Error Handling](typescript-sdk-error-handling.md) for a full debugging checklist and common error table.

---

## Recommended patterns

### Try/finally around the client

```ts
const client = new DexalotClient(signer);
try {
    await client.initializeClient();
    // ... use the client ...
} finally {
    await client.close();
}
```

### Long-running services — periodic reinitialize

For services that run for hours, call `reinitialize()` periodically to refresh auth tokens, RPC providers, and cache state:

```ts
async function runForever(client: DexalotClient) {
    while (true) {
        await client.reinitialize();
        await new Promise((r) => setTimeout(r, 3600 * 1000));  // every hour
    }
}
```

### Unit conversion

```ts
import { DexalotClient } from '@dexalot/dexalot-sdk';

// Human-readable → atomic (wei)
const atomic = DexalotClient.unitConversion('1.5', 18);   // '1500000000000000000'

// Atomic → human-readable
const human = DexalotClient.unitConversion('1000000', 6, false);  // '1.0'
```

For precision-exact arithmetic at the application level, use the `toWei` / `fromWei` helpers exported from `@dexalot/dexalot-sdk`:

```ts
import { toWei, fromWei } from '@dexalot/dexalot-sdk';

const wei = toWei('1.5', 18);          // 1500000000000000000n
const display = fromWei(wei, 18);      // Big('1.5')
```

### Structured logging (production)

```ts
import { configureLogging } from '@dexalot/dexalot-sdk';
configureLogging('info', 'json');
```

JSON format emits one log line per event with `level`, `message`, `timestamp`, and structured fields — pipe to a log aggregator (Datadog, Loki, ELK).

### Request-ID scoping for distributed tracing

```ts
import { withRequestId } from '@dexalot/dexalot-sdk';

await withRequestId('order-flow-42', async () => {
    const result = await client.addOrder({ ... });
    // every log line emitted inside this callback carries requestId='order-flow-42'
});
```

Use this to thread a logical operation ID through nested calls; filter logs by `requestId` to see one operation's trace across all SDK internals.
