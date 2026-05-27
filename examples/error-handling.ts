/**
 * Dexalot SDK Error Handling Examples
 *
 * Demonstrates comprehensive error handling using the Result<T> pattern —
 * validation errors, network errors, propagation patterns, manual retry,
 * and user-facing error formatting.
 *
 * Run with:
 *   pnpm exec tsx examples/error-handling.ts
 */

import { DexalotClient, createConfig, Result } from '../src/index.js';

async function exampleValidationErrors(client: DexalotClient): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 1: Input Validation Errors');
    console.log('='.repeat(60));

    console.log('\n1. Invalid amount (negative):');
    let result = await client.addOrder({
        pair: 'AVAX/USDC', side: 'BUY', amount: -1.0, price: 25.0, type: 'LIMIT',
    });
    if (!result.success) console.log(`   ✓ Validation caught: ${result.error}`);

    console.log('\n2. Invalid amount (zero):');
    result = await client.addOrder({
        pair: 'AVAX/USDC', side: 'BUY', amount: 0, price: 25.0, type: 'LIMIT',
    });
    if (!result.success) console.log(`   ✓ Validation caught: ${result.error}`);

    console.log('\n3. Invalid price (negative):');
    result = await client.addOrder({
        pair: 'AVAX/USDC', side: 'BUY', amount: 1.0, price: -25.0, type: 'LIMIT',
    });
    if (!result.success) console.log(`   ✓ Validation caught: ${result.error}`);

    console.log('\n4. Invalid address format:');
    const balRes = await client.getPortfolioBalance('USDC', 'invalid-address');
    if (!balRes.success) console.log(`   ✓ Validation caught: ${balRes.error}`);

    console.log('\n5. Invalid pair format:');
    const obRes = await client.getOrderBook('INVALID_PAIR');
    if (!obRes.success) console.log(`   ✓ Validation caught: ${obRes.error}`);
}

async function exampleNetworkErrors(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 2: Network Error Handling');
    console.log('='.repeat(60));

    console.log('\n1. Unknown pair:');
    const r1 = await client.getOrderBook('NONEXISTENT/PAIR');
    if (!r1.success) console.log(`   ✓ Error handled: ${r1.error}`);

    console.log('\n2. Order without wallet:');
    const originalSigner = client.signer;
    client.signer = null;
    const r2 = await client.addOrder({
        pair: 'AVAX/USDC', side: 'BUY', amount: 1.0, price: 25.0, type: 'LIMIT',
    });
    if (!r2.success) console.log(`   ✓ Error handled: ${r2.error}`);
    client.signer = originalSigner;
}

async function exampleResultPatternBestPractices(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 3: Result Pattern Best Practices');
    console.log('='.repeat(60));

    console.log('\n1. Always check result.success:');
    const tokens = await client.getTokens();
    if (tokens.success) {
        console.log(`   ✓ Found ${tokens.data!.length} tokens`);
    } else {
        console.log(`   ✗ Error: ${tokens.error}`);
    }

    console.log('\n2. Early-return pattern:');
    async function fetchOrderbookSafely(pair: string) {
        const r = await client.getOrderBook(pair);
        if (!r.success) return null;
        return r.data!;
    }
    const ob = await fetchOrderbookSafely('AVAX/USDC');
    if (ob) {
        console.log(`   ✓ Orderbook fetched: ${ob.bids.length} bids`);
    } else {
        console.log('   ✗ Failed to fetch orderbook');
    }

    console.log('\n3. Narrow types via the success discriminator:');
    const r = await client.getOrderBook('AVAX/USDC');
    if (r.success) {
        // TypeScript knows `r.data` is non-null inside this branch.
        const _ob = r.data!;
        void _ob;
    }
}

async function exampleErrorPropagation(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 4: Error Propagation');
    console.log('='.repeat(60));

    async function placeOrderWithValidation(
        pair: string,
        side: 'BUY' | 'SELL',
        amount: number,
        price: number,
    ) {
        const pairsRes = await client.getClobPairs();
        if (!pairsRes.success) {
            return Result.fail(`Failed to fetch pairs: ${pairsRes.error}`);
        }
        if (!client.pairs[pair]) {
            return Result.fail(`Pair ${pair} not found`);
        }
        return client.addOrder({ pair, side, amount, price, type: 'LIMIT' });
    }

    console.log('\n1. Successful order placement (validation passes):');
    const r1 = await placeOrderWithValidation('AVAX/USDC', 'BUY', 1.0, 25.0);
    console.log(r1.success ? '   ✓ Order accepted' : `   ✗ Order rejected: ${r1.error}`);

    console.log('\n2. Invalid pair:');
    const r2 = await placeOrderWithValidation('INVALID/PAIR', 'BUY', 1.0, 25.0);
    if (!r2.success) console.log(`   ✓ Error propagated: ${r2.error}`);
}

async function exampleRetryPattern(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 5: Manual Retry Pattern');
    console.log('='.repeat(60));

    console.log('\nNote: SDK has automatic retry with exponential backoff via the');
    console.log('`retryEnabled` config flag. This example shows the pattern if you');
    console.log('need custom retry logic at the call-site level:');

    async function fetchWithRetry<T>(operation: () => Promise<Result<T>>, maxAttempts = 3): Promise<Result<T>> {
        let last: Result<T> | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const r = await operation();
            if (r.success) return r;
            last = r;
            console.log(`   Attempt ${attempt} failed: ${r.error}`);
            if (attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
        return last!;
    }

    console.log('\nFetching with manual retry:');
    const r = await fetchWithRetry(() => client.getTokens());
    if (r.success) {
        console.log(`   ✓ Success: ${r.data!.length} tokens`);
    } else {
        console.log(`   ✗ Failed after all retries: ${r.error}`);
    }
}

async function exampleUserFriendlyErrors(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 6: User-Friendly Error Messages');
    console.log('='.repeat(60));

    function toUserMessage(result: Result<unknown>): string | null {
        if (result.success) return null;
        const err = (result.error ?? '').toLowerCase();
        if (err.includes('validation') || err.includes('invalid')) {
            return 'Please check your input and try again.';
        }
        if (err.includes('not found')) {
            return 'The requested resource was not found.';
        }
        if (err.includes('signer') || err.includes('account')) {
            return 'Please configure your wallet to continue.';
        }
        if (err.includes('balance') || err.includes('insufficient')) {
            return 'Insufficient balance for this operation.';
        }
        return 'An error occurred. Please try again later.';
    }

    console.log('\n1. Validation error:');
    let r: Result<unknown> = await client.addOrder({
        pair: 'AVAX/USDC', side: 'BUY', amount: -1.0, price: 25.0, type: 'LIMIT',
    });
    if (!r.success) {
        console.log(`   SDK Error:    ${r.error}`);
        console.log(`   User Message: ${toUserMessage(r)}`);
    }

    console.log('\n2. Not-found error:');
    r = await client.getOrderBook('INVALID/PAIR');
    if (!r.success) {
        console.log(`   SDK Error:    ${r.error}`);
        console.log(`   User Message: ${toUserMessage(r)}`);
    }
}

async function main(): Promise<void> {
    console.log();
    console.log('╔' + '='.repeat(58) + '╗');
    console.log('║' + ' '.repeat(10) + 'DEXALOT SDK ERROR HANDLING EXAMPLES' + ' '.repeat(16) + '║');
    console.log('╚' + '='.repeat(58) + '╝');
    console.log();

    let client: DexalotClient | null = null;
    try {
        // Use the highest log level so the examples speak through Result, not logs.
        const config = createConfig({ logLevel: 'error' });
        client = new DexalotClient(config);
        const init = await client.initializeClient();
        if (!init.success) {
            console.log(`✗ Cannot initialize client: ${init.error}`);
            return;
        }

        await exampleValidationErrors(client);
        await exampleNetworkErrors(client);
        await exampleResultPatternBestPractices(client);
        await exampleErrorPropagation(client);
        await exampleRetryPattern(client);
        await exampleUserFriendlyErrors(client);

        console.log('\n' + '='.repeat(60));
        console.log('All examples completed successfully!');
        console.log('='.repeat(60));
        console.log('\nKey Takeaways:');
        console.log('  1. Always check result.success before accessing result.data');
        console.log('  2. Validation errors are caught early with clear messages');
        console.log('  3. Network errors are automatically retried (configurable)');
        console.log('  4. Error messages are sanitized for security');
        console.log('  5. Convert SDK errors to user-friendly messages when surfacing in UIs');
        console.log();
    } catch (e) {
        console.error('\n❌ Error running examples:', e);
    } finally {
        if (client) {
            await client.close();
        }
    }
}

main();
