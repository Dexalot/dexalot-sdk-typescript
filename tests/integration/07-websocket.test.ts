/**
 * Integration: WebSocket order book stream (Fuji).
 *
 * Requires PRIVATE_KEY and network. Uses a dedicated client with wsManagerEnabled.
 */
import { createFreshTestClient, sleep } from './helpers';
import { DexalotClient } from '../../src/core/client';

const PAIR_TOPIC = 'AVAX/USDC';

describe('Integration: WebSocket', () => {
    let client: DexalotClient;

    beforeAll(async () => {
        client = await createFreshTestClient({ wsManagerEnabled: true });
    }, 90000);

    afterAll(async () => {
        try {
            client.unsubscribeFromEvents(PAIR_TOPIC);
        } catch {
            /* ignore */
        }
        await client.closeWebsocket(1);
        client.close();
    }, 15000);

    it('connects, subscribes to order book, and receives orderBooks payloads', async () => {
        const payloads: unknown[] = [];

        await client.subscribeToEvents(PAIR_TOPIC, (data: unknown) => {
            payloads.push(data);
        }, false);

        const mgr = client._wsManager;
        expect(mgr).not.toBeNull();

        const connectedDeadline = Date.now() + 20000;
        while (Date.now() < connectedDeadline && !mgr!.isConnected) {
            await sleep(200);
        }
        expect(mgr!.isConnected).toBe(true);
        expect(mgr!.getSubscribedTopics()).toContain(PAIR_TOPIC);

        const messageDeadline = Date.now() + 45000;
        while (Date.now() < messageDeadline && payloads.length === 0) {
            await sleep(400);
        }

        expect(payloads.length).toBeGreaterThan(0);
        expect(typeof payloads[0]).toBe('object');

        client.unsubscribeFromEvents(PAIR_TOPIC);
        console.log('✅ WebSocket order book subscription passed');
    }, 120000);
});
