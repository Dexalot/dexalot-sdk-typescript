/**
 * Example: JSON logging with the Dexalot SDK.
 *
 * Demonstrates configuring JSON-format logging at INFO level for
 * production. Each log entry is a single-line JSON object, ideal for
 * piping into log aggregators (Loki, Datadog, ELK).
 *
 * Run with:
 *   pnpm exec tsx examples/logging-json.ts
 *
 * Pipe through jq for pretty-printing:
 *   pnpm exec tsx examples/logging-json.ts 2>&1 | jq .
 */

import { DexalotClient, configureLogging } from '../src/index.js';

configureLogging('info', 'json');

async function main(): Promise<void> {
    const client = new DexalotClient();
    try {
        const result = await client.initializeClient();
        console.log('\nInitialize result:', result.success ? 'ok' : `fail: ${result.error}`);
        console.log('\nJSON logs above can be piped to jq for pretty printing:');
        console.log('  pnpm exec tsx examples/logging-json.ts 2>&1 | jq .');

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
