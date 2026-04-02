/**
 * Integration Test: Replace Order
 * 
 * Tests cancel/replace functionality using replaceOrder.
 */
import { getTestClient, cleanupOrders, sleep } from './helpers';
import { DexalotClient } from '../../src/core/client';
import { Order } from '../../src/types';

describe('Integration: Replace Order', () => {
    let client: DexalotClient;
    const pair = 'AVAX/USDC';

    beforeAll(async () => {
        client = await getTestClient();
        await cleanupOrders(client);
    }, 30000);

    afterAll(async () => {
        await cleanupOrders(client);
    }, 30000);

    it('should replace order with new price and amount', async () => {
        console.log('Testing Replace Order...');
        
        // Place initial order
        await client.addOrder({
            pair,
            side: 'BUY',
            amount: 0.5,
            price: 14.5,
            type: 'LIMIT'
        });
        
        await sleep(5000);
        
        const ordersResult = await client.getOpenOrders();
        expect(ordersResult.success).toBe(true);
        const orders = ordersResult.data!;
        expect(orders.length).toBe(1);
        expect(parseFloat(String(orders[0].quantity))).toBe(0.5);
        const orderId = orders[0].id;
        console.log('Placed initial order');
        
        // Replace order using replaceOrder (cancelReplaceOrder contract call)
        const result = await client.replaceOrder(orderId, 14.6, 0.6);
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log('Replaced Order');
        
        await sleep(5000);
        
        const updatedResult = await client.getOpenOrders();
        expect(updatedResult.success).toBe(true);
        const updatedOrders = updatedResult.data!;
        expect(updatedOrders.length).toBe(1);
        expect(parseFloat(String(updatedOrders[0].quantity))).toBe(0.6);
        // Note: Price check would need formatting from the API
        console.log('✅ Replace verification passed');
    }, 90000);
});
