/**
 * Dexalot SDK Caching Examples
 *
 * Demonstrates the SDK's 4-tier caching layer — basic behavior, custom
 * TTLs, cache invalidation, the `cacheEnabled: false` bypass, the
 * stampede-protection coalesce, and an overview of every cache level.
 *
 * Run with:
 *   pnpm exec tsx examples/caching-demo.ts
 */

import { DexalotClient, createConfig } from '../src/index.js';

async function exampleBasicCaching(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 1: Basic Caching');
    console.log('='.repeat(60));

    const client = new DexalotClient();
    try {
        const init = await client.initializeClient();
        if (!init.success) {
            console.log(`   Error: ${init.error}`);
            return;
        }

        console.log('\n1. First call to getTokens() — fetches from API');
        let start = Date.now();
        const r1 = await client.getTokens();
        const firstMs = Date.now() - start;
        console.log(`   Time: ${firstMs}ms`);
        if (r1.success) {
            console.log(`   Found ${r1.data!.length} tokens`);
        }

        console.log('\n2. Second call to getTokens() — returns cached result');
        start = Date.now();
        const r2 = await client.getTokens();
        const secondMs = Date.now() - start;
        console.log(`   Time: ${secondMs}ms`);
        if (r2.success) {
            const speedup = secondMs > 0 ? (firstMs / secondMs).toFixed(1) : 'instant';
            console.log(`   Found ${r2.data!.length} tokens (same as before)`);
            console.log(`   Speedup: ${speedup}x faster`);
        }

        console.log('\n✓ Caching reduces API calls and improves performance!\n');
    } finally {
        await client.close();
    }
}

async function exampleCustomTtl(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 2: Custom TTL Configuration');
    console.log('='.repeat(60));

    const config = createConfig({
        cacheEnabled: true,
        cacheTtlStatic: 7200,        // 2 hours
        cacheTtlSemiStatic: 1800,    // 30 minutes
        cacheTtlBalance: 5,          // 5 seconds
        cacheTtlOrderbook: 0.5,      // 500 ms
    });
    const client = new DexalotClient(config);
    try {
        await client.initializeClient();
        console.log('\nCustom TTLs configured:');
        console.log('  - Static data: 2 hours');
        console.log('  - Semi-static data: 30 minutes');
        console.log('  - Balance data: 5 seconds');
        console.log('  - Orderbook data: 500 ms');
        console.log('\n  Note: caches are module-level singletons in the SDK, so');
        console.log('  these TTLs apply process-wide once configureCaches has run');
        console.log('  (BaseClient does this automatically in the constructor).');
        console.log('\n✓ TTL values can be tuned per cache tier!\n');
    } finally {
        await client.close();
    }
}

async function exampleCacheInvalidation(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 3: Cache Invalidation');
    console.log('='.repeat(60));

    const client = new DexalotClient();
    try {
        await client.initializeClient();

        console.log('\n1. Fetch tokens (cached)');
        const r1 = await client.getTokens();
        if (r1.success) {
            console.log(`   Found ${r1.data!.length} tokens`);
        }

        console.log('\n2. Invalidate all caches');
        client.invalidateCache('all');
        console.log('   All caches cleared');

        console.log('\n3. Next call will fetch fresh data from API');
        const r2 = await client.getTokens();
        if (r2.success) {
            console.log(`   Found ${r2.data!.length} tokens (fresh data)`);
        }

        console.log('\n4. Invalidate a specific tier');
        client.invalidateCache('semi_static');
        console.log('   Semi-static cache cleared (tokens, pairs)');

        console.log('\n✓ Cache can be invalidated when fresh data is needed!\n');
    } finally {
        await client.close();
    }
}

async function exampleDisabledCaching(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 4: Disabled Caching');
    console.log('='.repeat(60));

    const client = new DexalotClient(createConfig({ cacheEnabled: false }));
    try {
        await client.initializeClient();
        console.log('\nCaching disabled — every call fetches from API');

        let start = Date.now();
        await client.getTokens();
        const firstMs = Date.now() - start;
        console.log(`\n1. First call: ${firstMs}ms`);

        start = Date.now();
        await client.getTokens();
        const secondMs = Date.now() - start;
        console.log(`2. Second call: ${secondMs}ms`);

        console.log('\n   Both calls took similar time (no caching)');
        console.log('\n✓ Caching can be disabled when always-fresh data is required!\n');
    } finally {
        await client.close();
    }
}

async function exampleStampedeProtection(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 5: Stampede Protection (Cache Coalesce)');
    console.log('='.repeat(60));

    const client = new DexalotClient();
    try {
        await client.initializeClient();
        client.invalidateCache('semi_static');  // Force a cold fetch.

        console.log('\nFiring 5 concurrent getTokens() calls against a cold cache...');
        const start = Date.now();
        const results = await Promise.all([
            client.getTokens(),
            client.getTokens(),
            client.getTokens(),
            client.getTokens(),
            client.getTokens(),
        ]);
        const elapsedMs = Date.now() - start;

        const allOk = results.every((r) => r.success);
        console.log(`\n✓ All 5 returned ${allOk ? 'successfully' : 'with errors'} in ${elapsedMs}ms`);
        console.log('  Internally only one network request fires — the other four');
        console.log('  callers share the in-flight Promise and receive the same result.');
        console.log();
    } finally {
        await client.close();
    }
}

async function exampleCacheLevels(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 6: Cache Levels Overview');
    console.log('='.repeat(60));

    const client = new DexalotClient();
    try {
        await client.initializeClient();
        console.log('\nThe SDK uses 4 cache levels:\n');

        console.log('1. STATIC (1 hour TTL, max 128 entries)');
        console.log('   - getEnvironments()');
        console.log('   - getChains()');
        console.log('   - getDeployment()');
        const envs = await client.getEnvironments();
        if (envs.success) {
            console.log(`   ✓ Fetched ${envs.data!.length} environments (cached for 1 hour)`);
        }

        console.log('\n2. SEMI-STATIC (15 minutes TTL, max 256 entries)');
        console.log('   - getTokens()');
        console.log('   - getClobPairs()');
        console.log('   - getSwapPairs()');
        const tokens = await client.getTokens();
        if (tokens.success) {
            console.log(`   ✓ Fetched ${tokens.data!.length} tokens (cached for 15 minutes)`);
        }

        console.log('\n3. BALANCE (10 seconds TTL, max 512 entries)');
        console.log('   - getPortfolioBalance()');
        console.log('   - getAllPortfolioBalances()');
        console.log('   - getChainWalletBalance()');
        console.log('   - getAllChainWalletBalances()');
        console.log('   - getChainTokenBalances()');
        if (client.signer) {
            const balances = await client.getAllPortfolioBalances();
            if (balances.success) {
                console.log(`   ✓ Fetched ${Object.keys(balances.data!).length} token balances (cached for 10s)`);
            }
        } else {
            console.log('   (No wallet connected)');
        }

        console.log('\n4. ORDERBOOK (1 second TTL, max 256 entries)');
        console.log('   - getOrderBook()');
        console.log('   - getCandles()');
        console.log('   - getMarketSnapshot()');
        const pairs = Object.keys(client.pairs);
        if (pairs.length > 0) {
            const ob = await client.getOrderBook(pairs[0]);
            if (ob.success) {
                console.log(`   ✓ Fetched ${pairs[0]} orderbook: ${ob.data!.bids.length} bids, ${ob.data!.asks.length} asks (cached for 1s)`);
            }
        }

        console.log('\n✓ Different TTLs optimize for data volatility!\n');
    } finally {
        await client.close();
    }
}

async function exampleWriteOperations(): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 7: Write Operations Are Never Cached');
    console.log('='.repeat(60));

    console.log('\nWrite operations are NEVER cached to ensure data integrity:');
    console.log('  - addOrder()');
    console.log('  - cancelOrder()');
    console.log('  - replaceOrder()');
    console.log('  - addLimitOrderList(), cancelAddList()');
    console.log('  - deposit() / withdraw()');
    console.log('  - transferPortfolio()');
    console.log('  - addGas() / removeGas()');
    console.log('  - executeRFQSwap()');

    console.log('\n✓ Every write operation executes immediately!');
    console.log('✓ No risk of stale transactions or double-spending!\n');
}

async function main(): Promise<void> {
    console.log();
    console.log('╔' + '='.repeat(58) + '╗');
    console.log('║' + ' '.repeat(10) + 'DEXALOT SDK CACHING EXAMPLES' + ' '.repeat(20) + '║');
    console.log('╚' + '='.repeat(58) + '╝');
    console.log();

    try {
        await exampleBasicCaching();
        await exampleCustomTtl();
        await exampleCacheInvalidation();
        await exampleDisabledCaching();
        await exampleStampedeProtection();
        await exampleCacheLevels();
        await exampleWriteOperations();

        console.log('='.repeat(60));
        console.log('All examples completed successfully!');
        console.log('='.repeat(60));
        console.log('\nKey Takeaways:');
        console.log('  1. Caching is enabled by default for better performance');
        console.log('  2. TTL values can be customized per cache level');
        console.log('  3. Cache can be invalidated manually when needed');
        console.log('  4. Caches are module-level singletons — shared across clients');
        console.log('  5. Stampede protection coalesces concurrent uncached reads');
        console.log('  6. Write operations are never cached for safety');
        console.log();
    } catch (e) {
        console.error('\n❌ Error running examples:', e);
        console.error('   Make sure you have a valid .env file with API credentials');
    }
}

main();
