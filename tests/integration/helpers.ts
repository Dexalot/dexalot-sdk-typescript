/**
 * Integration Test Helpers for Dexalot Core
 */
import { DexalotClient } from '../../src/core/client';
import { Wallet } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';

// Load environment from root typescript .env
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

let _client: DexalotClient | null = null;

/**
 * Get or create a shared DexalotClient instance for integration tests.
 */
export async function getTestClient(): Promise<DexalotClient> {
    if (_client) {
        return _client;
    }

    // Ensure testnet
    process.env.PARENTENV = 'fuji-multi';

    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        throw new Error('PRIVATE_KEY environment variable is required for integration tests');
    }

    const signer = new Wallet(privateKey);
    _client = new DexalotClient(signer);
    await _client.initialize();

    console.log(`Integration test client initialized: ${signer.address}`);
    return _client;
}

/**
 * Helper to wait for balance update.
 * @param client - DexalotClient instance
 * @param token - Token symbol
 * @param initialBalance - Initial balance to compare against
 * @param expectedChange - Expected change direction (+ve for increase, -ve for decrease)
 * @param timeout - Maximum wait time in milliseconds
 */
export async function waitForBalanceChange(
    client: DexalotClient,
    token: string,
    initialBalance: number,
    expectedChange: number,
    timeout: number = 60000
): Promise<number | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        const result = await client.getPortfolioBalance(token);

        if (result.success && result.data) {
            const currentTotal = result.data.total;

            // Check if balance changed in the expected direction
            if (expectedChange > 0 && currentTotal > initialBalance) {
                return currentTotal;
            }
            if (expectedChange < 0 && currentTotal < initialBalance) {
                return currentTotal;
            }
        }

        // Wait 5 seconds before checking again
        await sleep(5000);
    }

    return null;
}

/**
 * Simple sleep helper.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clean up test orders before/after tests.
 */
export async function cleanupOrders(client: DexalotClient): Promise<void> {
    try {
        await client.cancelAllOrders();
        await sleep(2000);
    } catch (e) {
        // Ignore errors if no orders to cancel
    }
}
