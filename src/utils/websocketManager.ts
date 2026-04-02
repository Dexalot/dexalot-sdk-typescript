/**
 * WebSocket manager for persistent connections.
 * Matches Python SDK's WebSocketManager implementation.
 * 
 * Note: This module uses the 'ws' package for Node.js environments.
 * In browser environments, the native WebSocket API is used.
 */

import { getLogger } from './observability.js';

const wsLogger = getLogger('dexalot_sdk.websocket');

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** ReadyState when socket is open (avoids DOM vs undici `WebSocket` static typing clashes). */
const WS_OPEN = 1;

/**
 * Narrow WebSocket surface used here — `@types/node` can expose undici's WebSocket, which does not
 * match the DOM `WebSocket` type expected by some TS configs.
 */
type WsConnection = {
    readonly readyState: number;
    close(): void;
    send(data: string): void;
    onopen: ((event: unknown) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
};

export type MessageCallback = (data: any) => void;

/** Optional Dexalot private-topic auth (matches Python WebSocketManager). */
export interface WebSocketDexalotAuth {
    getAddress(): Promise<string>;
    signMessage(message: string): Promise<string>;
}

export interface WebSocketDexalotOptions {
    /** Milliseconds added to auth timestamp (clock skew), default from env parity */
    wsTimeOffsetMs?: number;
    auth?: WebSocketDexalotAuth;
}

export interface WebSocketConfig {
    /** Seconds between ping messages (default: 30) */
    pingInterval?: number;
    /** Seconds to wait for pong before reconnecting (default: 10) */
    pingTimeout?: number;
    /** Initial reconnect delay in ms (default: 1000) */
    reconnectInitialDelay?: number;
    /** Maximum reconnect delay in ms (default: 60000) */
    reconnectMaxDelay?: number;
    /** Exponential backoff multiplier (default: 2.0) */
    reconnectExponentialBase?: number;
    /** Maximum reconnection attempts, 0 = infinite (default: 10) */
    reconnectMaxAttempts?: number;
}

const DEFAULT_CONFIG: Required<WebSocketConfig> = {
    pingInterval: 30,
    pingTimeout: 10,
    reconnectInitialDelay: 1000,
    reconnectMaxDelay: 60000,
    reconnectExponentialBase: 2.0,
    reconnectMaxAttempts: 10,
};

export interface OrderbookSubscriptionMeta {
    kind: 'orderbook';
    pair: string;
    decimal: number;
}

interface Subscription {
    topic: string;
    callback: MessageCallback;
    isPrivate: boolean;
    meta?: OrderbookSubscriptionMeta | null;
}

/**
 * WebSocket manager with auto-reconnection, heartbeat, and subscription management.
 */
export class WebSocketManager {
    private ws: WsConnection | null = null;
    private state: ConnectionState = 'disconnected';
    private subscriptions: Map<string, Subscription> = new Map();
    private reconnectAttempts: number = 0;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private pongTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly wsUrl: string;
    private readonly config: Required<WebSocketConfig>;
    private readonly dexalot: WebSocketDexalotOptions;
    /** Legacy static signature for private topics when `dexalot.auth` is not set. */
    private legacyAuthSignature: string | null = null;

    constructor(wsUrl: string, config: WebSocketConfig = {}, dexalot: WebSocketDexalotOptions = {}) {
        this.wsUrl = wsUrl;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.dexalot = dexalot;
    }

    /**
     * Set a static signature for private subscriptions (tests / simple integrations).
     * When `dexalot.auth` is provided in the constructor, that takes precedence.
     */
    setAuthSignature(signature: string): void {
        this.legacyAuthSignature = signature;
    }

    /**
     * Connect to the WebSocket server.
     */
    connect(): void {
        if (this.state === 'connected' || this.state === 'connecting') {
            return;
        }

        this.state = 'connecting';
        
        try {
            const WsCtor = (globalThis as unknown as { WebSocket: new (url: string) => WsConnection })
                .WebSocket;
            this.ws = new WsCtor(this.wsUrl);
            this.setupEventHandlers();
        } catch (error) {
            console.error('WebSocket connection error:', error);
            this.scheduleReconnect();
        }
    }

    /**
     * Set up WebSocket event handlers.
     */
    private setupEventHandlers(): void {
        if (!this.ws) return;

        this.ws.onopen = () => {
            this.state = 'connected';
            this.reconnectAttempts = 0;
            this.startPingInterval();
            this.resubscribeAll();
        };

        this.ws.onclose = () => {
            this.cleanup();
            if (this.state !== 'disconnected') {
                this.scheduleReconnect();
            }
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        this.ws.onmessage = (event) => {
            const d: unknown = event.data;
            if (typeof d === 'string' || Buffer.isBuffer(d)) {
                this.handleMessage(d);
            } else {
                this.handleMessage(String(d));
            }
        };
    }

    /**
     * Handle incoming WebSocket message.
     */
    private handleMessage(data: string | Buffer): void {
        // Reset pong timer on any message (treat as pong)
        this.resetPongTimer();

        try {
            const message = JSON.parse(data.toString()) as Record<string, unknown>;

            // Dexalot order book stream (docs/websocket.md)
            if (message['type'] === 'orderBooks' && message['pair']) {
                const pair = message['pair'] as string;
                for (const [, sub] of this.subscriptions) {
                    if (sub.meta?.kind === 'orderbook' && sub.meta.pair === pair) {
                        try {
                            sub.callback(message);
                        } catch {
                            /* ignore callback errors */
                        }
                    }
                }
                return;
            }

            // Wrapped message shape
            if (message['type'] === 'message' && message['data']) {
                const inner = message['data'] as Record<string, unknown>;
                const topic = (inner['topic'] || message['topic']) as string | undefined;
                if (topic && this.subscriptions.has(topic)) {
                    const sub = this.subscriptions.get(topic)!;
                    sub.callback(message['data']);
                }
            }

            // Topic-keyed routing
            const topicField = message['topic'] as string | undefined;
            if (topicField && this.subscriptions.has(topicField)) {
                const sub = this.subscriptions.get(topicField)!;
                sub.callback(message);
                return;
            }

            for (const [topic, sub] of this.subscriptions) {
                if (message['type'] === topic) {
                    if (sub.meta?.kind === 'orderbook') continue;
                    sub.callback(message);
                }
            }
        } catch {
            // Non-JSON message, ignore
        }
    }

    /**
     * Subscribe to a topic.
     * @param meta When set with kind `orderbook`, sends Dexalot orderbook subscribe wire payload.
     */
    subscribe(
        topic: string,
        callback: MessageCallback,
        isPrivate: boolean = false,
        meta?: OrderbookSubscriptionMeta | null
    ): void {
        this.subscriptions.set(topic, { topic, callback, isPrivate, meta: meta ?? null });

        if (this.state === 'connected') {
            void this.sendSubscription(topic);
        }
    }

    /**
     * Unsubscribe from a topic.
     */
    unsubscribe(topic: string): void {
        const spec = this.subscriptions.get(topic);
        this.subscriptions.delete(topic);

        if (this.state === 'connected' && this.ws && spec) {
            let payload: Record<string, unknown>;
            if (spec.meta?.kind === 'orderbook') {
                payload = {
                    type: 'unsubscribe',
                    data: spec.meta.pair,
                    pair: spec.meta.pair,
                    decimal: spec.meta.decimal,
                };
                void this.appendTraderAddress(payload).then(() => {
                    if (this.ws && this.state === 'connected') {
                        this.ws.send(JSON.stringify(payload));
                    }
                });
            } else {
                payload = { type: 'unsubscribe', topics: [topic] };
                this.ws.send(JSON.stringify(payload));
            }
        }
    }

    private async appendTraderAddress(payload: Record<string, unknown>): Promise<void> {
        const auth = this.dexalot.auth;
        if (!auth) return;
        try {
            const addr = await auth.getAddress();
            if (addr) payload['traderaddress'] = addr;
        } catch {
            /* ignore */
        }
    }

    /**
     * Send subscription message to server.
     */
    private async sendSubscription(topic: string): Promise<void> {
        if (!this.ws || this.state !== 'connected') return;

        const sub = this.subscriptions.get(topic);
        if (!sub) return;

        if (sub.meta?.kind === 'orderbook') {
            const payload: Record<string, unknown> = {
                type: 'subscribe',
                data: sub.meta.pair,
                pair: sub.meta.pair,
                decimal: sub.meta.decimal,
            };
            await this.appendTraderAddress(payload);
            this.ws.send(JSON.stringify(payload));
            return;
        }

        if (sub.isPrivate && this.dexalot.auth) {
            const auth = this.dexalot.auth;
            const address = await auth.getAddress();
            const offset = this.dexalot.wsTimeOffsetMs ?? 0;
            const ts = Date.now() + offset;
            const msgToSign = `${address}${ts}`;
            const signature = await auth.signMessage(msgToSign);
            const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature;
            const payload = {
                type: 'subscribe',
                topics: [topic],
                address,
                signature: sigHex,
                timestamp: ts,
            };
            this.ws.send(JSON.stringify(payload));
            return;
        }

        if (sub.isPrivate && this.legacyAuthSignature) {
            this.ws.send(
                JSON.stringify({
                    type: 'subscribe',
                    topic,
                    signature: this.legacyAuthSignature,
                })
            );
            return;
        }

        this.ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
    }

    /**
     * Resubscribe to all topics after reconnection.
     */
    private resubscribeAll(): void {
        for (const [topic] of this.subscriptions) {
            void this.sendSubscription(topic);
        }
    }

    /**
     * Start ping interval.
     */
    private startPingInterval(): void {
        this.stopPingInterval();

        this.pingTimer = setInterval(() => {
            if (this.ws && this.state === 'connected') {
                try {
                    this.ws.send(JSON.stringify({ type: 'ping' }));
                    this.startPongTimer();
                } catch (error) {
                    // Connection might be broken
                    this.scheduleReconnect();
                }
            }
        }, this.config.pingInterval * 1000);
    }

    /**
     * Stop ping interval.
     */
    private stopPingInterval(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    /**
     * Start pong timeout timer.
     */
    private startPongTimer(): void {
        this.pongTimer = setTimeout(() => {
            console.warn('Pong timeout, reconnecting...');
            this.reconnect();
        }, this.config.pingTimeout * 1000);
    }

    /**
     * Reset pong timer (called when any message is received).
     */
    private resetPongTimer(): void {
        if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
        }
    }

    /**
     * Schedule a reconnection attempt.
     */
    private scheduleReconnect(): void {
        if (this.state === 'disconnected') return;

        if (
            this.config.reconnectMaxAttempts > 0 &&
            this.reconnectAttempts >= this.config.reconnectMaxAttempts
        ) {
            console.error('Max reconnection attempts reached');
            this.state = 'disconnected';
            return;
        }

        this.state = 'reconnecting';
        this.reconnectAttempts++;

        const delay = Math.min(
            this.config.reconnectInitialDelay *
                Math.pow(this.config.reconnectExponentialBase, this.reconnectAttempts - 1),
            this.config.reconnectMaxDelay
        );

        wsLogger.debug(
            `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
        );

        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }

    /**
     * Force reconnection.
     */
    private reconnect(): void {
        this.cleanup();
        this.scheduleReconnect();
    }

    /**
     * Clean up timers and connection.
     */
    private cleanup(): void {
        this.stopPingInterval();
        this.resetPongTimer();
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            
            if (this.ws.readyState === WS_OPEN) {
                this.ws.close();
            }
            this.ws = null;
        }
    }

    /**
     * Disconnect from the WebSocket server.
     */
    disconnect(): void {
        this.state = 'disconnected';
        this.cleanup();
        this.subscriptions.clear();
    }

    /**
     * Check if connected.
     */
    get isConnected(): boolean {
        return this.state === 'connected';
    }

    /**
     * Get current connection state.
     */
    getState(): ConnectionState {
        return this.state;
    }

    /**
     * Get list of subscribed topics.
     */
    getSubscribedTopics(): string[] {
        return Array.from(this.subscriptions.keys());
    }
}
