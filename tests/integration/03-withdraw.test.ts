/**
 * Integration Test: Withdraw
 * 
 * Tests withdrawing assets from Dexalot L1 to Fuji.
 */
import { getTestClient, waitForBalanceChange, sleep } from './helpers';
import { DexalotClient } from '../../src/core/client';

describe('Integration: Withdraw', () => {
    let client: DexalotClient;

    beforeAll(async () => {
        client = await getTestClient();
    }, 30000);

    it('should withdraw AVAX to Fuji', async () => {
        console.log('Testing Withdraw...');

        const initBalanceResult = await client.getPortfolioBalance('AVAX');
        const initAvax = initBalanceResult.success && initBalanceResult.data
            ? initBalanceResult.data.total
            : 0;
        
        // Withdraw 1 AVAX
        const result = await client.withdraw('AVAX', 1.0, 'Fuji', false);
        
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log(`Withdrew 1 AVAX: ${result.data!.txHash}`);
        
        await sleep(15000);
        
        const finalAvax = await waitForBalanceChange(client, 'AVAX', initAvax, -1.0);
        expect(finalAvax).not.toBeNull();
        console.log('✅ AVAX Withdraw verification passed');
    }, 120000);

    it('should withdraw ALOT to Fuji', async () => {
        const initBalanceResult = await client.getPortfolioBalance('ALOT');
        const initAlot = initBalanceResult.success && initBalanceResult.data
            ? initBalanceResult.data.total
            : 0;
        
        const result = await client.withdraw('ALOT', 10.0, 'Fuji', false);
        
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log(`Withdrew 10 ALOT: ${result.data!.txHash}`);
        
        await sleep(15000);
        
        const finalAlot = await waitForBalanceChange(client, 'ALOT', initAlot, -10.0);
        expect(finalAlot).not.toBeNull();
        console.log('✅ ALOT Withdraw verification passed');
    }, 120000);

    it('should withdraw USDC to Fuji', async () => {
        const initBalanceResult = await client.getPortfolioBalance('USDC');
        const initUsdc = initBalanceResult.success && initBalanceResult.data
            ? initBalanceResult.data.total
            : 0;
        
        const result = await client.withdraw('USDC', 10.0, 'Fuji', false);
        
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log(`Withdrew 10 USDC: ${result.data!.txHash}`);
        
        await sleep(15000);
        
        const finalUsdc = await waitForBalanceChange(client, 'USDC', initUsdc, -10.0);
        expect(finalUsdc).not.toBeNull();
        console.log('✅ USDC Withdraw verification passed');
    }, 120000);
});
