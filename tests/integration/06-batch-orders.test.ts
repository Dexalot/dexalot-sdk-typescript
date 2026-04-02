/**
 * Integration Test: Batch Orders
 * 
 * Tests batch order placement, replacement, and cancellation.
 */
import { getTestClient, cleanupOrders, sleep } from './helpers';
import { DexalotClient } from '../../src/core/client';
import { Order } from '../../src/types';

describe('Integration: Batch Orders', () => {
    let client: DexalotClient;
    const pair = 'AVAX/USDC';

    beforeAll(async () => {
        client = await getTestClient();
        await cleanupOrders(client);
    }, 30000);

    afterAll(async () => {
        await cleanupOrders(client);
    }, 30000);

    it('should place batch orders (2 buys, 2 sells)', async () => {
        console.log('Testing Batch Orders...');
        
        const ordersToPlace = [
            { pair, side: 'BUY' as const, amount: 0.5, price: 14.0, type: 'LIMIT' as const },
            { pair, side: 'BUY' as const, amount: 0.5, price: 14.1, type: 'LIMIT' as const },
            { pair, side: 'SELL' as const, amount: 0.5, price: 19.0, type: 'LIMIT' as const },
            { pair, side: 'SELL' as const, amount: 0.5, price: 19.1, type: 'LIMIT' as const },
        ];
        
        const result = await client.addOrderList(ordersToPlace);
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log('Placed Batch Orders');
        
        await sleep(5000);
        
        const ordersResult = await client.getOpenOrders();
        expect(ordersResult.success).toBe(true);
        const orders = ordersResult.data!;
        expect(orders.length).toBe(4);
        console.log('✅ Batch Place verified');
    }, 60000);

    it('should replace all orders with price adjustment', async () => {
        const ordersResult = await client.getOpenOrders();
        expect(ordersResult.success).toBe(true);
        const orders = ordersResult.data!;
        
        const replacements = orders.map((order) => {
            // side: 0=BUY, 1=SELL (API returns numbers)
            const isSell = order.side === 1;
            const newPrice = isSell 
                ? parseFloat(String(order.price)) + 1.0 
                : parseFloat(String(order.price)) - 1.0;
            return {
                order_id: order.id,
                pair,
                side: isSell ? 'SELL' : 'BUY',
                amount: parseFloat(String(order.quantity)),
                price: newPrice
            };
        });
        
        const result = await client.cancelAddList(replacements);
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log('Replaced Batch Orders');
        
        await sleep(5000);
        
        const updatedResult = await client.getOpenOrders();
        expect(updatedResult.success).toBe(true);
        const updatedOrders = updatedResult.data!;
        expect(updatedOrders.length).toBe(4);
        console.log('✅ Batch Replace verified');
    }, 60000);

    it('should cancel buy orders by client ID', async () => {
        const ordersResult = await client.getOpenOrders();
        expect(ordersResult.success).toBe(true);
        const orders = ordersResult.data!;
        const buyOrders = orders.filter((o) => o.side === 0); // 0 = BUY
        const buyClientIds = buyOrders
            .map((o) => o.clientOrderId)
            .filter((id): id is string => id !== undefined && id !== null);
        
        expect(buyClientIds.length).toBeGreaterThan(0);
        const result = await client.cancelListOrdersByClientId(buyClientIds);
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log('Cancelled Buys by Client ID');
        
        await sleep(5000);
        
        const remainingResult = await client.getOpenOrders();
        expect(remainingResult.success).toBe(true);
        const remainingOrders = remainingResult.data!;
        expect(remainingOrders.length).toBe(2);
        expect(remainingOrders.every((o) => o.side === 1)).toBe(true); // 1 = SELL
        console.log('✅ Cancel by Client ID verified');
    }, 60000);

    it('should cancel sell orders by internal ID', async () => {
        const ordersResult = await client.getOpenOrders();
        expect(ordersResult.success).toBe(true);
        const orders = ordersResult.data!;
        const sellIds = orders.map((o) => o.id);
        
        const result = await (client as any).cancelListOrders(sellIds);
        expect(result.success).toBe(true);
        expect(result.data!.txHash).toBeDefined();
        console.log('Cancelled Sells by Internal ID');
        
        await sleep(5000);
        
        const remainingResult = await client.getOpenOrders();
        expect(remainingResult.success).toBe(true);
        const remainingOrders = remainingResult.data!;
        expect(remainingOrders.length).toBe(0);
        console.log('✅ Cancel by Internal ID verified');
    }, 60000);
});
