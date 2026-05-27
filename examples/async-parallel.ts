/**
 * Dexalot SDK Parallel Operations Examples
 *
 * Demonstrates parallel async operations for improved throughput —
 * Promise.all for concurrent reads, mixed-operation fan-out, and
 * graceful error handling via Promise.allSettled.
 *
 * Run with:
 *   pnpm exec tsx examples/async-parallel.ts
 */

import { DexalotClient } from '../src/index.js';

async function exampleParallelOrderbooks(client: DexalotClient): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 1: Parallel Orderbook Queries');
    console.log('='.repeat(60));

    const pairsRes = await client.getClobPairs();
    if (!pairsRes.success) {
        console.log(`✗ Error fetching pairs: ${pairsRes.error}`);
        return;
    }
    const pairs = Object.keys(client.pairs).slice(0, 5);
    if (pairs.length === 0) {
        console.log('✗ No pairs available');
        return;
    }

    console.log(`\nFetching orderbooks for ${pairs.length} pairs...`);

    // Sequential
    console.log('\n1. Sequential approach:');
    let start = Date.now();
    for (const pair of pairs) {
        await client.getOrderBook(pair);
    }
    const sequentialMs = Date.now() - start;
    console.log(`   Time: ${(sequentialMs / 1000).toFixed(3)}s`);

    // Parallel
    console.log('\n2. Parallel approach:');
    // Clear orderbook-tier cache so the parallel run does real fetches.
    client.invalidateCache('orderbook');
    start = Date.now();
    const parallel = await Promise.all(pairs.map((p) => client.getOrderBook(p)));
    const parallelMs = Date.now() - start;
    console.log(`   Time: ${(parallelMs / 1000).toFixed(3)}s`);

    if (parallelMs > 0) {
        console.log(`\n✓ Speedup: ${(sequentialMs / parallelMs).toFixed(2)}x faster`);
    }
    console.log('\nOrderbook results:');
    pairs.forEach((pair, i) => {
        const r = parallel[i];
        if (r.success) {
            console.log(`  ${pair}: ${r.data!.bids.length} bids, ${r.data!.asks.length} asks`);
        } else {
            console.log(`  ${pair}: Error — ${r.error}`);
        }
    });
}

async function exampleParallelBalances(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 2: Parallel Balance Fetching Across Chains');
    console.log('='.repeat(60));

    if (!client.signer) {
        console.log('⚠ No wallet connected — skipping balance example');
        console.log('  Set PRIVATE_KEY environment variable to enable this example');
        return;
    }
    const address = await client.signer.getAddress();
    console.log(`\nFetching balances for ${address.slice(0, 10)}... across all chains`);

    const start = Date.now();
    const result = await client.getAllChainWalletBalances(address);
    const elapsedMs = Date.now() - start;
    console.log(`   Time: ${(elapsedMs / 1000).toFixed(3)}s`);
    if (result.success) {
        const data = result.data as any;
        const chains = data?.chain_balances?.length ?? 0;
        console.log(`   Fetched balances for ${chains} chain entries`);
        console.log('\n✓ Parallel fetching is automatic inside getAllChainWalletBalances()');
    }
}

async function exampleParallelMixedOperations(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 3: Parallel Mixed Operations');
    console.log('='.repeat(60));

    console.log('\nFetching multiple data types in parallel...');

    const tasks: Array<[string, Promise<any>]> = [
        ['Tokens', client.getTokens()],
        ['Pairs', client.getClobPairs()],
        ['Environments', client.getEnvironments()],
    ];

    // Add orderbook if a pair is known.
    if (Object.keys(client.pairs).length > 0) {
        tasks.push(['Orderbook', client.getOrderBook(Object.keys(client.pairs)[0])]);
    }

    const start = Date.now();
    const results = await Promise.allSettled(tasks.map(([, p]) => p));
    const elapsedMs = Date.now() - start;

    console.log(`\n✓ Fetched ${tasks.length} different data types in ${(elapsedMs / 1000).toFixed(3)}s`);
    console.log('\nResults:');

    results.forEach((settled, i) => {
        const [name] = tasks[i];
        if (settled.status === 'rejected') {
            console.log(`  ${name}: Error — ${settled.reason}`);
            return;
        }
        const r = settled.value;
        if (r.success === false) {
            console.log(`  ${name}: Error — ${r.error}`);
            return;
        }
        if (Array.isArray(r.data)) {
            console.log(`  ${name}: ${r.data.length} items`);
        } else if (r.data && typeof r.data === 'object') {
            console.log(`  ${name}: ${Object.keys(r.data).length} keys`);
        } else {
            console.log(`  ${name}: Success`);
        }
    });
}

async function exampleErrorHandlingParallel(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 4: Error Handling in Parallel Operations');
    console.log('='.repeat(60));

    const tasks = [
        client.getTokens(),
        client.getOrderBook('INVALID/PAIR'),
        client.getClobPairs(),
        client.getOrderBook('ANOTHER/INVALID'),
    ];

    console.log('\nExecuting mixed valid/invalid operations in parallel...');
    const results = await Promise.allSettled(tasks);

    console.log('\nResults:');
    results.forEach((settled, i) => {
        if (settled.status === 'rejected') {
            console.log(`  Task ${i + 1}: Exception — ${settled.reason}`);
        } else if (settled.value.success) {
            console.log(`  Task ${i + 1}: Success`);
        } else {
            console.log(`  Task ${i + 1}: Error — ${settled.value.error}`);
        }
    });
    console.log('\n✓ All tasks completed, errors handled gracefully');
}

async function main(): Promise<void> {
    console.log();
    console.log('╔' + '='.repeat(58) + '╗');
    console.log('║' + ' '.repeat(8) + 'DEXALOT SDK PARALLEL OPERATIONS EXAMPLES' + ' '.repeat(14) + '║');
    console.log('╚' + '='.repeat(58) + '╝');
    console.log();

    let client: DexalotClient | null = null;
    try {
        client = new DexalotClient();
        const init = await client.initializeClient();
        if (!init.success) {
            console.log(`✗ Cannot initialize client: ${init.error}`);
            return;
        }

        await exampleParallelOrderbooks(client);
        await exampleParallelBalances(client);
        await exampleParallelMixedOperations(client);
        await exampleErrorHandlingParallel(client);

        console.log('\n' + '='.repeat(60));
        console.log('All examples completed successfully!');
        console.log('='.repeat(60));
        console.log('\nKey Takeaways:');
        console.log('  1. Use Promise.all for concurrent reads — same shape as Python asyncio.gather');
        console.log('  2. Use Promise.allSettled when some legs may fail and you want all results');
        console.log('  3. Parallel reads benefit from the SDK\'s stampede protection — duplicate');
        console.log('     in-flight requests for the same cache key are coalesced automatically');
        console.log('  4. SDK methods are safe for concurrent execution from one client instance');
        console.log();
    } catch (e) {
        console.error('\n❌ Error running examples:', e);
        console.error('   Make sure you have a valid .env file with API credentials');
    } finally {
        if (client) {
            await client.close();
        }
    }
}

main();
