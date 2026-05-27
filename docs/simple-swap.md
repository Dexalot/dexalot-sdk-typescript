# Simple Swap Integration

## What is Simple Swap

Dexalot provides the Simple Swap flow to make trading easier. Using Simple Swap a user requests a **firm quote** from the Dexalot quote service — a signed trade commitment for a specific trader address with a short expiry. Using the signature, the trader executes the trade by calling `simpleSwap` on the `MainnetRFQ` contract on the connected chain (e.g. Avalanche C-Chain), swapping the promised assets in a single contract invocation.

> **Warning:** Requesting a firm quote allocates liquidity to your address for a limited time. The service blacklists requesters who pull many quotes without executing them. Only request a firm quote when you intend to execute.

## Integration Steps

1. Fetch Simple Swap-enabled pairs and metadata.
2. (Optional) Fetch the `MainnetRFQ` contract address and ABI.
3. (Optional) Request a soft quote (`pairprice`) for the approximate price.
4. Request a firm quote — committed amounts plus an EIP-712 signature.
5. Execute the trade via `simpleSwap`.

The SDK wraps steps 1-5 in three calls: `getSwapSoftQuote`, `getSwapFirmQuote`, and `executeRFQSwap`. The sections below show the SDK happy path **and** the raw REST/contract details if you need to integrate at a lower level.

### Using the SDK

```ts
import { DexalotClient } from '@dexalot/dexalot-sdk';
import { Wallet } from 'ethers';

const signer = new Wallet('0x...');
const client = new DexalotClient(signer);

await client.initializeClient();

// 1. (Optional) soft quote — indicative, no commitment
const soft = await client.getSwapSoftQuote('AVAX', 'USDC', 1.0);
if (soft.success) console.log('Indicative price:', soft.data);

// 2. Firm quote — binding, ~30s expiry
const firm = await client.getSwapFirmQuote('AVAX', 'USDC', 1.0);
if (!firm.success) {
    console.error('Firm quote failed:', firm.error);
    return;
}

// 3. Execute — SDK computes msg.value automatically for native sells,
//    applies gas-buffer, and surfaces revert reason on failure.
const result = await client.executeRFQSwap(firm.data!);
if (result.success) {
    console.log('Swap tx:', result.data!.txHash);
} else {
    // result.error is shaped:
    // "Transaction reverted: tx=0x..., block=N, reason=RF-EXP-01"
    console.error('Swap failed:', result.error);
}
```

That's the complete flow. The sections below show the underlying REST and contract details for integrators not using the SDK.

---

### 1. Fetch Trade Pairs

API (GET):

```
https://api.dexalot.com/api/rfq/pairs
```

| Field | Required | Sample |
|---|---|---|
| `chainid` | Y | `43114` |

Example request:

```bash
curl --location 'https://api.dexalot.com/api/rfq/pairs?chainid=43114' \
    --header 'x-apikey: API_KEY'
```

Response excerpt:

```json
{
    "AVAX/USDC": {
        "base": "AVAX",
        "quote": "USDC",
        "liquidityUSD": 10000,
        "baseAddress": "0x0000000000000000000000000000000000000000",
        "quoteAddress": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        "baseDecimals": 18,
        "quoteDecimals": 6
    }
}
```

The quote provider only signs firm quotes for pairs returned by this endpoint. `baseAddress` / `quoteAddress` are the ERC-20 contract addresses; `0x0000...0000` indicates the chain's native coin.

### 2. Fetch MainnetRFQ Contract Details (optional)

API (GET):

```
https://api.dexalot.com/privapi/trading/deployment?returnabi=true&contracttype=MainnetRFQ
```

Example response:

```json
[
    {
        "parentenv": "production-multi",
        "env": "production-multi-mainnet",
        "env_type": "mainnet",
        "contract_name": "MainnetRFQ",
        "contract_type": "MainnetRFQ",
        "address": "0xEed3c159F3A96aB8d41c8B9cA49EE1e5071A7cdD",
        "impl_address": "0x386bd3aAbB04A5FD140B8e032b51E927E9bB9614",
        "version": "1.0.3",
        "owner": "0xbFD53904e0A0c02eFB7e76aad7FfB1F476320038",
        "status": "deployed",
        "abi": { }
    }
]
```

You need the contract address and ABI for the contract call in step 5.

### 3a. Request Soft Quote (optional)

For approximate prices. Include `x-apikey` to receive any channel-specific pricing.

```
GET https://api.dexalot.com/api/rfq/pairprice
```

| Field | Required | Sample |
|---|---|---|
| `chainid` | Y | `43114` |
| `pair` | Y | `AVAX/USDC` |
| `amount` | Y | Quote-input amount (in `base` or `quote` units, see `isbase`) |
| `isbase` | Y | `0` (amount in quote units) / `1` (amount in base units) |
| `side` | Y | `0` to buy base, `1` to sell base |
| `channel` | N | Pre-registered channel identifier |

Example:

```bash
curl 'https://api.dexalot.com/api/rfq/pairprice?chainid=43114&pair=AVAX/USDC&amount=120&side=1&isbase=1' \
    --header 'x-apikey: API_KEY'
```

Success:

```json
{
    "success": true,
    "pair": "AVAX/USDC",
    "side": 1,
    "price": "10.215898650775",
    "baseAmount": "120",
    "quoteAmount": "1225.907838093"
}
```

Soft failure (HTTP 200 with `success: false` — the SDK detects this and returns `Result.fail`):

```json
{
    "success": false,
    "reasonCode": "SQ-003",
    "reason": "Not enough liquidity reserved to simpleswap for the given quantity"
}
```

### 3b. Request Batched Prices (optional)

Aggregator-style — returns a ladder of `(price, quoteAmount)` quotes per pair.

```
GET https://api.dexalot.com/api/rfq/prices
```

| Field | Required | Sample |
|---|---|---|
| `chainid` | Y | `43114` |
| `channel` | N | — |

Response shape:

```json
{
    "prices": {
        "AVAX/USDC": {
            "bids": [["9.778706198423064067", "1.000000"], ["..."]],
            "asks": [["9.782618067277720067", "1.000000"], ["..."]]
        }
    }
}
```

Entries are ordered by `quoteAmount`. The first entry is the minimum and the last is the maximum valid amount. To price an input amount `a`, binary-search through the ladder, find the bracketing entries, and interpolate. See the [Python doc's `calculateOrderPrice` reference implementation](https://github.com/Dexalot/dexalot-sdk-python/blob/main/docs/simple-swap.md#3b-request-batched-quotes-optional) for the full algorithm — the math is language-agnostic.

### 4. Request Firm Quote

> **Warning:** Frequently calling this endpoint without executing may cause the trader to be blacklisted.

Returns an EIP-712 signature plus the order tuple. The signature is valid only for the given trader address and expires after a short window.

| Field | Required | Sample |
|---|---|---|
| `chainid` | Y | `43114` |
| `takerAsset` | Y | ERC-20 address of the asset the trader is providing (source token) |
| `makerAsset` | Y | ERC-20 address of the asset the trader will receive (destination token) |
| `takerAmount` | N | For a sell swap: source amount in atomic units (`* 10^decimals`) |
| `makerAmount` | N | For a buy swap: destination amount in atomic units (`* 10^decimals`) |
| `userAddress` | Y | Trader address (NOT an executor contract) |
| `executor` | N | Executor contract address (if not provided, `userAddress` is the executor) |
| `slippage` | N | Aggregator slippage in basis points |
| `partner` | N | Partner identifier |
| `txType` | N | EVM tx type (1 for EIP-2930, 2 for EIP-1559) — when set, response includes a full tx object |

Either `takerAmount` (sell) or `makerAmount` (buy) must be supplied.

```
POST https://api.dexalot.com/api/rfq/firm
```

Request body:

```json
{
    "chainid": 43114,
    "takerAsset": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    "makerAsset": "0x0000000000000000000000000000000000000000",
    "takerAmount": "200000000",
    "userAddress": "0x05A1AAC00662ADda4Aa25E1FA658f4256ed881eD",
    "executor": "0xdef171fe48cf0115b1d80b88dc8eab59176fee57"
}
```

Response:

```json
{
    "order": {
        "nonceAndMeta": "0x05182E579FDfCf69E4390c3411D8FeA1fb6467cfc6f28e56b0daf00000000000",
        "expiry": 1694534360,
        "makerAsset": "0x0000000000000000000000000000000000000000",
        "takerAsset": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        "maker": "0xEed3c159F3A96aB8d41c8B9cA49EE1e5071A7cdD",
        "taker": "0x05A1AAC00662ADda4Aa25E1FA658f4256ed881eD",
        "makerAmount": "21483696748316475197",
        "takerAmount": "200000000"
    },
    "signature": "0xbdcd5728...",
    "tx": {
        "to": "0xEed3c159F3A96aB8d41c8B9cA49EE1e5071A7cdD",
        "data": "0x6c75d6f5...",
        "gasLimit": 120000
    }
}
```

The Dexalot RFQ wraps this in `{"success": true, "quote": {...}}`. The SDK unwraps the envelope automatically; if you're calling REST directly, look at `response.quote` to get the inner order/signature/tx fields.

### 5a. Execute Swap using `tx`

If the trader is an externally-owned account, sign and submit the `tx` object directly:

```ts
import { Wallet, JsonRpcProvider } from 'ethers';

const wallet = new Wallet('0x...', new JsonRpcProvider('https://api.avax.network/ext/bc/C/rpc'));
const tx = await wallet.sendTransaction(firmResponse.tx);
await tx.wait();
```

If the trader is a smart contract, the contract calls `MainnetRFQ` with `tx.to` as the target, `tx.value` (when present) as the value, and `tx.data` as calldata.

### 5b. Execute Swap Manually

Invoke `simpleSwap` on `MainnetRFQ` by passing the order tuple and signature:

```solidity
function simpleSwap(Order calldata _order, bytes calldata _signature) external payable;
```

`Order` struct:

```solidity
struct Order {
    uint256 nonceAndMeta;
    uint128 expiry;
    address makerAsset;
    address takerAsset;
    address maker;
    address taker;
    uint256 makerAmount;
    uint256 takerAmount;
}
```

Example order tuple with descriptions:

```ts
const order = {
    nonceAndMeta: '0x05A1AAC00662ADda4Aa25E1FA658f4256ed881eDf5a6f2600000000000',
    expiry: 1693940508,
    // destination token (USDC)
    makerAsset: '0x68B773B8C10F2ACE8aC51980A1548B6B48a2eC54',
    // source token — zero address means native AVAX
    takerAsset: '0x0000000000000000000000000000000000000000',
    // MainnetRFQ contract on the connected chain
    maker: '0x4C72Cd84BB81beD576B162A323f7842c863ab711',
    // trader / executor contract
    taker: '0x05A1AAC00662ADda4Aa25E1FA658f4256ed881eD',
    // destination amount
    makerAmount: '1021956420',
    // source amount
    takerAmount: '100000000000000000000',
};
```

> **`msg.value` requirement:** When `takerAsset` is the zero address (native sell), the call must send `msg.value == takerAmount`. For ERC-20 takers, `msg.value` must be 0. The SDK's `executeRFQSwap` computes this automatically; if you're calling the contract directly, you must set it yourself.
