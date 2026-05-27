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

