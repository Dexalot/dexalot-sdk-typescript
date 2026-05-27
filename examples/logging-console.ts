/**
 * Example: Console logging with the Dexalot SDK.
 *
 * Demonstrates configuring console-format logging at INFO level for
 * local development. `configureLogging` must run BEFORE the first
 * `getLogger` call so loggers pick up the configured sink.
 *
 * Run with:
 *   pnpm exec tsx examples/logging-console.ts
 */

import { DexalotClient, configureLogging } from '../src/index.js';

// Configure console logging at info level before any client is created.
configureLogging('info', 'console');

async function main(): Promise<void> {
    const client = new DexalotClient();
    try {
        const result = await client.initializeClient();
        console.log('\nInitialize result:', result.success ? 'ok' : `fail: ${result.error}`);
        console.log('\nCheck the console output above for structured log messages!');

        if (result.success) {
            const tokens = await client.getTokens();
            if (tokens.success) {
                console.log(`\n✓ Successfully fetched ${tokens.data!.length} tokens`);
            }
        }
    } finally {
        await client.close();
    }
}

main();
