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
  base_display_decimals?: number;
  quote_display_decimals?: number;
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

export interface SwapQuote {
    pair: string;
    side: number;
    price: number;
    amount: number;
    quoteId?: string;
    expiry?: number;
    signature?: string;
    success?: boolean;
    reason?: string;
    chainId?: number;
    secureQuote?: {
        signature?: string;
        data?: any;
        order?: any;
    };
    // ... other RFQ fields
}

