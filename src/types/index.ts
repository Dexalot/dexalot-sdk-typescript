export enum OrderSide {
  BUY = 0,
  SELL = 1,
}

export enum OrderType {
  MARKET = 0,
  LIMIT = 1,
}

export enum OrderStatus {
  FILLED = 0,
  CANCELED = 1,
  PARTIAL = 2,
  NEW = 3,
  REJECTED = 4,
  EXPIRED = 5,
  KILLED = 6,
}

export interface Pair {
  pair: string;
  base: string; // address
  quote: string; // address
  base_decimals: number;
  quote_decimals: number;
  // Required: pairs missing display decimals are dropped at ingest with a
  // logged warning rather than silently defaulted, because the trading
  // contract enforces these and a wrong default produces a T-TMDQ-01
  // rejection downstream.
  base_display_decimals: number;
  quote_display_decimals: number;
  min_trade_amount: number;
  max_trade_amount: number;
  tradePairId: string; // bytes32 hex
}

export interface OrderRequest {
  pair: string;
  side: 'BUY' | 'SELL';
  amount: number; // Display units
  price?: number; // Display units, required for LIMIT
  type?: 'LIMIT' | 'MARKET';
}

export interface Order {
  internalOrderId: string; // bytes32 hex
  clientOrderId: string; // bytes32 hex
  tradePairId: string; // bytes32 hex
  pair: string;
  price: number; // Display units
  totalAmount: number; // Display units
  quantity: number; // Display units
  quantityFilled: number; // Display units
  totalFee: number; // Display units
  traderAddress: string;
  side: 'BUY' | 'SELL' | string;
  type1: 'MARKET' | 'LIMIT' | 'STOP' | 'STOPLIMIT' | string;
  type2: 'GTC' | 'FOK' | 'IOC' | 'PO' | string;
  status: 'NEW' | 'REJECTED' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'KILLED' | string;
  updateBlock: number | null;
  createBlock: number | null;
  createTs: string | null;
  updateTs: string | null;
  tx?: string | null;
}

export interface OrderBookEntry {
    price: number;
    quantity: number;
}

/**
 * Single USD price observation in a price-history series.
 *
 * Returned by `getTokenPriceHistory` (daily) and
 * `getTokenHourlyPriceHistory` (hourly). The backend's raw shape
 * (`{ date: ISO-string, price: stringified-number }`, descending by
 * date) is normalized to ascending unix-seconds + numeric price so
 * callers can chart, filter, or interpolate without re-parsing.
 */
export interface PricePoint {
    /** Observation time as unix seconds (UTC). */
    timestamp: number;
    /** USD price at the observation. */
    price: number;
}

/**
 * OHLCV row returned by `getCandles` and embedded in `MarketSnapshot.market_snapshot`.
 * Numeric fields arrive as strings from the backend so callers can decide whether
 * to keep precision (`Big`/`string`) or convert to `number`.
 */
export interface Candle {
    pair?: string;
    date: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    quote_volume: string;
    change: string;
}

/**
 * Envelope returned by `getMarketSnapshot`: per-pair 24h OHLCV rows plus
 * exchange-wide totals.
 */
export interface MarketSnapshot {
    market_snapshot: Candle[];
    totals: Record<string, unknown>;
    last24: Record<string, unknown>;
}

/**
 * One row of unified transfer history returned by `getCombinedTransfers`.
 *
 * The backend's raw shape under `/api/trading/signed/transferscombined`
 * is `{ count: number, rows: DBTransfer[] }`, where each row uses
 * snake_case fields and numeric enums:
 *
 *   - `status` is a numeric enum (0=COMPLETED, 1=INFLIGHT, 2=DELAYED)
 *   - `action_type` is a numeric enum
 *     (0=WITHDRAWN, 1=DEPOSITED, 5=SENT, 6=RECEIVED, 7=RECOVERED,
 *      8=ADD_GAS, 9=REMOVE_GAS, 10=AUTO_FILL,
 *      11=WITHDRAW_PENDING, 12=DEPOSIT_PENDING)
 *   - `bridge` is a numeric enum (-1=NATIVE, 0=LAYER0, 1=CELER, 2=ICM)
 *   - `quantity` and `fee` arrive as already-display-decimal numeric
 *     strings (NOT wei). The official frontend reads them straight
 *     through Big.js without any decimals divide — there is no
 *     wei→human conversion to apply.
 *   - `source_*` and `target_*` describe the from-chain and to-chain
 *     legs; `target_*` is null for transfers that never cross
 *     (e.g. portfolio-internal sends and gas top-ups).
 *
 * The SDK normalises to camelCase, lifts the numeric enums to
 * human-readable strings, and keeps `quantity`/`fee` as `number`
 * (parsed from the Big-string) and `nonce` as `number`. The
 * `source_ts` / `target_ts` legs (emitted by the backend as ISO-8601
 * strings) are coerced to unix **seconds** (UTC) numbers — `sourceTs`
 * is always present (`0` when missing) and `targetTs` is `null` when
 * there is no target leg. Raw fields are dropped — callers should
 * never need to look at the original snake_case keys.
 */
export type TransferStatus = 'COMPLETED' | 'INFLIGHT' | 'DELAYED';

export type TransferActionType =
    | 'WITHDRAWN'
    | 'DEPOSITED'
    | 'SENT'
    | 'RECEIVED'
    | 'RECOVERED'
    | 'ADD_GAS'
    | 'REMOVE_GAS'
    | 'AUTO_FILL'
    | 'WITHDRAW_PENDING'
    | 'DEPOSIT_PENDING';

export type TransferBridge = 'NATIVE' | 'LAYER0' | 'CELER' | 'ICM';

export interface Transfer {
    /** Human-readable action type lifted from the numeric `action_type` enum. */
    actionType: TransferActionType;
    /** Human-readable status lifted from the numeric `status` enum. */
    status: TransferStatus;
    /** Token symbol (canonical Dexalot subnet symbol, e.g. "ALOT", "USDC"). */
    symbol: string;
    /** Quantity in display units (already decoded by the backend). */
    quantity: number;
    /** Fee in display units (already decoded by the backend). */
    fee: number;
    /** Wallet address that owns this transfer row. */
    traderAddress: string;
    /** Bridge transport ("NATIVE" for portfolio-internal/gas legs). */
    bridge: TransferBridge;
    /** Optional explorer/bridge-page URL surfaced by the backend (may be empty). */
    bridgeUrl: string;
    /** Cross-chain message nonce; -1 for legs that don't use a bridge. */
    nonce: number;
    /** Source environment label (e.g. "subnet", "fuji-multi-avax"). */
    sourceEnv: string;
    /** Source chain id (numeric EVM chain id). */
    sourceChainId: number;
    /** Source-leg tx hash. */
    sourceTx: string;
    /** Source-leg time as unix seconds (UTC). */
    sourceTs: number;
    /** Target environment label, or null for transfers that never cross. */
    targetEnv: string | null;
    /** Target chain id, or null for transfers that never cross. */
    targetChainId: number | null;
    /** Target-leg tx hash, or null when no target leg exists. */
    targetTx: string | null;
    /** Target-leg time as unix seconds (UTC), or null when no target leg exists. */
    targetTs: number | null;
}

export interface OrderBook {
    pair: string;
    bids: OrderBookEntry[];
    asks: OrderBookEntry[];
}

export interface TokenInfo {
    address: string;
    symbol: string;
    name: string;
    decimals: number; // 'evmdecimals'
    chainId: number;
    env: string;
}

export interface DeploymentInfo {
    address: string;
    abi: any[];
}

export interface ChainConfig {
    chain_id: number;
    rpc?: string;
    explorer?: string;
    native_symbol?: string;
    env?: string; // e.g., "fuji-multi-avax"
}

export interface TokenBalance {
    total: number;
    available: number;
    locked: number;
}

/**
 * Firm quote returned by the Dexalot RFQ backend.
 *
 * The HTTP response wraps the executable quote inside
 * `{"success": true, "quote": {...}}`; `_transformQuoteFromAPI` unwraps
 * that envelope so callers always see the inner shape with `signature`
 * and `order` at the top level (matching the contract's call surface).
 * Envelope-layer failures (`{"success": false, "reason": "..."}`) are
 * surfaced as `Result.fail` from the swap-quote helpers and never reach this type.
 */
export interface SwapQuote {
    pair: string;
    side: number;
    price: number;
    amount: number;
    quoteId?: string;
    expiry?: number;
    /** EIP-712 signature for the firm quote, used as the second `simpleSwap` arg. */
    signature?: string;
    /** Executable RFQ order tuple keyed by snake_case+camelCase aliases. */
    order?: {
        nonceAndMeta?: string | number | bigint;
        nonce_and_meta?: string | number | bigint;
        expiry?: number | string;
        makerAsset?: string;
        maker_asset?: string;
        takerAsset?: string;
        taker_asset?: string;
        maker?: string;
        taker?: string;
        makerAmount?: string | number | bigint;
        maker_amount?: string | number | bigint;
        takerAmount?: string | number | bigint;
        taker_amount?: string | number | bigint;
        [key: string]: unknown;
    };
    /** Mirrors the envelope `tx` field when the backend supplies a preflight tx hint. */
    tx?: unknown;
    chainId?: number;
    /** Soft-quote / failure-envelope leftovers retained for backwards inspection. */
    success?: boolean;
    reason?: string;
    [key: string]: unknown;
}

