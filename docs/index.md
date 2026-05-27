# Dexalot TypeScript SDK

TypeScript SDK for the [Dexalot](https://dexalot.com) decentralized exchange. Supports limit-order trading (CLOB), RFQ-based simple swaps, portfolio management, and real-time WebSocket event streaming. Maintained as the TypeScript counterpart to [dexalot-sdk-python](https://github.com/Dexalot/dexalot-sdk-python); the two SDKs are kept at functional parity.

---

## Quick start

```ts
import { DexalotClient } from '@dexalot/dexalot-sdk';

async function main() {
    const client = new DexalotClient();
    try {
        await client.initializeClient();
        const result = await client.getClobPairs();
        if (result.success) {
            for (const pair of result.data!) {
                console.log(pair.pair);
            }
        }
    } finally {
        await client.close();
    }
}

main();
```

Install:

```bash
pnpm add @dexalot/dexalot-sdk
# or: npm install @dexalot/dexalot-sdk
```

---

## Documentation

| Section | Description |
|---|---|
| [User Guide](typescript-sdk-user-guide.md) | Installation, concepts, end-to-end usage, secrets vault setup |
| [API Reference](typescript-sdk-reference.md) | Module layout, class inheritance, and the public surface |
| [Error Handling](typescript-sdk-error-handling.md) | `Result<T>` pattern, revert reasons, debugging |
| [Architecture](typescript-sdk-architecture.md) | Internals — caching, async model, rate limiting, nonce management |
| [Caching Guide](sdk-caching.md) | Cache tiers, TTL tuning, invalidation |
| [WebSocket Protocol](websocket.md) | WebSocket message format and event types |
| [REST API](rest-api.md) | Underlying REST API endpoints |
| [Simple Swap](simple-swap.md) | RFQ swap flow and quote lifecycle |
| [Security & Reliability Review](sdk-security-reliability-review.md) | TS-specific posture review notes |

---

## Key features

- **Result-first async API** — async operational methods return `Result<T>` (`{ success, data, error }`) for expected failures; construction and validation paths may still throw on programmer errors.
- **Async-first** — built on Node's event loop; explicit `client.close()` for shutdown.
- **4-tier cache** — static, semi-static, balance, and orderbook tiers as module-level singletons with stampede-protection and `apiBaseUrl` namespacing.
- **WebSocket events** — subscribe to live order, trade, and balance updates via `subscribeToEvents`.
- **Multi-provider RPC** — automatic failover across configured RPC endpoints with cooldown-based health tracking.
- **Rate limiting** — per-instance independent-sleep rate limiters for API and RPC calls.
- **Error sanitization** — strips file paths, RPC URLs, and stack traces from user-facing errors; use `logLevel: 'debug'` locally to see full context.
- **Precision-safe arithmetic** — every amount and price goes through Big.js (`toWei` / `fromWei`); no float-multiplication shortcuts on write paths.

---

## Version

See `package.json` for the current release. Node ≥ 20 required (`engines.node >= 20`); CI matrices against Node 20, 22, and 24.
