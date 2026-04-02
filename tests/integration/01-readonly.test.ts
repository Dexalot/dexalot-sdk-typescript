/**
 * Integration Test: Read-Only Tools
 * 
 * Tests all read-only tools against Fuji testnet.
 */
import { getTestClient } from './helpers';
import { DexalotClient } from '../../src/core/client';

describe('Integration: Read-Only Tools', () => {
    let client: DexalotClient;

    beforeAll(async () => {
        client = await getTestClient();
    }, 30000);

    it('should get environments', async () => {
        const result = await client.getEnvironments();
        
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.data!.length).toBeGreaterThan(0);
        console.log('✅ get_environments passed');
    });

    it('should get mainnets', async () => {
        const mainnets = client.getMainnets();
        
        expect(typeof mainnets).toBe('object');
        // Fuji chain ID should be present
        expect(mainnets[43113] || mainnets['43113']).toBeDefined();
        console.log('✅ get_mainnets passed');
    });

    it('should get swap pairs', async () => {
        const mainnets = client.getMainnets();
        const chainId = Object.keys(mainnets)[0];
        
        const result = await client.getSwapPairs(parseInt(chainId, 10));
        
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(Array.isArray(result.data) || typeof result.data === 'object').toBe(true);
        console.log('✅ get_swap_pairs passed');
    });

    it('should get account info', async () => {
        const result = await client.getAllChainWalletBalances();
        
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data).toHaveProperty('address');
        expect(result.data).toHaveProperty('chain_balances');
        console.log('✅ get_all_chain_wallet_balances passed');
    });

    it('should get token balance', async () => {
        const result = await client.getPortfolioBalance('AVAX');
        
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data).toHaveProperty('total');
        expect(result.data).toHaveProperty('available');
        expect(result.data).toHaveProperty('locked');
        console.log('✅ get_token_balance passed');
    });

    it('should get all token balances', async () => {
        const result = await client.getAllPortfolioBalances();
        
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(typeof result.data).toBe('object');
        console.log('✅ get_all_token_balances passed');
    });

    it('should get orderbook', async () => {
        const result = await client.getOrderBook('AVAX/USDC');
        
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data).toHaveProperty('bids');
        expect(result.data).toHaveProperty('asks');
        console.log('✅ get_orderbook passed');
    });
});
