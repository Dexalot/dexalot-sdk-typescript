# Web Socket Interface

## Server URLs

Testnet: [wss://api.dexalot-test.com/api/ws](wss://api.dexalot-test.com/api/ws)

Mainnet: [wss://api.dexalot.com/api/ws](wss://api.dexalot.com/api/ws)

You may create up to 10 simultaneous WebSocket connections from the same IP address anonymously. (You do not need to follow the next steps.)

If you need more simultaneous connections, token authorization is required to establish the WebSocket connections.

In order to create a WebSocket connection with your API key:

1. A WebSocket connection token will be requested via the `auth/getws` endpoint (see [REST API](rest-api.md) for details). This endpoint requires an API key and provides you a temporary token (valid for 60 seconds). Request the API key from the Dexalot team.
2. Initiate a WebSocket connection against the Dexalot backend using this token:
   `wss://api.dexalot-dev.com/api/ws?wstoken=ff0d8450-3e86-49ff-91fb-37156615c6ee`
3. If your token expires you can request a new one using step 1.

> When using the SDK's `WebSocketManager` (via `subscribeToEvents`), the token plumbing is handled for you — you only need to enable `wsManagerEnabled: true` and have a valid signer if you intend to subscribe to private (authenticated) topics.

## WebSocket subscribe / unsubscribe

> Always unsubscribe whenever it's architecturally sound — keeping idle subscriptions open wastes both client and server resources.

```ts
export enum SUBSCRIPTION {
    subscribe = 'subscribe',
    unsubscribe = 'unsubscribe',
    chartsubscribe = 'chartsubscribe',
    chartunsubscribe = 'chartunsubscribe',
    marketSnapshotSubscribe = 'marketsnapshotsubscribe',
    marketSnapshotUnsubscribe = 'marketsnapshotunsubscribe',
    traderEventSubscribe = 'tradereventsubscribe',
    traderEventUnsubscribe = 'tradereventunsubscribe',
}
```

## Sample code — subscribe / unsubscribe via raw WebSocket

If you're talking to the Dexalot WebSocket directly (without the SDK):

```ts
function subscribe(socket: WebSocket, pair: string, decimal: number, traderAddress?: string) {
    const msg: any = {
        data: pair,
        pair,
        decimal,
        type: SUBSCRIPTION.subscribe,
    };
    if (traderAddress) msg.traderaddress = traderAddress;
    socket.send(JSON.stringify(msg));
}
```

Example pair subscribe message:

```json
{ "data": "ALOT/USDC", "pair": "ALOT/USDC", "type": "subscribe", "decimal": 3 }
```

Example trader-event subscribe message:

```json
{ "type": "tradereventsubscribe", "signature": "0xXXXX...:0xXXXX..." }
```

To generate the signature, use the auth pattern documented in the REST API's "Signed Endpoints" section.

Sample chart subscribe:

```ts
function chartSubscribe(socket: WebSocket, pair: string, chart: 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1', traderAddress?: string) {
    const msg: any = {
        data: pair,
        pair,
        chart,
        type: SUBSCRIPTION.chartsubscribe,
    };
    if (traderAddress) msg.traderaddress = traderAddress;
    socket.send(JSON.stringify(msg));
}
```

Example chart subscribe message:

```json
{ "data": "ALOT/USDC", "pair": "ALOT/USDC", "chart": "D1", "type": "chartsubscribe" }
```

Possible `chart` values: `"M5"`, `"M15"`, `"M30"`, `"H1"`, `"H4"`, `"D1"`.

## Using the SDK's WebSocketManager

The SDK wraps the raw WebSocket with `WebSocketManager`, which handles authentication, ping/pong heartbeats, exponential-backoff reconnection, and topic-level subscription routing. Enable it with `wsManagerEnabled: true` in the config:

```ts
import { DexalotClient, createConfig } from '@dexalot/dexalot-sdk';

const config = createConfig({ wsManagerEnabled: true });
const client = new DexalotClient(config);

await client.initializeClient();

await client.subscribeToEvents(
    'OrderBook/ALOT/USDC',
    (message) => {
        const buys = (message?.data?.buyBook ?? []).length;
        const sells = (message?.data?.sellBook ?? []).length;
        console.log(`Orderbook: ${buys} bids / ${sells} asks`);
    },
    false,  // isPrivate
);

// later
client.unsubscribeFromEvents('OrderBook/ALOT/USDC');
await client.closeWebsocket();
```

The third argument (`isPrivate`) routes the subscription through the signed-token authentication path. Private topics (`Orders`, `Execution`, trader-scoped events) require a configured signer.

## Message types published by the server

```ts
export type SOCKET_DATA_TYPES =
    | 'orderBooks'
    | 'lastTrade'
    | 'marketSnapShot'
    | 'chartSnapShot'
    | 'Prices'
    | 'APP_VERSION'
    | 'auctionData'
    | 'orderStatusUpdatEvent'
    | 'transactionEvent'
    | 'executionEvent'
    | 'xChainFinalizedEvent';
```

## ChartSnapShot

```ts
export interface WsRawChartSnapshot {
    data: CandleDataRaw[] | CandleDataRaw;
    type: string;
    pair: string;
}

export interface CandleDataRaw {
    open: string;
    close: string;
    high: string;
    low: string;
    change: string;
    date: string;
    volume: string;
}
```

## OrderBooks

OrderBooks can also be accessed directly from the blockchain. The WebSocket interface has an inherent small delay compared to on-chain state.

```ts
export interface WsRawOrderbookData {
    data: WsOrderbookData;
    pair: string;
    decimal: number;
    type: string;
}

export interface WsOrderbookData {
    buyBook: WsSinglebook[];
    sellBook: WsSinglebook[];
}

export interface WsSinglebook {
    prices: string;
    quantities: string;
    baseCumulative?: string;
    quoteCumulative?: string;
    quoteTotal?: string;
}
```

## MarketSnapShot

```ts
export interface MarketsSnapData {
    change: string;
    close: string;
    date: string;
    high: string;
    low: string;
    open: string;
    pair: string;
    volume: string;
}
```

## Prices

```ts
export interface WsPricesData {
    base: string;
    baseinUsd: string;
    last: string;
    pair: string;
    quote: string;
    quoteinUsd: string;
}
```

## APP_VERSION

Backend application version. Useful for clients that need to surface a compatibility warning when the deployed backend changes.

## LastTrade

```ts
export interface WsRawTradeHistory {
    data: WsTradeHistoryData[];
    pair: string;
    type: string;
}

export interface WsTradeHistoryData {
    execId?: number;
    price: string;
    quantity: string;
    takerside?: number;
    ts: string;
}
```

## OrderStatusUpdateEvent (Trader Event)

After subscribing to `tradereventsubscribe`, this is the captured order-status update for the trader address tied to the signature.

> **Note:** WebSocket event payloads are forwarded as-is from the Dexalot server and use the server's own field names (`orderId`, `clientOrderId`, etc.). These are transport events, **not** canonical SDK order objects — they do not carry the SDK's full normalized order shape returned by `getOpenOrders`, `getOrder`, and related methods (e.g. `tradePairId`, `createBlock`, `updateBlock`). The SDK does not transform WebSocket payloads.

```ts
export interface OrderStatusUpdateEvent {
    version: number;
    traderaddress: string;
    pair: string;
    orderId: string;
    clientOrderId: string;
    price: string;
    totalamount: string;
    quantity: string;
    side: string;
    sideId: number;
    type1: string;
    type1Id: number;
    type2: string;
    type2Id: number;
    status: string;
    statusId: number;
    quantityfilled: string;
    totalfee: string;
    code: string;
    blockTimestamp: number;
    transactionHash: string;
    blockNumber: number;
    blockHash: string;
}
```

- `side`: `"BUY"` | `"SELL"`
- `type1`: `"MARKET"` | `"LIMIT"` | `"STOP"` | `"STOPLIMIT"`
- `type2`: `"GTC"` | `"FOK"` | `"IOC"` | `"PO"`
- `status`: `"NEW"` | `"REJECTED"` | `"PARTIAL"` | `"FILLED"` | `"CANCELED"` | `"EXPIRED"` | `"KILLED"`

Sample message:

```json
{
    "data": {
        "version": 2,
        "traderaddress": "0xe05451d9832dCc72B81c78B7FD54fbcFbE0188d2",
        "pair": "ALOT/USDC",
        "orderId": "0x0000000000000000000000000000000000000000000000000000000062c14ea5",
        "clientOrderId": "0xa58c4cda60b24090351735047828ff51f50207414d4251fda901875f673dff9f",
        "price": "0.1678",
        "totalamount": "5.2018",
        "quantity": "31.0",
        "side": "BUY",
        "sideId": 0,
        "type1": "LIMIT",
        "type1Id": 1,
        "type2": "GTC",
        "type2Id": 0,
        "status": "CANCELED",
        "statusId": 4,
        "quantityfilled": "31.0",
        "totalfee": "0.06",
        "code": "",
        "blockTimestamp": 1686331589,
        "transactionHash": "0xfae4f026245cae47da7a9c12a9043f5ac94d2b8a230d2fc21c3547149b21c494",
        "blockNumber": 920114,
        "blockHash": "0x1c812b9fa7138525f682c430c22d431637f8ebb09694b65e34a4bdec9583adc9"
    },
    "type": "orderStatusUpdateEvent"
}
```

## TransactionEvent (Trader Event)

After subscribing to trader events, the captured transaction event for the trader address provided in the signature.

```ts
export interface TransactionEvent {
    contract: string;
    address: string;
    available: string;
    feeCharged: string;
    quantity: string;
    symbol: string;
    total: string;
    transaction: string;
    transactionId: number;
    blockTimestamp: number;
    transactionHash: string;
    blockNumber: number;
    blockHash: string;
    chainId: number;
    env: string;
}
```

Sample:

```json
{
    "data": {
        "contract": "0xe4afb5deta47602fa1e6e641a645147c4ff06205",
        "address": "0xe0545559a82xCc72B81cY8B7FD543bcFbE0518d2",
        "available": "2199.49",
        "feeCharged": "0.0",
        "quantity": "1.0",
        "symbol": "ALOT",
        "total": "2199.49",
        "transaction": "IXFERSENT",
        "transactionId": 5,
        "blockNumber": 1400304,
        "blockTimestamp": 1716480179,
        "blockHash": "0x40669bf4f60d543caf28ee99204d0c31181019eebe6c73b9729eca9e2ae523a8",
        "transactionHash": "0x209ab1617deedbaa6e0e67042aff9a193218bc90e8c98d0b69dabf7afe81813f",
        "chainId": 432201,
        "env": "fuji-multi-subnet"
    },
    "type": "transactionEvent"
}
```

## ExecutionEvent (Trader Event)

```ts
export interface ExecutionEvent {
    version: number;
    pair: string;
    price: string;
    quantity: string;
    makerOrder: string;
    takerOrder: string;
    feeMaker: string;
    feeTaker: string;
    takerSide: string;
    takerSideId: number;
    execId: number;
    addressMaker: string;
    addressTaker: string;
    blockTimestamp: number;
    transactionHash: string;
    blockNumber: number;
    blockHash: string;
}
```

## XChainFinalizedEvent (Trader Event)

Emitted when a cross-chain swap is finalized.

```ts
export interface XChainFinalizedEvent {
    nonceAndMeta: string;
    trader: string;
    symbol: string;
    amount: string;
    timestamp: number;
    blockNumber: number;
    blockTimestamp: number;
    blockHash: string;
    transactionHash: string;
    takerSideId: number;
    env: string;
    chainId: number;
}
```
