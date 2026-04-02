/**
 * Integration Test: Single Orders
 * 
 * Tests single order placement and cancellation.
 */
import { getTestClient, cleanupOrders, sleep } from './helpers';
import { DexalotClient } from '../../src/core/client';
import { Order } from '../../src/types';

describe('Integration: Single Orders', () => {
    let client: DexalotClient;
    const pair = 'AVAX/USDC';

    beforeAll(async () => {
        client = await getTestClient();
        await cleanupOrders(client);
    }, 30000);

    afterAll(async () => {
        await cleanupOrders(client);
    }, 30000);

    it('should place and verify buy order', async () => {
        console.log('Testing Single Orders...');
        
        // Place Buy Order
        const result = await client.addOrder({
            pair,
            side: 'BUY',
            amount: 0.6,
            price: 14.5,
            type: 'LIMIT'
        });
        
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log(`Placed Buy Order: ${result.data!.txHash}`);
        
        await sleep(5000);
        
        const ordersResult = await client.getOpenOrders();
        expect(ordersResult.success).toBe(true);
        const orders = ordersResult.data!;
        expect(orders.length).toBe(1);
        expect(orders[0].side).toBe(0); // 0 = BUY
        expect(parseFloat(String(orders[0].quantity))).toBe(0.6);
        console.log('✅ Buy Order verified');
    }, 60000);

    it('should place and verify sell order', async () => {
        const result = await client.addOrder({
            pair,
            side: 'SELL',
            amount: 0.7,
            price: 18.5,
            type: 'LIMIT'
        });
        
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log(`Placed Sell Order: ${result.data!.txHash}`);
        
        await sleep(5000);
        
        const ordersResult = await client.getOpenOrders();
        expect(ordersResult.success).toBe(true);
        const orders = ordersResult.data!;
        expect(orders.length).toBe(2);
        console.log('✅ Sell Order verified');
    }, 60000);

    it('should cancel buy order', async () => {
        const ordersResult = await client.getOpenOrders();
        expect(ordersResult.success).toBe(true);
        const orders = ordersResult.data!;
        const buyOrder = orders.find((o) => o.side === 0); // 0 = BUY
        expect(buyOrder).toBeDefined();
        
        const result = await client.cancelOrder(buyOrder!.id);
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log(`Cancelled Buy Order: ${result.data!.txHash}`);
        
        await sleep(5000);
        
        const remainingResult = await client.getOpenOrders();
        expect(remainingResult.success).toBe(true);
        const remainingOrders = remainingResult.data!;
        expect(remainingOrders.length).toBe(1);
        expect(remainingOrders[0].side).toBe(1); // Only Sell remains (1 = SELL)
        console.log('✅ Cancel verification passed');
    }, 60000);
});
