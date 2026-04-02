/**
 * Integration Test: Deposit
 * 
 * Tests depositing assets from Fuji to Dexalot L1.
 */
import { getTestClient, waitForBalanceChange, sleep } from './helpers';
import { DexalotClient } from '../../src/core/client';

describe('Integration: Deposit', () => {
    let client: DexalotClient;

    beforeAll(async () => {
        client = await getTestClient();
    }, 30000);

    it('should deposit AVAX from Fuji', async () => {
        console.log('Testing Deposit...');

        // Get initial balance
        const initBalanceResult = await client.getPortfolioBalance('AVAX');
        const initAvax = initBalanceResult.success && initBalanceResult.data
            ? initBalanceResult.data.total
            : 0;
        
        // Deposit 2 AVAX
        const result = await client.deposit('AVAX', 2.0, 'Fuji', false);
        
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log(`Deposited 2 AVAX: ${result.data!.txHash}`);
        
        // Wait for finalization
        console.log('Waiting for deposit to finalize...');
        await sleep(15000);
        
        // Verify balance increased
        const finalAvax = await waitForBalanceChange(client, 'AVAX', initAvax, 2.0);
        expect(finalAvax).not.toBeNull();
        console.log('✅ AVAX Deposit verification passed');
    }, 120000);

    it('should deposit ALOT from Fuji', async () => {
        const initBalanceResult = await client.getPortfolioBalance('ALOT');
        const initAlot = initBalanceResult.success && initBalanceResult.data
            ? initBalanceResult.data.total
            : 0;
        
        const result = await client.deposit('ALOT', 20.0, 'Fuji', false);
        
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log(`Deposited 20 ALOT: ${result.data!.txHash}`);
        
        await sleep(15000);
        
        const finalAlot = await waitForBalanceChange(client, 'ALOT', initAlot, 20.0);
        expect(finalAlot).not.toBeNull();
        console.log('✅ ALOT Deposit verification passed');
    }, 120000);

    it('should deposit USDC from Fuji', async () => {
        const initBalanceResult = await client.getPortfolioBalance('USDC');
        const initUsdc = initBalanceResult.success && initBalanceResult.data
            ? initBalanceResult.data.total
            : 0;
        
        const result = await client.deposit('USDC', 20.0, 'Fuji', false);
        
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log(`Deposited 20 USDC: ${result.data!.txHash}`);
        
        await sleep(15000);
        
        const finalUsdc = await waitForBalanceChange(client, 'USDC', initUsdc, 20.0);
        expect(finalUsdc).not.toBeNull();
        console.log('✅ USDC Deposit verification passed');
    }, 120000);
});
