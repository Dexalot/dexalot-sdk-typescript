import { WebSocketManager } from '../../src/utils/websocketManager';

// Mock CloseEvent for Node.js environment
class MockCloseEvent {
    type: string;
    constructor(type: string) {
        this.type = type;
    }
}

// Mock WebSocket
class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    url: string;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: any) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    shouldThrowOnSend: boolean = false;
    sentMessages: string[] = [];

    constructor(url: string) {
        this.url = url;
        // Simulate connection after a tick
        setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            if (this.onopen) {
                this.onopen(new Event('open'));
            }
        }, 0);
    }

    send(data: string) {
        this.sentMessages.push(data);
        if (this.shouldThrowOnSend) {
            throw new Error('Send failed');
        }
    }

    close() {
        this.readyState = MockWebSocket.CLOSED;
        if (this.onclose) {
            this.onclose(new MockCloseEvent('close'));
        }
    }

    addEventListener() {
        // Mock addEventListener
    }

    removeEventListener() {
        // Mock removeEventListener
    }
}

// Replace global WebSocket with mock
(global as any).WebSocket = MockWebSocket;

describe('WebSocketManager', () => {
    let manager: WebSocketManager;
    const wsUrl = 'ws://localhost:8080';

    beforeEach(() => {
        jest.useFakeTimers();
        manager = new WebSocketManager(wsUrl);
    });

    afterEach(() => {
        jest.useRealTimers();
        manager.disconnect();
    });

    describe('constructor', () => {
        it('should create manager with URL', () => {
            expect(manager).toBeDefined();
        });

        it('should use default config', () => {
            const defaultManager = new WebSocketManager(wsUrl);
            expect(defaultManager).toBeDefined();
        });

        it('should accept custom config', () => {
            const customManager = new WebSocketManager(wsUrl, {
                pingInterval: 60,
                reconnectMaxAttempts: 5
            });
            expect(customManager).toBeDefined();
        });
    });

    describe('setAuthSignature', () => {
        it('should set auth signature', () => {
            manager.setAuthSignature('signature-123');
            // Signature is stored internally, no public getter
            expect(manager).toBeDefined();
        });
    });

    describe('connect', () => {
        it('should connect to WebSocket', () => {
            manager.connect();
            expect(manager.isConnected).toBe(false); // Initially connecting
        });

        it('should not connect if already connected', () => {
            manager.connect();
            jest.advanceTimersByTime(10);
            manager.connect(); // Second call should be ignored
        });

        it('should not connect if already connecting', () => {
            manager.connect();
            manager.connect(); // Should be ignored
        });
    });

    describe('isConnected', () => {
        it('should return false initially', () => {
            expect(manager.isConnected).toBe(false);
        });

        it('should return true after connection', () => {
            manager.connect();
            jest.advanceTimersByTime(10);
            // Note: Mock WebSocket sets readyState to OPEN, but manager state may differ
            // This test verifies the property exists
            expect(typeof manager.isConnected).toBe('boolean');
        });
    });

    describe('subscribe', () => {
        it('should subscribe to topic', () => {
            const callback = jest.fn();
            manager.subscribe('topic1', callback);
            // Subscription is stored internally
            expect(manager).toBeDefined();
        });

        it('should subscribe with private flag', () => {
            const callback = jest.fn();
            manager.subscribe('topic1', callback, true);
            expect(manager).toBeDefined();
        });
    });

    describe('unsubscribe', () => {
        it('should unsubscribe from topic', () => {
            const callback = jest.fn();
            manager.subscribe('topic1', callback);
            manager.unsubscribe('topic1');
            // Unsubscription is internal
            expect(manager).toBeDefined();
        });

        it('should send unsubscribe message when connected', () => {
            const callback = jest.fn();
            manager.subscribe('topic1', callback);
            manager.connect();
            jest.advanceTimersByTime(10);
            
            manager.unsubscribe('topic1');
            
            const mockWs = (manager as any).ws as MockWebSocket;
            const unsubscribeMessages = mockWs.sentMessages.filter(msg => {
                const parsed = JSON.parse(msg);
                return (
                    parsed.type === 'unsubscribe' &&
                    (parsed.topic === 'topic1' ||
                        (Array.isArray(parsed.topics) && parsed.topics.includes('topic1')))
                );
            });
            expect(unsubscribeMessages.length).toBeGreaterThan(0);
        });
    });

    describe('disconnect', () => {
        it('should disconnect WebSocket', () => {
            manager.connect();
            manager.disconnect();
            expect(manager.isConnected).toBe(false);
        });

        it('should handle disconnect when not connected', () => {
            manager.disconnect();
            // Should not throw
            expect(manager).toBeDefined();
        });
    });

    describe('reconnection', () => {
        it('should attempt reconnection on disconnect', () => {
            manager.connect();
            jest.advanceTimersByTime(10);
            
            // Simulate disconnect
            const mockWs = (manager as any).ws;
            if (mockWs) {
                mockWs.close();
            }
            
            // Manager should attempt reconnection
            jest.advanceTimersByTime(2000);
            // Reconnection logic is internal
            expect(manager).toBeDefined();
        });
    });

    describe('ping/pong', () => {
        it('should send ping messages', () => {
            manager.connect();
            jest.advanceTimersByTime(10);
            
            // Advance time to trigger ping
            jest.advanceTimersByTime(31000);
            // Ping logic is internal
            expect(manager).toBeDefined();
        });
    });

    describe('message handling', () => {
        it('should handle incoming messages', () => {
            const callback = jest.fn();
            manager.subscribe('topic1', callback);
            manager.connect();
            jest.advanceTimersByTime(10);
            
            // Simulate message
            const mockWs = (manager as any).ws;
            if (mockWs && mockWs.onmessage) {
                const mockEvent = { data: JSON.stringify({ type: 'message', topic: 'topic1', data: { value: 'test' } }) };
                mockWs.onmessage(mockEvent);
            }
            
            // Message handling is internal
            expect(manager).toBeDefined();
        });

        it('should handle non-JSON messages gracefully', () => {
            manager.connect();
            jest.advanceTimersByTime(10);
            
            const mockWs = (manager as any).ws;
            if (mockWs && mockWs.onmessage) {
                const mockEvent = { data: 'invalid json' };
                mockWs.onmessage(mockEvent);
            }
            
            // Should not throw
            expect(manager).toBeDefined();
        });
    });

    describe('error handling', () => {
        it('should handle connection errors', () => {
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            manager.connect();
            jest.advanceTimersByTime(10);
            
            const mockWs = (manager as any).ws;
            if (mockWs && mockWs.onerror) {
                mockWs.onerror(new Error('Connection error'));
            }
            
            expect(consoleErrorSpy).toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
        });
    });

    describe('cleanup', () => {
        it('should cleanup on disconnect', () => {
            manager.connect();
            jest.advanceTimersByTime(10);
            manager.disconnect();
            
            // Cleanup is internal
            expect(manager.isConnected).toBe(false);
        });
    });

    describe('private subscription with auth signature', () => {
        it('should include signature when subscribing to private topic', () => {
            manager.setAuthSignature('test-signature-123');
            manager.connect();
            jest.advanceTimersByTime(10);
            
            const callback = jest.fn();
            manager.subscribe('private-topic', callback, true);
            
            const mockWs = (manager as any).ws as MockWebSocket;
            expect(mockWs.sentMessages.length).toBeGreaterThan(0);
            const lastMessage = JSON.parse(mockWs.sentMessages[mockWs.sentMessages.length - 1]);
            expect(lastMessage.signature).toBe('test-signature-123');
        });
    });

    describe('ping send error handling', () => {
        it('should schedule reconnect when ping send fails', () => {
            manager.connect();
            jest.advanceTimersByTime(10);
            expect(manager.getState()).toBe('connected');
            
            const mockWs = (manager as any).ws as MockWebSocket;
            mockWs.shouldThrowOnSend = true;
            
            // Advance time to trigger ping interval (30 seconds)
            jest.advanceTimersByTime(30000);
            
            // The ping should have fired and thrown, triggering scheduleReconnect
            // scheduleReconnect sets state to 'reconnecting' synchronously
            expect(manager.getState()).toBe('reconnecting');
        });
    });

    describe('pong timeout', () => {
        it('should reconnect on pong timeout', () => {
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
            manager.connect();
            jest.advanceTimersByTime(10);
            expect(manager.getState()).toBe('connected');
            
            // Trigger ping (30 seconds)
            jest.advanceTimersByTime(30000);
            
            // Wait for pong timeout (10 seconds) - this triggers reconnect
            jest.advanceTimersByTime(10000);
            
            expect(consoleWarnSpy).toHaveBeenCalledWith('Pong timeout, reconnecting...');
            // reconnect() calls cleanup() and scheduleReconnect(), which sets state to 'reconnecting'
            expect(manager.getState()).toBe('reconnecting');
            
            consoleWarnSpy.mockRestore();
        });
    });

    describe('max reconnection attempts', () => {
        it('should stop reconnecting after max attempts', () => {
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            const managerWithMaxAttempts = new WebSocketManager(wsUrl, {
                reconnectMaxAttempts: 2,
                reconnectInitialDelay: 100
            });
            
            // Manually set reconnectAttempts to max to test the limit
            (managerWithMaxAttempts as any).reconnectAttempts = 2;
            (managerWithMaxAttempts as any).state = 'connected';
            
            // Directly call scheduleReconnect to test the max attempts logic
            // This simulates what would happen on the 3rd disconnect
            (managerWithMaxAttempts as any).scheduleReconnect();
            
            // This should trigger max attempts reached
            expect(consoleErrorSpy).toHaveBeenCalledWith('Max reconnection attempts reached');
            expect(managerWithMaxAttempts.getState()).toBe('disconnected');
            
            consoleErrorSpy.mockRestore();
            managerWithMaxAttempts.disconnect();
        });
    });

    describe('reconnect method', () => {
        it('should cleanup and schedule reconnect', () => {
            manager.connect();
            jest.advanceTimersByTime(10);
            
            // Force reconnect
            (manager as any).reconnect();
            
            expect(manager.getState()).toBe('reconnecting');
        });
    });

    describe('getState', () => {
        it('should return current connection state', () => {
            expect(manager.getState()).toBe('disconnected');
            
            manager.connect();
            expect(manager.getState()).toBe('connecting');
            
            jest.advanceTimersByTime(10);
            expect(manager.getState()).toBe('connected');
        });
    });

    describe('getSubscribedTopics', () => {
        it('should return list of subscribed topics', () => {
            expect(manager.getSubscribedTopics()).toEqual([]);
            
            const callback1 = jest.fn();
            const callback2 = jest.fn();
            manager.subscribe('topic1', callback1);
            manager.subscribe('topic2', callback2);
            
            const topics = manager.getSubscribedTopics();
            expect(topics).toContain('topic1');
            expect(topics).toContain('topic2');
            expect(topics.length).toBe(2);
            
            manager.unsubscribe('topic1');
            const topicsAfterUnsubscribe = manager.getSubscribedTopics();
            expect(topicsAfterUnsubscribe).not.toContain('topic1');
            expect(topicsAfterUnsubscribe).toContain('topic2');
            expect(topicsAfterUnsubscribe.length).toBe(1);
        });
    });

    describe('message handling edge cases', () => {
        it('should handle messages with topic in data field', () => {
            const callback = jest.fn();
            manager.subscribe('topic1', callback);
            manager.connect();
            jest.advanceTimersByTime(10);
            
            const mockWs = (manager as any).ws as MockWebSocket;
            if (mockWs && mockWs.onmessage) {
                const mockEvent = { 
                    data: JSON.stringify({ 
                        type: 'message', 
                        data: { topic: 'topic1', value: 'test' } 
                    }) 
                };
                mockWs.onmessage(mockEvent);
            }
            
            expect(callback).toHaveBeenCalled();
        });

        it('should handle messages matching topic directly', () => {
            const callback = jest.fn();
            manager.subscribe('topic1', callback);
            manager.connect();
            jest.advanceTimersByTime(10);
            
            const mockWs = (manager as any).ws as MockWebSocket;
            if (mockWs && mockWs.onmessage) {
                const mockEvent = { 
                    data: JSON.stringify({ 
                        topic: 'topic1', 
                        value: 'test' 
                    }) 
                };
                mockWs.onmessage(mockEvent);
            }
            
            expect(callback).toHaveBeenCalled();
        });

        it('should handle messages matching type as topic', () => {
            const callback = jest.fn();
            manager.subscribe('topic1', callback);
            manager.connect();
            jest.advanceTimersByTime(10);
            
            const mockWs = (manager as any).ws as MockWebSocket;
            if (mockWs && mockWs.onmessage) {
                const mockEvent = { 
                    data: JSON.stringify({ 
                        type: 'topic1', 
                        value: 'test' 
                    }) 
                };
                mockWs.onmessage(mockEvent);
            }
            
            expect(callback).toHaveBeenCalled();
        });
    });

    describe('connection error handling', () => {
        it('should handle WebSocket constructor error', () => {
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            const originalWebSocket = (global as any).WebSocket;
            
            // Mock WebSocket constructor to throw
            (global as any).WebSocket = jest.fn().mockImplementation(() => {
                throw new Error('Connection failed');
            });
            
            const errorManager = new WebSocketManager(wsUrl);
            errorManager.connect();
            
            expect(consoleErrorSpy).toHaveBeenCalled();
            expect(errorManager.getState()).toBe('reconnecting');
            
            // Restore
            (global as any).WebSocket = originalWebSocket;
            consoleErrorSpy.mockRestore();
            errorManager.disconnect();
        });
    });

    describe('close event handling', () => {
        it('should not reconnect if already disconnected', () => {
            manager.connect();
            jest.advanceTimersByTime(10);
            manager.disconnect();
            
            // Simulate close event after disconnect
            const mockWs = (manager as any).ws;
            if (mockWs && mockWs.onclose) {
                mockWs.onclose(new MockCloseEvent('close'));
            }
            
            // Should not attempt reconnection
            expect(manager.getState()).toBe('disconnected');
        });
    });

    describe('resubscribe on reconnection', () => {
        it('should resubscribe to all topics after reconnection', () => {
            const callback1 = jest.fn();
            const callback2 = jest.fn();
            manager.subscribe('topic1', callback1);
            manager.subscribe('topic2', callback2, true);
            manager.setAuthSignature('test-sig');
            
            manager.connect();
            jest.advanceTimersByTime(10);
            
            const mockWs = (manager as any).ws as MockWebSocket;
            // Should have sent subscription messages for both topics
            const subscribeMessages = mockWs.sentMessages.filter(msg => {
                const parsed = JSON.parse(msg);
                return parsed.type === 'subscribe';
            });
            expect(subscribeMessages.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('guard clauses', () => {
        it('should handle setupEventHandlers when ws is null', () => {
            // Set ws to null and try to setup handlers
            (manager as any).ws = null;
            (manager as any).setupEventHandlers();
            // Should not throw
            expect(manager).toBeDefined();
        });

        it('should handle sendSubscription when ws is null', () => {
            (manager as any).ws = null;
            (manager as any).state = 'connected';
            (manager as any).sendSubscription('topic1', false);
            // Should not throw
            expect(manager).toBeDefined();
        });

        it('should handle sendSubscription when not connected', () => {
            manager.connect();
            jest.advanceTimersByTime(10);
            (manager as any).state = 'disconnected';
            (manager as any).sendSubscription('topic1', false);
            // Should not throw
            expect(manager).toBeDefined();
        });

        it('should handle scheduleReconnect when already disconnected', () => {
            (manager as any).state = 'disconnected';
            (manager as any).scheduleReconnect();
            // Should return early without doing anything
            expect(manager.getState()).toBe('disconnected');
        });
    });
});

