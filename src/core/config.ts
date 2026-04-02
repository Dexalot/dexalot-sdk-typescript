/**
 * Centralized configuration for DexalotClient.
 * Matches Python SDK's DexalotConfig implementation.
 */

import { API_URL } from '../constants.js';

/**
 * Configuration interface for DexalotClient.
 */
export interface DexalotConfig {
    // Environment
    /** Environment name (default: "fuji-multi") */
    parentEnv: string;
    /** API base URL (auto-detected from parentEnv if not set) */
    apiBaseUrl?: string;
    /** Private key for transaction signing (optional) */
    privateKey?: string;

    // Connection
    /** Connection pool limit (default: 100) */
    connectionPoolLimit: number;
    /** Connection pool limit per host (default: 30) */
    connectionPoolLimitPerHost: number;

    // Timeouts (in milliseconds)
    /** Connect timeout in ms (default: 5000) */
    timeoutConnect: number;
    /** Read timeout in ms (default: 30000) */
    timeoutRead: number;

    // Cache
    /** Enable caching (default: true) */
    cacheEnabled: boolean;
    /** TTL for static data in seconds (default: 3600) */
    cacheTtlStatic: number;
    /** TTL for semi-static data in seconds (default: 900) */
    cacheTtlSemiStatic: number;
    /** TTL for balance data in seconds (default: 10) */
    cacheTtlBalance: number;
    /** TTL for orderbook data in seconds (default: 1) */
    cacheTtlOrderbook: number;

    // Logging
    /** Log level (default: "info") */
    logLevel: string;
    /** Log format: "console" or "json" (default: "console") */
    logFormat: string;

    // Retry
    /** Enable retry mechanism (default: true) */
    retryEnabled: boolean;
    /** Maximum retry attempts (default: 3) */
    retryMaxAttempts: number;
    /** Initial retry delay in ms (default: 1000) */
    retryInitialDelay: number;
    /** Maximum retry delay in ms (default: 10000) */
    retryMaxDelay: number;
    /** Exponential backoff base (default: 2.0) */
    retryExponentialBase: number;
    /** HTTP status codes to retry on (default: [429, 500, 502, 503, 504]) */
    retryOnStatus: number[];

    // Rate Limiting
    /** Enable rate limiting (default: true) */
    rateLimitEnabled: boolean;
    /** API requests per second (default: 5.0) */
    rateLimitRequestsPerSecond: number;
    /** RPC calls per second (default: 10.0) */
    rateLimitRpcPerSecond: number;

    // Nonce Manager
    /** Enable nonce manager for transaction ordering (default: true) */
    nonceManagerEnabled: boolean;

    // WebSocket
    /** Enable WebSocket manager for persistent connections (default: false) */
    wsManagerEnabled: boolean;
    /** WebSocket ping interval in seconds (default: 30) */
    wsPingInterval: number;
    /** WebSocket ping timeout in seconds (default: 10) */
    wsPingTimeout: number;
    /** Initial reconnect delay in ms (default: 1000) */
    wsReconnectInitialDelay: number;
    /** Maximum reconnect delay in ms (default: 60000) */
    wsReconnectMaxDelay: number;
    /** Reconnect exponential base (default: 2.0) */
    wsReconnectExponentialBase: number;
    /** Maximum reconnection attempts, 0 = infinite (default: 10) */
    wsReconnectMaxAttempts: number;

    // Provider Failover
    /** Enable provider failover (default: true) */
    providerFailoverEnabled: boolean;
    /** Cooldown in ms before retrying failed provider (default: 60000) */
    providerFailoverCooldown: number;
    /** Max failures before marking provider unhealthy (default: 3) */
    providerFailoverMaxFailures: number;

    // New v0.5.7 fields
    /** Enable timestamp-based authentication signatures (default: false) */
    timestampedAuth: boolean;
    /** Clock skew compensation for WebSocket in ms (default: 0) */
    wsTimeOffsetMs: number;
    /** Max concurrent ERC20 balanceOf RPC calls (default: 10) */
    erc20BalanceConcurrency: number;
    /** Allow http:// RPC URLs (default: false) */
    allowInsecureRpc: boolean;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: DexalotConfig = {
    // Environment
    parentEnv: 'fuji-multi',
    apiBaseUrl: undefined,
    privateKey: undefined,

    // Connection
    connectionPoolLimit: 100,
    connectionPoolLimitPerHost: 30,

    // Timeouts
    timeoutConnect: 5000,
    timeoutRead: 30000,

    // Cache
    cacheEnabled: true,
    cacheTtlStatic: 3600,
    cacheTtlSemiStatic: 900,
    cacheTtlBalance: 10,
    cacheTtlOrderbook: 1,

    // Logging
    logLevel: 'info',
    logFormat: 'console',

    // Retry
    retryEnabled: true,
    retryMaxAttempts: 3,
    retryInitialDelay: 1000,
    retryMaxDelay: 10000,
    retryExponentialBase: 2.0,
    retryOnStatus: [429, 500, 502, 503, 504],

    // Rate Limiting
    rateLimitEnabled: true,
    rateLimitRequestsPerSecond: 5.0,
    rateLimitRpcPerSecond: 10.0,

    // Nonce Manager
    nonceManagerEnabled: true,

    // WebSocket
    wsManagerEnabled: false,
    wsPingInterval: 30,
    wsPingTimeout: 10,
    wsReconnectInitialDelay: 1000,
    wsReconnectMaxDelay: 60000,
    wsReconnectExponentialBase: 2.0,
    wsReconnectMaxAttempts: 10,

    // Provider Failover
    providerFailoverEnabled: true,
    providerFailoverCooldown: 60000,
    providerFailoverMaxFailures: 3,

    // New v0.5.7 fields
    timestampedAuth: false,
    wsTimeOffsetMs: 0,
    erc20BalanceConcurrency: 10,
    allowInsecureRpc: false,
};

/**
 * Create a configuration object with defaults and optional overrides.
 * 
 * @param overrides - Configuration values to override defaults
 * @returns Complete configuration object
 */
export function createConfig(overrides?: Partial<DexalotConfig>): DexalotConfig {
    const config = { ...DEFAULT_CONFIG, ...overrides };

    // Auto-detect API URL if not provided
    if (!config.apiBaseUrl) {
        config.apiBaseUrl = config.parentEnv.toLowerCase().includes('fuji')
            ? API_URL.TESTNET
            : API_URL.MAINNET;
    }

    // Strip trailing slash from API URL
    if (config.apiBaseUrl.endsWith('/')) {
        config.apiBaseUrl = config.apiBaseUrl.slice(0, -1);
    }

    // Validate configuration
    validateConfig(config);

    return config;
}

/**
 * Load configuration from environment variables.
 * 
 * Environment variables:
 * - PARENTENV: Environment name
 * - PRIVATE_KEY: Private key for signing
 * - API_BASE_URL_TESTNET / API_BASE_URL_MAINNET: Override API URLs
 * - DEXALOT_*: Various configuration options
 * 
 * @param overrides - Override values that take precedence over env vars
 * @returns Complete configuration object
 */
export function loadConfigFromEnv(overrides?: Partial<DexalotConfig>): DexalotConfig {
    const envConfig: Partial<DexalotConfig> = {};

    // Helper functions
    const getEnvBool = (key: string): boolean | undefined => {
        const val = process.env[key];
        if (val === undefined) return undefined;
        return val.toLowerCase() === 'true' || val === '1';
    };

    const getEnvInt = (key: string): number | undefined => {
        const val = process.env[key];
        if (val === undefined) return undefined;
        const num = parseInt(val, 10);
        return isNaN(num) ? undefined : num;
    };

    const getEnvFloat = (key: string): number | undefined => {
        const val = process.env[key];
        if (val === undefined) return undefined;
        const num = parseFloat(val);
        return isNaN(num) ? undefined : num;
    };

    // Environment
    if (process.env.PARENTENV) {
        envConfig.parentEnv = process.env.PARENTENV;
    }
    if (process.env.PRIVATE_KEY) {
        envConfig.privateKey = process.env.PRIVATE_KEY;
    }

    // Cache
    const cacheEnabled = getEnvBool('DEXALOT_ENABLE_CACHE');
    if (cacheEnabled !== undefined) envConfig.cacheEnabled = cacheEnabled;
    
    const cacheTtlStatic = getEnvInt('DEXALOT_CACHE_TTL_STATIC');
    if (cacheTtlStatic !== undefined) envConfig.cacheTtlStatic = cacheTtlStatic;
    
    const cacheTtlSemiStatic = getEnvInt('DEXALOT_CACHE_TTL_SEMI_STATIC');
    if (cacheTtlSemiStatic !== undefined) envConfig.cacheTtlSemiStatic = cacheTtlSemiStatic;
    
    const cacheTtlBalance = getEnvInt('DEXALOT_CACHE_TTL_BALANCE');
    if (cacheTtlBalance !== undefined) envConfig.cacheTtlBalance = cacheTtlBalance;
    
    const cacheTtlOrderbook = getEnvInt('DEXALOT_CACHE_TTL_ORDERBOOK');
    if (cacheTtlOrderbook !== undefined) envConfig.cacheTtlOrderbook = cacheTtlOrderbook;

    // Logging
    if (process.env.DEXALOT_LOG_LEVEL) {
        envConfig.logLevel = process.env.DEXALOT_LOG_LEVEL;
    }
    if (process.env.DEXALOT_LOG_FORMAT) {
        envConfig.logFormat = process.env.DEXALOT_LOG_FORMAT;
    }

    // Retry
    const retryEnabled = getEnvBool('DEXALOT_RETRY_ENABLED');
    if (retryEnabled !== undefined) envConfig.retryEnabled = retryEnabled;
    
    const retryMaxAttempts = getEnvInt('DEXALOT_RETRY_MAX_ATTEMPTS');
    if (retryMaxAttempts !== undefined) envConfig.retryMaxAttempts = retryMaxAttempts;
    
    const retryInitialDelay = getEnvFloat('DEXALOT_RETRY_INITIAL_DELAY');
    if (retryInitialDelay !== undefined) envConfig.retryInitialDelay = retryInitialDelay;
    
    const retryMaxDelay = getEnvFloat('DEXALOT_RETRY_MAX_DELAY');
    if (retryMaxDelay !== undefined) envConfig.retryMaxDelay = retryMaxDelay;

    // Rate Limiting
    const rateLimitEnabled = getEnvBool('DEXALOT_RATE_LIMIT_ENABLED');
    if (rateLimitEnabled !== undefined) envConfig.rateLimitEnabled = rateLimitEnabled;
    
    const rateLimitRequestsPerSecond = getEnvFloat('DEXALOT_RATE_LIMIT_REQUESTS_PER_SECOND');
    if (rateLimitRequestsPerSecond !== undefined) {
        envConfig.rateLimitRequestsPerSecond = rateLimitRequestsPerSecond;
    }
    
    const rateLimitRpcPerSecond = getEnvFloat('DEXALOT_RATE_LIMIT_RPC_PER_SECOND');
    if (rateLimitRpcPerSecond !== undefined) {
        envConfig.rateLimitRpcPerSecond = rateLimitRpcPerSecond;
    }

    // Nonce Manager
    const nonceManagerEnabled = getEnvBool('DEXALOT_NONCE_MANAGER_ENABLED');
    if (nonceManagerEnabled !== undefined) envConfig.nonceManagerEnabled = nonceManagerEnabled;

    // Connection Pool
    const connectionPoolLimit = getEnvInt('DEXALOT_CONNECTION_POOL_LIMIT');
    if (connectionPoolLimit !== undefined) envConfig.connectionPoolLimit = connectionPoolLimit;
    
    const connectionPoolLimitPerHost = getEnvInt('DEXALOT_CONNECTION_POOL_LIMIT_PER_HOST');
    if (connectionPoolLimitPerHost !== undefined) {
        envConfig.connectionPoolLimitPerHost = connectionPoolLimitPerHost;
    }

    // WebSocket
    const wsManagerEnabled = getEnvBool('DEXALOT_WS_MANAGER_ENABLED');
    if (wsManagerEnabled !== undefined) envConfig.wsManagerEnabled = wsManagerEnabled;
    
    const wsPingInterval = getEnvInt('DEXALOT_WS_PING_INTERVAL');
    if (wsPingInterval !== undefined) envConfig.wsPingInterval = wsPingInterval;
    
    const wsPingTimeout = getEnvInt('DEXALOT_WS_PING_TIMEOUT');
    if (wsPingTimeout !== undefined) envConfig.wsPingTimeout = wsPingTimeout;
    
    const wsReconnectInitialDelay = getEnvFloat('DEXALOT_WS_RECONNECT_INITIAL_DELAY');
    if (wsReconnectInitialDelay !== undefined) {
        envConfig.wsReconnectInitialDelay = wsReconnectInitialDelay;
    }
    
    const wsReconnectMaxDelay = getEnvFloat('DEXALOT_WS_RECONNECT_MAX_DELAY');
    if (wsReconnectMaxDelay !== undefined) envConfig.wsReconnectMaxDelay = wsReconnectMaxDelay;
    
    const wsReconnectExponentialBase = getEnvFloat('DEXALOT_WS_RECONNECT_EXPONENTIAL_BASE');
    if (wsReconnectExponentialBase !== undefined) {
        envConfig.wsReconnectExponentialBase = wsReconnectExponentialBase;
    }
    
    const wsReconnectMaxAttempts = getEnvInt('DEXALOT_WS_RECONNECT_MAX_ATTEMPTS');
    if (wsReconnectMaxAttempts !== undefined) {
        envConfig.wsReconnectMaxAttempts = wsReconnectMaxAttempts;
    }

    // Provider Failover
    const providerFailoverEnabled = getEnvBool('DEXALOT_PROVIDER_FAILOVER_ENABLED');
    if (providerFailoverEnabled !== undefined) {
        envConfig.providerFailoverEnabled = providerFailoverEnabled;
    }
    
    const providerFailoverCooldown = getEnvInt('DEXALOT_PROVIDER_FAILOVER_COOLDOWN');
    if (providerFailoverCooldown !== undefined) {
        envConfig.providerFailoverCooldown = providerFailoverCooldown;
    }
    
    const providerFailoverMaxFailures = getEnvInt('DEXALOT_PROVIDER_FAILOVER_MAX_FAILURES');
    if (providerFailoverMaxFailures !== undefined) {
        envConfig.providerFailoverMaxFailures = providerFailoverMaxFailures;
    }

    // New v0.5.7 env vars
    const timestampedAuth = getEnvBool('DEXALOT_TIMESTAMPED_AUTH');
    if (timestampedAuth !== undefined) envConfig.timestampedAuth = timestampedAuth;

    const wsTimeOffsetMs = getEnvInt('DEXALOT_WS_TIME_OFFSET_MS');
    if (wsTimeOffsetMs !== undefined) envConfig.wsTimeOffsetMs = wsTimeOffsetMs;

    const erc20BalanceConcurrency = getEnvInt('DEXALOT_ERC20_BALANCE_CONCURRENCY');
    if (erc20BalanceConcurrency !== undefined) envConfig.erc20BalanceConcurrency = erc20BalanceConcurrency;

    const allowInsecureRpc = getEnvBool('DEXALOT_ALLOW_INSECURE_RPC');
    if (allowInsecureRpc !== undefined) envConfig.allowInsecureRpc = allowInsecureRpc;

    // Create config with env values, then apply overrides
    return createConfig({ ...envConfig, ...overrides });
}

/**
 * Validate a configuration object.
 * 
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateConfig(config: DexalotConfig): void {
    // Validate parentEnv
    if (!config.parentEnv || config.parentEnv.trim() === '') {
        throw new Error('parentEnv cannot be empty');
    }
    
    // Validate API base URL format
    if (config.apiBaseUrl && config.apiBaseUrl.endsWith('/')) {
        throw new Error('apiBaseUrl must not end with a trailing slash');
    }

    // Validate private key format if provided
    if (config.privateKey) {
        if (!config.privateKey.startsWith('0x')) {
            throw new Error('privateKey must start with "0x"');
        }
        if (config.privateKey.length !== 66) {
            throw new Error(
                `privateKey must be 66 characters (including "0x"), got ${config.privateKey.length}`
            );
        }
    }

    // Validate retry settings
    if (config.retryMaxAttempts < 1) {
        throw new Error('retryMaxAttempts must be at least 1');
    }
    if (config.retryInitialDelay < 0) {
        throw new Error('retryInitialDelay must be non-negative');
    }
    if (config.retryMaxDelay < config.retryInitialDelay) {
        throw new Error('retryMaxDelay must be >= retryInitialDelay');
    }
    if (config.retryExponentialBase < 1.0) {
        throw new Error('retryExponentialBase must be >= 1.0');
    }

    // Validate rate limit settings
    if (config.rateLimitRequestsPerSecond <= 0) {
        throw new Error('rateLimitRequestsPerSecond must be positive');
    }
    if (config.rateLimitRpcPerSecond <= 0) {
        throw new Error('rateLimitRpcPerSecond must be positive');
    }

    // Validate connection pool settings
    if (config.connectionPoolLimit < 1) {
        throw new Error('connectionPoolLimit must be at least 1');
    }
    if (config.connectionPoolLimitPerHost < 1) {
        throw new Error('connectionPoolLimitPerHost must be at least 1');
    }
    if (config.connectionPoolLimitPerHost > config.connectionPoolLimit) {
        throw new Error('connectionPoolLimitPerHost must be <= connectionPoolLimit');
    }

    // Validate WebSocket settings
    if (config.wsPingInterval < 1) {
        throw new Error('wsPingInterval must be at least 1');
    }
    if (config.wsPingTimeout < 1) {
        throw new Error('wsPingTimeout must be at least 1');
    }
    if (config.wsReconnectInitialDelay < 0) {
        throw new Error('wsReconnectInitialDelay must be non-negative');
    }
    if (config.wsReconnectMaxDelay < config.wsReconnectInitialDelay) {
        throw new Error('wsReconnectMaxDelay must be >= wsReconnectInitialDelay');
    }
    if (config.wsReconnectExponentialBase < 1.0) {
        throw new Error('wsReconnectExponentialBase must be >= 1.0');
    }
    if (config.wsReconnectMaxAttempts < 0) {
        throw new Error('wsReconnectMaxAttempts must be non-negative');
    }

    // Validate provider failover settings
    if (config.providerFailoverCooldown < 0) {
        throw new Error('providerFailoverCooldown must be non-negative');
    }
    if (config.providerFailoverMaxFailures < 1) {
        throw new Error('providerFailoverMaxFailures must be at least 1');
    }
    
    // Validate cache TTLs
    if (config.cacheTtlStatic < 0) {
        throw new Error('cacheTtlStatic must be non-negative');
    }
    if (config.cacheTtlSemiStatic < 0) {
        throw new Error('cacheTtlSemiStatic must be non-negative');
    }
    if (config.cacheTtlBalance < 0) {
        throw new Error('cacheTtlBalance must be non-negative');
    }
    if (config.cacheTtlOrderbook < 0) {
        throw new Error('cacheTtlOrderbook must be non-negative');
    }
}
