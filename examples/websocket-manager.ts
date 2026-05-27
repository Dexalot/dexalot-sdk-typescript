/**
 * Dexalot SDK WebSocket Manager Examples
 *
 * Demonstrates the WebSocket manager — persistent subscriptions,
 * multi-topic fan-out, private (authenticated) subscriptions,
 * automatic reconnection, heartbeat monitoring, and proper cleanup.
 *
 * Run with:
 *   pnpm exec tsx examples/websocket-manager.ts
 */

import { DexalotClient, createConfig } from '../src/index.js';

async function exampleBasicSubscription(client: DexalotClient): Promise<void> {
    console.log('='.repeat(60));
    console.log('Example 1: Basic WebSocket Subscription');
    console.log('='.repeat(60));

    console.log('\nSubscribing to orderbook updates...');

    const messagesReceived: any[] = [];
    const onOrderbookUpdate = (message: any) => {
        messagesReceived.push(message);
        const data = message?.data ?? {};
        const buys = (data.buyBook ?? []).length;
        const sells = (data.sellBook ?? []).length;
        console.log(`  📊 Orderbook update: ${buys} bids, ${sells} asks`);
    };

    try {
        await client.subscribeToEvents('OrderBook/AVAX/USDC', onOrderbookUpdate, false);
        console.log('✓ Subscribed to OrderBook/AVAX/USDC');

        console.log('\nWaiting for messages (10 seconds)...');
        await new Promise((r) => setTimeout(r, 10_000));

        console.log(`\n✓ Received ${messagesReceived.length} messages`);

        client.unsubscribeFromEvents('OrderBook/AVAX/USDC');
        console.log('✓ Unsubscribed');
    } catch (e) {
        console.log(`✗ Error: ${e instanceof Error ? e.message : e}`);
        console.log('  Make sure wsManagerEnabled is true in config');
    }
}

async function exampleMultipleSubscriptions(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 2: Multiple Subscriptions');
    console.log('='.repeat(60));

    console.log('\nSubscribing to multiple topics...');

    const orderbookUpdates: any[] = [];
    const executionUpdates: any[] = [];

    const onOrderbook = (message: any) => {
        orderbookUpdates.push(message);
        const buys = (message?.data?.buyBook ?? []).length;
        console.log(`  📊 Orderbook: ${buys} bids`);
    };

    const onExecution = (message: any) => {
        executionUpdates.push(message);
        console.log(`  ⚡ Execution: ${message?.status ?? 'N/A'}`);
    };

    try {
        await client.subscribeToEvents('OrderBook/AVAX/USDC', onOrderbook, false);
        await client.subscribeToEvents('Execution', onExecution, true);
        console.log('✓ Subscribed to OrderBook/AVAX/USDC and Execution');

        console.log('\nWaiting for messages (10 seconds)...');
        await new Promise((r) => setTimeout(r, 10_000));

        console.log(`\n✓ Orderbook updates: ${orderbookUpdates.length}`);
        console.log(`✓ Execution updates: ${executionUpdates.length}`);

        client.unsubscribeFromEvents('OrderBook/AVAX/USDC');
        client.unsubscribeFromEvents('Execution');
        console.log('✓ Unsubscribed from all topics');
    } catch (e) {
        console.log(`✗ Error: ${e instanceof Error ? e.message : e}`);
    }
}

async function examplePrivateSubscription(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 3: Private Topic Subscription');
    console.log('='.repeat(60));

    if (!client.signer) {
        console.log('⚠ No wallet connected — skipping private subscription example');
        console.log('  Set PRIVATE_KEY environment variable to enable this example');
        return;
    }

    console.log('\nSubscribing to private order updates...');

    const orderUpdates: any[] = [];
    const onOrderUpdate = (message: any) => {
        orderUpdates.push(message);
        console.log(`  📋 Order update: ${message?.status ?? 'N/A'}`);
    };

    try {
        await client.subscribeToEvents('Orders', onOrderUpdate, true);
        console.log('✓ Subscribed to Orders (private)');

        console.log('\nWaiting for order updates (10 seconds)...');
        await new Promise((r) => setTimeout(r, 10_000));

        console.log(`\n✓ Received ${orderUpdates.length} order updates`);

        client.unsubscribeFromEvents('Orders');
        console.log('✓ Unsubscribed');
    } catch (e) {
        console.log(`✗ Error: ${e instanceof Error ? e.message : e}`);
    }
}

async function exampleReconnectionHandling(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 4: Automatic Reconnection');
    console.log('='.repeat(60));

    const config = createConfig({
        wsManagerEnabled: true,
        wsReconnectInitialDelay: 1,
        wsReconnectMaxDelay: 10,
        wsReconnectExponentialBase: 2,
        wsReconnectMaxAttempts: 5,
    });

    const client = new DexalotClient(config);
    try {
        const init = await client.initializeClient();
        if (!init.success) {
            console.log(`✗ Cannot initialize client: ${init.error}`);
            return;
        }

        console.log('\nWebSocket manager configured with automatic reconnection:');
        console.log(`  Initial delay: ${config.wsReconnectInitialDelay}s`);
        console.log(`  Max delay: ${config.wsReconnectMaxDelay}s`);
        console.log(`  Max attempts: ${config.wsReconnectMaxAttempts}`);

        const onMessage = (_msg: any) => { /* would track reconnections in real code */ };
        await client.subscribeToEvents('OrderBook/AVAX/USDC', onMessage, false);
        console.log('✓ Connected and subscribed');

        console.log('\nIf connection drops, manager will automatically reconnect');
        console.log('with exponential backoff (1s, 2s, 4s, 8s, 10s max)');

        await new Promise((r) => setTimeout(r, 5_000));
        client.unsubscribeFromEvents('OrderBook/AVAX/USDC');
    } finally {
        await client.close();
    }
}

async function exampleHeartbeatMonitoring(): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 5: Heartbeat Monitoring');
    console.log('='.repeat(60));

    const config = createConfig({
        wsManagerEnabled: true,
        wsPingInterval: 10,
        wsPingTimeout: 5,
    });

    const client = new DexalotClient(config);
    try {
        const init = await client.initializeClient();
        if (!init.success) {
            console.log(`✗ Cannot initialize client: ${init.error}`);
            return;
        }

        console.log('\nWebSocket manager configured with heartbeat:');
        console.log(`  Ping interval: ${config.wsPingInterval}s`);
        console.log(`  Ping timeout: ${config.wsPingTimeout}s`);
        console.log('\nManager sends ping frames at the configured interval and');
        console.log('reconnects if pong is not received within the timeout.');

        const onMessage = (_msg: any) => {};
        await client.subscribeToEvents('OrderBook/AVAX/USDC', onMessage, false);
        console.log('✓ Connected with heartbeat monitoring');

        console.log('\nMonitoring connection (15 seconds)...');
        await new Promise((r) => setTimeout(r, 15_000));

        client.unsubscribeFromEvents('OrderBook/AVAX/USDC');
        console.log('✓ Disconnected');
    } finally {
        await client.close();
    }
}

async function exampleTimedSubscription(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 6: Timed Subscription');
    console.log('='.repeat(60));

    console.log('\nSubscribing, listening for 10 seconds, then unsubscribing:');

    const messagesReceived: any[] = [];
    const onMessage = (message: any) => {
        messagesReceived.push(message);
        const buys = (message?.data?.buyBook ?? []).length;
        console.log(`  📊 Received: ${buys} bids`);
    };

    try {
        await client.subscribeToEvents('OrderBook/AVAX/USDC', onMessage, false);
        console.log('✓ Subscribed to OrderBook/AVAX/USDC');

        console.log('\nListening for 10 seconds...');
        await new Promise((r) => setTimeout(r, 10_000));

        client.unsubscribeFromEvents('OrderBook/AVAX/USDC');
        console.log(`\n✓ Received ${messagesReceived.length} messages`);
        console.log('✓ Unsubscribed cleanly');
    } catch (e) {
        console.log(`✗ Error: ${e instanceof Error ? e.message : e}`);
    }
}

async function exampleCleanup(client: DexalotClient): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('Example 7: Proper Cleanup');
    console.log('='.repeat(60));

    try {
        await client.subscribeToEvents('OrderBook/AVAX/USDC', () => {}, false);
        console.log('✓ Subscribed');
        await new Promise((r) => setTimeout(r, 5_000));

        console.log('\nCleaning up...');
        await client.closeWebsocket();
        console.log('✓ WebSocket closed and cleaned up');
    } catch (e) {
        console.log(`✗ Error: ${e instanceof Error ? e.message : e}`);
    }
}

async function main(): Promise<void> {
    console.log();
    console.log('╔' + '='.repeat(58) + '╗');
    console.log('║' + ' '.repeat(8) + 'DEXALOT SDK WEBSOCKET MANAGER EXAMPLES' + ' '.repeat(12) + '║');
    console.log('╚' + '='.repeat(58) + '╝');
    console.log();

    let client: DexalotClient | null = null;
    try {
        // wsManagerEnabled must be set at client construction time.
        const config = createConfig({ wsManagerEnabled: true });
        client = new DexalotClient(config);
        const init = await client.initializeClient();
        if (!init.success) {
            console.log(`✗ Cannot initialize client: ${init.error}`);
            return;
        }

        await exampleBasicSubscription(client);
        await exampleMultipleSubscriptions(client);
        await examplePrivateSubscription(client);
        await exampleReconnectionHandling();
        await exampleHeartbeatMonitoring();
        await exampleTimedSubscription(client);
        await exampleCleanup(client);

        console.log('\n' + '='.repeat(60));
        console.log('All examples completed successfully!');
        console.log('='.repeat(60));
        console.log('\nKey Takeaways:');
        console.log('  1. Enable WebSocket manager via createConfig({ wsManagerEnabled: true })');
        console.log('  2. Use subscribeToEvents() for persistent connections');
        console.log('  3. Use a subscribe / sleep / unsubscribe pattern for timed connections');
        console.log('  4. Manager handles reconnection and heartbeat automatically');
        console.log('  5. Always clean up with closeWebsocket() when done');
        console.log();
    } catch (e) {
        console.error('\n❌ Error running examples:', e);
        console.error('   Make sure you have a valid .env file with API credentials');
    } finally {
        if (client) {
            await client.close();
        }
    }
}

main();
