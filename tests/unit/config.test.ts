import { createConfig, loadConfigFromEnv, validateConfig, DexalotConfig } from '../../src/core/config';

describe('config', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('createConfig', () => {
        it('should create config with defaults', () => {
            const config = createConfig();
            
            expect(config.parentEnv).toBe('fuji-multi');
            expect(config.retryMaxAttempts).toBe(3);
            expect(config.rateLimitEnabled).toBe(true);
            expect(config.cacheEnabled).toBe(true);
        });

        it('should override defaults', () => {
            const config = createConfig({
                parentEnv: 'prod-multi',
                retryMaxAttempts: 5
            });
            
            expect(config.parentEnv).toBe('prod-multi');
            expect(config.retryMaxAttempts).toBe(5);
            expect(config.retryInitialDelay).toBe(1000); // Still default
        });

        it('should auto-detect testnet API URL', () => {
            const config = createConfig({ parentEnv: 'fuji-multi' });
            expect(config.apiBaseUrl).toBeDefined();
        });

        it('should auto-detect mainnet API URL', () => {
            const config = createConfig({ parentEnv: 'prod-multi' });
            expect(config.apiBaseUrl).toBeDefined();
        });

        it('should strip trailing slash from API URL', () => {
            const config = createConfig({
                apiBaseUrl: 'https://api.example.com/'
            });
            
            expect(config.apiBaseUrl).toBe('https://api.example.com');
        });

        it('should preserve API URL without trailing slash', () => {
            const config = createConfig({
                apiBaseUrl: 'https://api.example.com'
            });
            
            expect(config.apiBaseUrl).toBe('https://api.example.com');
        });
    });

    describe('loadConfigFromEnv', () => {
        it('should load parentEnv from PARENTENV', () => {
            process.env.PARENTENV = 'custom-env';
            const config = loadConfigFromEnv();
            
            expect(config.parentEnv).toBe('custom-env');
        });

        it('should load private key from PRIVATE_KEY', () => {
            process.env.PRIVATE_KEY = '0x1234567890123456789012345678901234567890123456789012345678901234';
            const config = loadConfigFromEnv();
            
            expect(config.privateKey).toBe('0x1234567890123456789012345678901234567890123456789012345678901234');
        });

        it('should load cache settings', () => {
            process.env.DEXALOT_ENABLE_CACHE = 'false';
            process.env.DEXALOT_CACHE_TTL_STATIC = '7200';
            process.env.DEXALOT_CACHE_TTL_SEMI_STATIC = '1800';
            process.env.DEXALOT_CACHE_TTL_BALANCE = '20';
            process.env.DEXALOT_CACHE_TTL_ORDERBOOK = '2';
            
            const config = loadConfigFromEnv();
            
            expect(config.cacheEnabled).toBe(false);
            expect(config.cacheTtlStatic).toBe(7200);
            expect(config.cacheTtlSemiStatic).toBe(1800);
            expect(config.cacheTtlBalance).toBe(20);
            expect(config.cacheTtlOrderbook).toBe(2);
        });

        it('should load logging settings', () => {
            process.env.DEXALOT_LOG_LEVEL = 'debug';
            process.env.DEXALOT_LOG_FORMAT = 'json';
            
            const config = loadConfigFromEnv();
            
            expect(config.logLevel).toBe('debug');
            expect(config.logFormat).toBe('json');
        });

        it('should load retry settings', () => {
            process.env.DEXALOT_RETRY_ENABLED = 'false';
            process.env.DEXALOT_RETRY_MAX_ATTEMPTS = '5';
            process.env.DEXALOT_RETRY_INITIAL_DELAY = '2000';
            process.env.DEXALOT_RETRY_MAX_DELAY = '20000';
            
            const config = loadConfigFromEnv();
            
            expect(config.retryEnabled).toBe(false);
            expect(config.retryMaxAttempts).toBe(5);
            expect(config.retryInitialDelay).toBe(2000);
            expect(config.retryMaxDelay).toBe(20000);
        });

        it('should load rate limit settings', () => {
            process.env.DEXALOT_RATE_LIMIT_ENABLED = 'false';
            process.env.DEXALOT_RATE_LIMIT_REQUESTS_PER_SECOND = '10';
            process.env.DEXALOT_RATE_LIMIT_RPC_PER_SECOND = '20';
            
            const config = loadConfigFromEnv();
            
            expect(config.rateLimitEnabled).toBe(false);
            expect(config.rateLimitRequestsPerSecond).toBe(10);
            expect(config.rateLimitRpcPerSecond).toBe(20);
        });

        it('should load WebSocket settings', () => {
            process.env.DEXALOT_WS_MANAGER_ENABLED = 'true';
            process.env.DEXALOT_WS_PING_INTERVAL = '60';
            process.env.DEXALOT_WS_PING_TIMEOUT = '20';
            process.env.DEXALOT_WS_RECONNECT_INITIAL_DELAY = '2000';
            process.env.DEXALOT_WS_RECONNECT_MAX_DELAY = '120000';
            process.env.DEXALOT_WS_RECONNECT_EXPONENTIAL_BASE = '3.0';
            process.env.DEXALOT_WS_RECONNECT_MAX_ATTEMPTS = '5';
            
            const config = loadConfigFromEnv();
            
            expect(config.wsManagerEnabled).toBe(true);
            expect(config.wsPingInterval).toBe(60);
            expect(config.wsPingTimeout).toBe(20);
            expect(config.wsReconnectInitialDelay).toBe(2000);
            expect(config.wsReconnectMaxDelay).toBe(120000);
            expect(config.wsReconnectExponentialBase).toBe(3.0);
            expect(config.wsReconnectMaxAttempts).toBe(5);
        });

        it('should load provider failover settings', () => {
            process.env.DEXALOT_PROVIDER_FAILOVER_ENABLED = 'false';
            process.env.DEXALOT_PROVIDER_FAILOVER_COOLDOWN = '120000';
            process.env.DEXALOT_PROVIDER_FAILOVER_MAX_FAILURES = '5';
            
            const config = loadConfigFromEnv();
            
            expect(config.providerFailoverEnabled).toBe(false);
            expect(config.providerFailoverCooldown).toBe(120000);
            expect(config.providerFailoverMaxFailures).toBe(5);
        });

        it('should load connection pool settings', () => {
            process.env.DEXALOT_CONNECTION_POOL_LIMIT = '200';
            process.env.DEXALOT_CONNECTION_POOL_LIMIT_PER_HOST = '50';
            
            const config = loadConfigFromEnv();
            
            expect(config.connectionPoolLimit).toBe(200);
            expect(config.connectionPoolLimitPerHost).toBe(50);
        });

        it('should allow overrides to take precedence', () => {
            process.env.PARENTENV = 'env-value';
            const config = loadConfigFromEnv({ parentEnv: 'override-value' });
            
            expect(config.parentEnv).toBe('override-value');
        });

        it('should handle boolean env vars', () => {
            process.env.DEXALOT_ENABLE_CACHE = '1';
            const config1 = loadConfigFromEnv();
            expect(config1.cacheEnabled).toBe(true);
            
            process.env.DEXALOT_ENABLE_CACHE = 'true';
            const config2 = loadConfigFromEnv();
            expect(config2.cacheEnabled).toBe(true);
            
            process.env.DEXALOT_ENABLE_CACHE = 'false';
            const config3 = loadConfigFromEnv();
            expect(config3.cacheEnabled).toBe(false);
        });

        it('should handle invalid numeric env vars gracefully', () => {
            process.env.DEXALOT_RETRY_MAX_ATTEMPTS = 'invalid';
            const config = loadConfigFromEnv();
            
            // Should use default
            expect(config.retryMaxAttempts).toBe(3);
        });

        it('should load nonce manager settings', () => {
            process.env.DEXALOT_NONCE_MANAGER_ENABLED = 'false';
            
            const config = loadConfigFromEnv();
            
            expect(config.nonceManagerEnabled).toBe(false);
        });

        it('should handle invalid float env vars gracefully', () => {
            process.env.DEXALOT_RETRY_INITIAL_DELAY = 'invalid';
            const config = loadConfigFromEnv();

            // Should use default
            expect(config.retryInitialDelay).toBe(1000);
        });

        it('should load timestampedAuth from env', () => {
            process.env.DEXALOT_TIMESTAMPED_AUTH = 'true';
            const config = loadConfigFromEnv();
            expect(config.timestampedAuth).toBe(true);
        });

        it('should load wsTimeOffsetMs from env', () => {
            process.env.DEXALOT_WS_TIME_OFFSET_MS = '500';
            const config = loadConfigFromEnv();
            expect(config.wsTimeOffsetMs).toBe(500);
        });

        it('should load erc20BalanceConcurrency from env', () => {
            process.env.DEXALOT_ERC20_BALANCE_CONCURRENCY = '8';
            const config = loadConfigFromEnv();
            expect(config.erc20BalanceConcurrency).toBe(8);
        });

        it('should load allowInsecureRpc from env', () => {
            process.env.DEXALOT_ALLOW_INSECURE_RPC = 'true';
            const config = loadConfigFromEnv();
            expect(config.allowInsecureRpc).toBe(true);
        });
    });

    describe('validateConfig', () => {
        it('should validate valid config', () => {
            const config = createConfig();
            expect(() => validateConfig(config)).not.toThrow();
        });

        it('should reject empty parentEnv', () => {
            expect(() => createConfig({ parentEnv: '' })).toThrow('parentEnv cannot be empty');
        });

        it('should validate private key format', () => {
            expect(() => createConfig({ privateKey: 'invalid' })).toThrow('must start with "0x"');
            expect(() => createConfig({ privateKey: '0x123' })).toThrow('must be 66 characters');
        });

        it('should validate retry settings', () => {
            expect(() => createConfig({ retryMaxAttempts: 0 })).toThrow('retryMaxAttempts must be at least 1');
            expect(() => createConfig({ retryInitialDelay: -1 })).toThrow('retryInitialDelay must be non-negative');
            expect(() => createConfig({ retryMaxDelay: 100, retryInitialDelay: 200 })).toThrow('retryMaxDelay must be >= retryInitialDelay');
            expect(() => createConfig({ retryExponentialBase: 0.5 })).toThrow('retryExponentialBase must be >= 1.0');
        });

        it('should validate rate limit settings', () => {
            expect(() => createConfig({ rateLimitRequestsPerSecond: 0 })).toThrow('rateLimitRequestsPerSecond must be positive');
            expect(() => createConfig({ rateLimitRpcPerSecond: -1 })).toThrow('rateLimitRpcPerSecond must be positive');
        });

        it('should validate connection pool settings', () => {
            expect(() => createConfig({ connectionPoolLimit: 0 })).toThrow('connectionPoolLimit must be at least 1');
            expect(() => createConfig({ connectionPoolLimitPerHost: 0 })).toThrow('connectionPoolLimitPerHost must be at least 1');
            expect(() => createConfig({ 
                connectionPoolLimit: 10, 
                connectionPoolLimitPerHost: 20 
            })).toThrow('connectionPoolLimitPerHost must be <= connectionPoolLimit');
        });

        it('should validate WebSocket settings', () => {
            expect(() => createConfig({ wsPingInterval: 0 })).toThrow('wsPingInterval must be at least 1');
            expect(() => createConfig({ wsPingTimeout: 0 })).toThrow('wsPingTimeout must be at least 1');
            expect(() => createConfig({ wsReconnectInitialDelay: -1 })).toThrow('wsReconnectInitialDelay must be non-negative');
            expect(() => createConfig({ 
                wsReconnectMaxDelay: 100, 
                wsReconnectInitialDelay: 200 
            })).toThrow('wsReconnectMaxDelay must be >= wsReconnectInitialDelay');
            expect(() => createConfig({ wsReconnectExponentialBase: 0.5 })).toThrow('wsReconnectExponentialBase must be >= 1.0');
            expect(() => createConfig({ wsReconnectMaxAttempts: -1 })).toThrow('wsReconnectMaxAttempts must be non-negative');
        });

        it('should validate provider failover settings', () => {
            expect(() => createConfig({ providerFailoverCooldown: -1 })).toThrow('providerFailoverCooldown must be non-negative');
            expect(() => createConfig({ providerFailoverMaxFailures: 0 })).toThrow('providerFailoverMaxFailures must be at least 1');
        });

        it('should reject API base URL with trailing slash', () => {
            // createConfig automatically strips trailing slashes, so test validateConfig directly
            const config = createConfig({ apiBaseUrl: 'https://api.example.com' });
            // Manually set trailing slash to test validation
            config.apiBaseUrl = 'https://api.example.com/';
            expect(() => validateConfig(config)).toThrow('apiBaseUrl must not end with a trailing slash');
        });

        it('should validate cache TTL values are non-negative', () => {
            // Test all cache TTL validation rules
            expect(() => createConfig({ cacheTtlStatic: -1 })).toThrow('cacheTtlStatic must be non-negative');
            expect(() => createConfig({ cacheTtlSemiStatic: -1 })).toThrow('cacheTtlSemiStatic must be non-negative');
            expect(() => createConfig({ cacheTtlBalance: -1 })).toThrow('cacheTtlBalance must be non-negative');
            expect(() => createConfig({ cacheTtlOrderbook: -1 })).toThrow('cacheTtlOrderbook must be non-negative');
        });
    });
});

