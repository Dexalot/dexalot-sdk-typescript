/**
 * WebSocket manager for persistent connections.
 * Matches Python SDK's WebSocketManager implementation.
 * 
 * Note: This module uses the 'ws' package for Node.js environments.
 * In browser environments, the native WebSocket API is used.
 */

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type MessageCallback = (data: any) => void;

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

interface Subscription {
    topic: string;
    callback: MessageCallback;
    isPrivate: boolean;
}

/**
 * WebSocket manager with auto-reconnection, heartbeat, and subscription management.
 */
export class WebSocketManager {
    private ws: WebSocket | null = null;
    private state: ConnectionState = 'disconnected';
    private subscriptions: Map<string, Subscription> = new Map();
    private reconnectAttempts: number = 0;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private pongTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly wsUrl: string;
    private readonly config: Required<WebSocketConfig>;
    private authSignature: string | null = null;

    constructor(wsUrl: string, config: WebSocketConfig = {}) {
        this.wsUrl = wsUrl;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Set authentication signature for private subscriptions.
     */
    setAuthSignature(signature: string): void {
        this.authSignature = signature;
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
            this.ws = new WebSocket(this.wsUrl);
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
            this.handleMessage(event.data);
        };
    }

    /**
     * Handle incoming WebSocket message.
     */
    private handleMessage(data: string | Buffer): void {
        // Reset pong timer on any message (treat as pong)
        this.resetPongTimer();

        try {
            const message = JSON.parse(data.toString());
            
            // Check if it's a subscription message
            if (message.type === 'message' && message.data) {
                const topic = message.data.topic || message.topic;
                if (topic && this.subscriptions.has(topic)) {
                    const sub = this.subscriptions.get(topic)!;
                    sub.callback(message.data);
                }
            }
            
            // Broadcast to all subscriptions that match
            for (const [topic, sub] of this.subscriptions) {
                if (message.topic === topic || message.type === topic) {
                    sub.callback(message);
                }
            }
        } catch (error) {
            // Non-JSON message, ignore
        }
    }

    /**
     * Subscribe to a topic.
     */
    subscribe(topic: string, callback: MessageCallback, isPrivate: boolean = false): void {
        this.subscriptions.set(topic, { topic, callback, isPrivate });

        if (this.state === 'connected') {
            this.sendSubscription(topic, isPrivate);
        }
    }

    /**
     * Unsubscribe from a topic.
     */
    unsubscribe(topic: string): void {
        this.subscriptions.delete(topic);

        if (this.state === 'connected' && this.ws) {
            const message = JSON.stringify({
                type: 'unsubscribe',
                topic: topic,
            });
            this.ws.send(message);
        }
    }

    /**
     * Send subscription message to server.
     */
    private sendSubscription(topic: string, isPrivate: boolean): void {
        if (!this.ws || this.state !== 'connected') return;

        const message: any = {
            type: 'subscribe',
            topic: topic,
        };

        if (isPrivate && this.authSignature) {
            message.signature = this.authSignature;
        }

        this.ws.send(JSON.stringify(message));
    }

    /**
     * Resubscribe to all topics after reconnection.
     */
    private resubscribeAll(): void {
        for (const [topic, sub] of this.subscriptions) {
            this.sendSubscription(topic, sub.isPrivate);
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

        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

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
            
            if (this.ws.readyState === WebSocket.OPEN) {
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
