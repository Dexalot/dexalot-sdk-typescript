/**
 * Example: Request ID tracking with the Dexalot SDK.
 *
 * Demonstrates the `withRequestId` helper, which scopes a request ID to
 * a synchronous or async function so every log line emitted inside the
 * scope carries the same `requestId` field. Useful for tracing a
 * single logical operation across distributed systems.
 *
 * Look for the `"requestId"` field in the JSON log output below. Each
 * scope (req-001, req-002, req-003) has its own unique ID.
 *
 * Run with:
 *   pnpm exec tsx examples/logging-request-id.ts 2>&1 | jq .
 */

import { DexalotClient, configureLogging, withRequestId } from '../src/index.js';

configureLogging('info', 'json');

async function main(): Promise<void> {
    let client: DexalotClient | null = null;
    try {
        client = new DexalotClient();

        console.log('=== Request 1 ===');
        console.log("Initializing client with requestId='req-001'...");
        await withRequestId('req-001', async () => {
            const result = await client!.initializeClient();
            console.log(result.success ? '✓ Client initialized' : `✗ Error: ${result.error}`);
        });

        console.log("\n=== Request 2 ===");
        console.log("Fetching tokens with requestId='req-002'...");
        await withRequestId('req-002', async () => {
            const result = await client!.getTokens();
            if (result.success) {
                console.log(`✓ Fetched ${result.data!.length} tokens`);
            } else {
                console.log(`✗ Error: ${result.error}`);
            }
        });

        console.log("\n=== Request 3 ===");
        console.log("Fetching environments with requestId='req-003'...");
        await withRequestId('req-003', async () => {
            const result = await client!.getEnvironments();
            if (result.success) {
                console.log(`✓ Fetched ${result.data!.length} environments`);
            } else {
                console.log(`✗ Error: ${result.error}`);
            }
        });

        console.log('\n' + '='.repeat(60));
        console.log('Request ID Tracking Summary:');
        console.log("  • All log entries above include a 'requestId' field");
        console.log("  • Request 1 used: requestId='req-001'");
        console.log("  • Request 2 used: requestId='req-002'");
        console.log("  • Request 3 used: requestId='req-003'");
        console.log('\nThis allows you to trace all operations for a specific request');
        console.log('across distributed systems by filtering logs by requestId.');
        console.log('='.repeat(60));
    } finally {
        if (client) {
            await client.close();
        }
    }
}

main();
