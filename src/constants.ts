// Well-known Chain IDs (reference only, not restrictive - actual chains are discovered dynamically)
export const KNOWN_CHAIN_IDS = {
  AVAX_MAINNET: 43114,
  AVAX_FUJI: 43113,
} as const;

// Legacy alias for backward compatibility
export const CHAIN_ID = KNOWN_CHAIN_IDS;

// Environments
export const ENV = {
  PROD_MULTI_AVAX: "production-multi-avax",
  FUJI_MULTI_AVAX: "fuji-multi-avax",
  PROD_MULTI_SUBNET: "production-multi-subnet",
  FUJI_MULTI_SUBNET: "fuji-multi-subnet",
} as const;

// API URLs
export const API_URL = {
  MAINNET: "https://api.dexalot.com",
  TESTNET: "https://api.dexalot-test.com",
} as const;

/**
 * Build the Dexalot WebSocket URL from the REST API base URL.
 * See docs/websocket.md: wss://api.dexalot.com/api/ws
 */
export function wsApiUrlForRestBase(restApiBaseUrl?: string | null): string {
    const base = (restApiBaseUrl || API_URL.MAINNET).trim().replace(/\/+$/, '');
    if (base.startsWith('https://')) {
        const host = base.slice('https://'.length);
        return `wss://${host}/api/ws`;
    }
    if (base.startsWith('http://')) {
        const host = base.slice('http://'.length);
        return `ws://${host}/api/ws`;
    }
    throw new Error(`Unsupported REST API base URL for WebSocket: ${restApiBaseUrl}`);
}

/** Default WebSocket URL (mainnet). Prefer wsApiUrlForRestBase(client.apiBaseUrl). */
export const WS_API_URL = wsApiUrlForRestBase(API_URL.MAINNET);

// API Endpoints
export const ENDPOINTS = {
  TRADING_PAIRS: "/privapi/trading/pairs",
  TRADING_ENVIRONMENTS: "/privapi/trading/environments",
  TRADING_TOKENS: "/privapi/trading/tokens",
  TRADING_DEPLOYMENT: "/privapi/trading/deployment",
  SIGNED_ORDERS: "/privapi/signed/orders",
  RFQ_PAIRS: "/api/rfq/pairs",
  RFQ_FIRM_QUOTE: "/api/rfq/firmQuote",
  RFQ_PAIR_PRICE: "/api/rfq/pairprice",
} as const;

// Default Values
export const DEFAULTS = {
  DECIMALS: 18,
  ZERO_ADDRESS: "0x0000000000000000000000000000000000000000",
  // Vitalik's address as placeholder
  TAKER_ADDRESS: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  GAS_BUFFER: 1.2,
} as const;

// Bridge Constants
export const ACCESS_ID = {
  LZ: 0,
  ICM: 2,
} as const;

export const ICM_CHAINS = ["Avalanche", "Fuji"];
