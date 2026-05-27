/**
 * Dexalot SDK Advanced Configuration Examples
 *
 * Demonstrates the full surface of `DexalotConfig` — custom retry, rate
 * limiting, provider failover, WebSocket tuning, timeouts, and
 * environment-variable overrides. Mirrors the Python SDK's
 * configuration_advanced example.
 *
 * Run with:
 *   pnpm exec tsx examples/configuration-advanced.ts
 */

import { DexalotClient, createConfig, loadConfigFromEnv } from '../src/index.js';

async function exampleCustomRetryConfig(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 1: Custom Retry Configuration');
    console.log('='.repeat(60));

    const config = createConfig({
        retryEnabled: true,
        retryMaxAttempts: 5,
        retryInitialDelay: 2,         // seconds
        retryMaxDelay: 30,
        retryExponentialBase: 2,
        retryOnStatus: [429, 500, 502, 503, 504],
    });
    const client = new DexalotClient(config);
    try {
        await client.initializeClient();
        console.log('\nRetry configuration:');
        console.log(`  Max attempts: ${config.retryMaxAttempts}`);
        console.log(`  Initial delay: ${config.retryInitialDelay}s`);
        console.log(`  Max delay: ${config.retryMaxDelay}s`);
        console.log(`  Exponential base: ${config.retryExponentialBase}`);
        console.log(`  Retry on status codes: [${config.retryOnStatus.join(', ')}]`);

        console.log('\n✓ Retry will attempt up to 5 times with delays: 2s, 4s, 8s, 16s, 30s');
        const result = await client.getTokens();
        if (result.success) {
            console.log(`\n✓ Successfully fetched ${result.data!.length} tokens (with retry configured)`);
        }
    } finally {
        await client.close();
    }
}

async function exampleCustomRateLimiting(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 2: Custom Rate Limiting');
    console.log('='.repeat(60));

    const config = createConfig({
        rateLimitEnabled: true,
        rateLimitRequestsPerSecond: 10,
        rateLimitRpcPerSecond: 20,
    });
    const client = new DexalotClient(config);
    try {
        await client.initializeClient();

        console.log('\nRate limiting configuration:');
        console.log(`  API requests: ${config.rateLimitRequestsPerSecond}/second`);
        console.log(`  RPC calls: ${config.rateLimitRpcPerSecond}/second`);
        console.log('\n✓ Rate limiter throttles concurrent requests to prevent API throttling');
        console.log('  Independent slot-cursor design — concurrent waiters sleep in parallel,');
        console.log('  not chained, so request-body prep can overlap with previous callers\' waits.');

        console.log('\nMaking 5 rapid API calls (rate limited)...');
        const start = Date.now();
        await Promise.all([client.getTokens(), client.getTokens(), client.getTokens(), client.getTokens(), client.getTokens()]);
        const elapsedMs = Date.now() - start;
        console.log(`✓ Completed in ${(elapsedMs / 1000).toFixed(2)}s (capped at ~10 req/s)`);
    } finally {
        await client.close();
    }
}

async function exampleProviderFailoverConfig(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 3: Provider Failover Configuration');
    console.log('='.repeat(60));

    const config = createConfig({
        providerFailoverEnabled: true,
        providerFailoverCooldown: 30,
        providerFailoverMaxFailures: 3,
    });
    const client = new DexalotClient(config);
    try {
        await client.initializeClient();

        console.log('\nProvider failover configuration:');
        console.log(`  Enabled: ${config.providerFailoverEnabled}`);
        console.log(`  Cooldown: ${config.providerFailoverCooldown}s`);
        console.log(`  Max failures: ${config.providerFailoverMaxFailures}`);

        console.log('\n✓ Failover will automatically switch to backup providers on failure');
        console.log('  Failed providers are retried after cooldown period');
        console.log('\n  To test failover, configure multiple RPC URLs via env vars:');
        console.log('    DEXALOT_RPC_43114=https://primary,https://backup1,https://backup2');
    } finally {
        await client.close();
    }
}

async function exampleWebSocketConfig(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 4: WebSocket Configuration');
    console.log('='.repeat(60));

    const config = createConfig({
        wsManagerEnabled: true,
        wsPingInterval: 20,
        wsPingTimeout: 5,
        wsReconnectInitialDelay: 1,
        wsReconnectMaxDelay: 30,
        wsReconnectExponentialBase: 2,
        wsReconnectMaxAttempts: 10,
    });
    const client = new DexalotClient(config);
    try {
        await client.initializeClient();
        console.log('\nWebSocket configuration:');
        console.log(`  Manager enabled: ${config.wsManagerEnabled}`);
        console.log(`  Ping interval: ${config.wsPingInterval}s`);
        console.log(`  Ping timeout: ${config.wsPingTimeout}s`);
        console.log(`  Reconnect initial delay: ${config.wsReconnectInitialDelay}s`);
        console.log(`  Reconnect max delay: ${config.wsReconnectMaxDelay}s`);
        console.log(`  Reconnect max attempts: ${config.wsReconnectMaxAttempts}`);
        console.log('\n✓ WebSocket manager configured with custom settings');
    } finally {
        await client.close();
    }
}

async function exampleTimeoutConfig(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 5: Timeout Configuration');
    console.log('='.repeat(60));

    const config = createConfig({
        timeoutConnect: 10,
        timeoutRead: 60,
    });
    const client = new DexalotClient(config);
    try {
        await client.initializeClient();
        console.log('\nTimeout configuration:');
        console.log(`  Connect timeout: ${config.timeoutConnect}s`);
        console.log(`  Read timeout: ${config.timeoutRead}s`);
        console.log('\n✓ Timeouts configured for slower networks');
    } finally {
        await client.close();
    }
}

async function exampleComprehensiveConfig(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 6: Comprehensive Configuration');
    console.log('='.repeat(60));

    const config = createConfig({
        // Caching
        cacheEnabled: true,
        cacheTtlStatic: 7200,
        cacheTtlSemiStatic: 1800,
        cacheTtlBalance: 5,
        cacheTtlOrderbook: 1,
        // Retry
        retryEnabled: true,
        retryMaxAttempts: 3,
        retryInitialDelay: 1,
        retryMaxDelay: 10,
        // Rate Limiting
        rateLimitEnabled: true,
        rateLimitRequestsPerSecond: 5,
        rateLimitRpcPerSecond: 10,
        // Nonce manager
        nonceManagerEnabled: true,
        // Provider failover
        providerFailoverEnabled: true,
        providerFailoverCooldown: 60,
        providerFailoverMaxFailures: 3,
        // WebSocket
        wsManagerEnabled: false,
        wsPingInterval: 30,
        wsPingTimeout: 10,
        // Timeouts
        timeoutConnect: 5,
        timeoutRead: 30,
        // Logging
        logLevel: 'info',
        logFormat: 'console',
    });
    const client = new DexalotClient(config);
    try {
        await client.initializeClient();
        console.log('\nComprehensive configuration applied:');
        console.log('  ✓ Caching enabled with custom TTLs');
        console.log('  ✓ Retry with exponential backoff');
        console.log('  ✓ Rate limiting configured');
        console.log('  ✓ Nonce manager enabled');
        console.log('  ✓ Provider failover enabled');
        console.log('  ✓ Timeouts configured');
        console.log('  ✓ Logging configured');
        console.log('\n✓ All reliability features enabled and configured');
    } finally {
        await client.close();
    }
}

async function exampleEnvironmentVariables(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 7: Environment Variable Configuration');
    console.log('='.repeat(60));

    console.log('\nConfiguration can be set via environment variables:');
    console.log('\n  # Retry settings');
    console.log('  export DEXALOT_RETRY_ENABLED=true');
    console.log('  export DEXALOT_RETRY_MAX_ATTEMPTS=5');
    console.log('  export DEXALOT_RETRY_INITIAL_DELAY=2');
    console.log('\n  # Rate limiting');
    console.log('  export DEXALOT_RATE_LIMIT_ENABLED=true');
    console.log('  export DEXALOT_RATE_LIMIT_REQUESTS_PER_SECOND=10');
    console.log('\n  # Provider failover');
    console.log('  export DEXALOT_PROVIDER_FAILOVER_ENABLED=true');
    console.log('  export DEXALOT_PROVIDER_FAILOVER_COOLDOWN=60');
    console.log('\n  # WebSocket');
    console.log('  export DEXALOT_WS_MANAGER_ENABLED=true');
    console.log('  export DEXALOT_WS_PING_INTERVAL=30');
    console.log('\n  # RPC overrides (chain ID format)');
    console.log('  export DEXALOT_RPC_43114=https://api.avax.network/ext/bc/C/rpc,https://backup.rpc.com');
    console.log('  export DEXALOT_RPC_432204=https://subnets.avax.network/dexalot/mainnet/rpc');

    const envConfig = loadConfigFromEnv();
    console.log('\n✓ loadConfigFromEnv() reads DEXALOT_* env vars + .env file automatically');
    console.log(`  parentEnv (from env): ${envConfig.parentEnv}`);
}

async function exampleConfigPrecedence(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 8: Configuration Precedence');
    console.log('='.repeat(60));

    console.log('\nConfiguration precedence (highest to lowest):');
    console.log('  1. Constructor arguments (new DexalotClient(createConfig({...})))');
    console.log('  2. Environment variables (DEXALOT_*)');
    console.log('  3. .env file');
    console.log('  4. Default values');

    console.log('\nExample:');
    console.log('  # .env file: DEXALOT_RETRY_MAX_ATTEMPTS=3');
    console.log('  # Shell env:  export DEXALOT_RETRY_MAX_ATTEMPTS=5');
    console.log('  # Code:       createConfig({ retryMaxAttempts: 10 })');
    console.log('  # Result:     retryMaxAttempts = 10  (constructor wins)');
    console.log('\n✓ Constructor arguments have the highest priority');
}

async function main(): Promise<void> {
    console.log();
    console.log('╔' + '='.repeat(58) + '╗');
    console.log('║' + ' '.repeat(6) + 'DEXALOT SDK ADVANCED CONFIGURATION EXAMPLES' + ' '.repeat(10) + '║');
    console.log('╚' + '='.repeat(58) + '╝');
    console.log();

    try {
        await exampleCustomRetryConfig();
        await exampleCustomRateLimiting();
        await exampleProviderFailoverConfig();
        await exampleWebSocketConfig();
        await exampleTimeoutConfig();
        await exampleComprehensiveConfig();
        await exampleEnvironmentVariables();
        await exampleConfigPrecedence();

        console.log('\n' + '='.repeat(60));
        console.log('All examples completed successfully!');
        console.log('='.repeat(60));
        console.log('\nKey Takeaways:');
        console.log('  1. All settings are configurable via createConfig({...})');
        console.log('  2. Environment variables provide easy operational configuration');
        console.log('  3. Constructor arguments override environment variables');
        console.log('  4. Sensible defaults are provided for every setting');
        console.log('  5. Configuration is validated at construction time');
        console.log();
    } catch (e) {
        console.error('\n❌ Error running examples:', e);
        console.error('   Make sure you have a valid .env file with API credentials');
    }
}

main();
