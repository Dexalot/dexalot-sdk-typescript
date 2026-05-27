/**
 * Dexalot SDK Basic Async Usage Examples
 *
 * Demonstrates basic async patterns with the Dexalot SDK — initialization,
 * the Result<T> pattern, and simple read operations.
 *
 * Run with:
 *   pnpm exec tsx examples/async-basic.ts
 */

import { DexalotClient } from '../src/index.js';

async function exampleInitialization(): Promise<DexalotClient | null> {
    console.log('='.repeat(60));
    console.log('Example 1: Client Initialization');
    console.log('='.repeat(60));

    const client = new DexalotClient();
    const result = await client.initializeClient();

    if (result.success) {
        console.log('✓ Client initialized successfully');
        console.log(`  Environment: ${client.parentEnv}`);
        console.log(`  API Base URL: ${client.apiBaseUrl}`);
        return client;
    }
    console.log(`✗ Initialization failed: ${result.error}`);
    return null;
}

async function exampleGetTokens(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 2: Fetching Tokens');
    console.log('='.repeat(60));

    const result = await client.getTokens();
    if (!result.success) {
        console.log(`✗ Error fetching tokens: ${result.error}`);
        return;
    }
    const tokens = result.data!;
    console.log(`✓ Found ${tokens.length} tokens`);
    console.log('\nFirst 5 tokens:');
    for (const token of tokens.slice(0, 5)) {
        console.log(`  - ${token.symbol ?? 'N/A'}: ${token.name ?? 'N/A'}`);
    }
}

async function exampleGetPairs(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 3: Fetching Trading Pairs');
    console.log('='.repeat(60));

    const result = await client.getClobPairs();
    if (!result.success) {
        console.log(`✗ Error fetching pairs: ${result.error}`);
        return;
    }
    const pairs = Object.keys(client.pairs);
    console.log(`✓ Found ${pairs.length} trading pairs`);
    console.log('\nFirst 5 pairs:');
    for (const pair of pairs.slice(0, 5)) {
        console.log(`  - ${pair}`);
    }
}

async function exampleGetOrderbook(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 4: Fetching Orderbook');
    console.log('='.repeat(60));

    const pairsRes = await client.getClobPairs();
    if (!pairsRes.success) {
        console.log(`✗ Error fetching pairs: ${pairsRes.error}`);
        return;
    }
    const pairs = Object.keys(client.pairs);
    if (pairs.length === 0) {
        console.log('✗ No trading pairs available');
        return;
    }
    const pair = pairs[0];
    console.log(`Fetching orderbook for ${pair}...`);

    const result = await client.getOrderBook(pair);
    if (!result.success) {
        console.log(`✗ Error fetching orderbook: ${result.error}`);
        return;
    }
    const ob = result.data!;
    console.log('✓ Orderbook fetched successfully');
    console.log(`  Bids: ${ob.bids.length} orders`);
    console.log(`  Asks: ${ob.asks.length} orders`);
    if (ob.bids[0]) {
        console.log(`  Best bid: ${ob.bids[0].price} @ ${ob.bids[0].quantity}`);
    }
    if (ob.asks[0]) {
        console.log(`  Best ask: ${ob.asks[0].price} @ ${ob.asks[0].quantity}`);
    }
}

async function exampleGetBalances(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 5: Fetching Balances');
    console.log('='.repeat(60));

    if (!client.signer) {
        console.log('⚠ No wallet connected — skipping balance example');
        console.log('  Set PRIVATE_KEY environment variable to enable this example');
        return;
    }

    const result = await client.getAllPortfolioBalances();
    if (!result.success) {
        console.log(`✗ Error fetching balances: ${result.error}`);
        return;
    }
    const balances = result.data!;
    const entries = Object.entries(balances);
    console.log(`✓ Found balances for ${entries.length} tokens`);
    console.log('\nFirst 5 token balances:');
    for (const [symbol, bal] of entries.slice(0, 5)) {
        console.log(`  - ${symbol}: ${bal.available} available, ${bal.locked} locked, ${bal.total} total`);
    }
}

async function main(): Promise<void> {
    console.log();
    console.log('╔' + '='.repeat(58) + '╗');
    console.log('║' + ' '.repeat(10) + 'DEXALOT SDK BASIC ASYNC EXAMPLES' + ' '.repeat(18) + '║');
    console.log('╚' + '='.repeat(58) + '╝');
    console.log();

    let client: DexalotClient | null = null;
    try {
        client = await exampleInitialization();
        if (!client) {
            console.log('\n✗ Cannot proceed without initialized client');
            return;
        }

        await exampleGetTokens(client);
        await exampleGetPairs(client);
        await exampleGetOrderbook(client);
        await exampleGetBalances(client);

        console.log('\n' + '='.repeat(60));
        console.log('All examples completed successfully!');
        console.log('='.repeat(60));
        console.log('\nKey Takeaways:');
        console.log('  1. All SDK methods return Promises — always await them');
        console.log('  2. All operational methods return Result<T> for consistent error handling');
        console.log('  3. Always check result.success before accessing result.data');
        console.log('  4. The client constructor is fine to use directly from top-level scripts');
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
