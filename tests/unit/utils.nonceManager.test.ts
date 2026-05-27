import { AsyncNonceManager } from '../../src/utils/nonceManager';
import { JsonRpcProvider } from 'ethers';

describe('AsyncNonceManager', () => {
    let manager: AsyncNonceManager;
    let mockProvider: jest.Mocked<JsonRpcProvider>;

    beforeEach(() => {
        manager = new AsyncNonceManager();
        
        mockProvider = {
            getNetwork: jest.fn().mockResolvedValue({ chainId: 43114n }),
            getTransactionCount: jest.fn().mockResolvedValue(5)
        } as any;
    });

    describe('getNonce', () => {
        it('should fetch nonce from chain on first call', async () => {
            const nonce = await manager.getNonce(mockProvider, '0xAddress', 43114);
            
            expect(nonce).toBe(5);
            expect(mockProvider.getTransactionCount).toHaveBeenCalledWith('0xAddress', 'pending');
        });

        it('should increment cached nonce on subsequent calls', async () => {
            await manager.getNonce(mockProvider, '0xAddress', 43114);
            const nonce2 = await manager.getNonce(mockProvider, '0xAddress', 43114);
            const nonce3 = await manager.getNonce(mockProvider, '0xAddress', 43114);
            
            expect(nonce2).toBe(6);
            expect(nonce3).toBe(7);
            expect(mockProvider.getTransactionCount).toHaveBeenCalledTimes(1);
        });

        it('should fetch chainId from provider if not provided', async () => {
            await manager.getNonce(mockProvider, '0xAddress');
            
            expect(mockProvider.getNetwork).toHaveBeenCalled();
            expect(mockProvider.getTransactionCount).toHaveBeenCalledWith('0xAddress', 'pending');
        });

        it('should handle different addresses independently', async () => {
            const nonce1 = await manager.getNonce(mockProvider, '0xAddress1', 43114);
            const nonce2 = await manager.getNonce(mockProvider, '0xAddress2', 43114);
            
            expect(nonce1).toBe(5);
            expect(nonce2).toBe(5);
            expect(mockProvider.getTransactionCount).toHaveBeenCalledTimes(2);
        });

        it('should handle different chainIds independently', async () => {
            const nonce1 = await manager.getNonce(mockProvider, '0xAddress', 43114);
            const nonce2 = await manager.getNonce(mockProvider, '0xAddress', 1);
            
            expect(nonce1).toBe(5);
            expect(nonce2).toBe(5);
            expect(mockProvider.getTransactionCount).toHaveBeenCalledTimes(2);
        });

        it('should be case-insensitive for addresses', async () => {
            await manager.getNonce(mockProvider, '0xADDRESS', 43114);
            const nonce2 = await manager.getNonce(mockProvider, '0xaddress', 43114);
            
            expect(nonce2).toBe(6);
            expect(mockProvider.getTransactionCount).toHaveBeenCalledTimes(1);
        });

        it('should handle concurrent calls safely', async () => {
            const promises = Array.from({ length: 10 }, () =>
                manager.getNonce(mockProvider, '0xAddress', 43114)
            );

            const nonces = await Promise.all(promises);

            // All should be unique and sequential
            expect(new Set(nonces).size).toBe(10);
            expect(Math.min(...nonces)).toBe(5);
            expect(Math.max(...nonces)).toBe(14);
        });

        it('serializes concurrent acquisitions in FIFO order even with awaits in the critical section', async () => {
            // Make the first-call fetch take observable time; subsequent
            // callers must wait their turn in the chain and read the
            // incremented cached nonce in arrival order.
            const resolvers: Array<(n: number) => void> = [];
            (mockProvider.getTransactionCount as jest.Mock).mockReset();
            (mockProvider.getTransactionCount as jest.Mock).mockImplementation(
                () => new Promise<number>((r) => resolvers.push(r))
            );

            const order: number[] = [];
            const promises = Array.from({ length: 5 }, (_, i) =>
                manager.getNonce(mockProvider, '0xAddress', 43114).then((nonce) => {
                    order.push(i);
                    return nonce;
                })
            );

            // Wait for the first caller to reach getTransactionCount.
            while (resolvers.length === 0) await Promise.resolve();
            // Release the first fetch; the rest cascade through the chain
            // using cached + 1 (no further getTransactionCount calls).
            resolvers[0](100);
            const nonces = await Promise.all(promises);

            expect(order).toEqual([0, 1, 2, 3, 4]);
            expect(nonces).toEqual([100, 101, 102, 103, 104]);
            // Only the first caller's path hit the chain.
            expect((mockProvider.getTransactionCount as jest.Mock).mock.calls).toHaveLength(1);
        });

        it('different keys do not block each other (independent chains)', async () => {
            // Caller A on chain 1 holds its lock via a pending fetch; caller
            // B on chain 2 must still be able to acquire and complete because
            // the chains are keyed independently.
            const calls: Array<(n: number) => void> = [];
            (mockProvider.getTransactionCount as jest.Mock).mockReset();
            (mockProvider.getTransactionCount as jest.Mock).mockImplementation(
                () => new Promise<number>((r) => calls.push(r))
            );

            const pA = manager.getNonce(mockProvider, '0xA', 1);
            const pB = manager.getNonce(mockProvider, '0xB', 2);

            // Wait until both have reached getTransactionCount.
            while (calls.length < 2) await Promise.resolve();

            // Resolve B's fetch first. If the chains were entangled, B would
            // be blocked waiting on A.
            calls[1](200);
            const nonceB = await pB;
            expect(nonceB).toBe(200);

            // Now resolve A.
            calls[0](300);
            const nonceA = await pA;
            expect(nonceA).toBe(300);
        });
    });

    describe('resetNonce', () => {
        it('should reset nonce by fetching from chain', async () => {
            await manager.getNonce(mockProvider, '0xAddress', 43114);
            await manager.getNonce(mockProvider, '0xAddress', 43114);
            
            mockProvider.getTransactionCount.mockResolvedValue(10);
            await manager.resetNonce(mockProvider, '0xAddress', 43114);
            
            const nextNonce = await manager.getNonce(mockProvider, '0xAddress', 43114);
            expect(nextNonce).toBe(10);
        });

        it('should fetch chainId from provider if not provided', async () => {
            await manager.resetNonce(mockProvider, '0xAddress');
            
            expect(mockProvider.getNetwork).toHaveBeenCalled();
            expect(mockProvider.getTransactionCount).toHaveBeenCalledWith('0xAddress', 'pending');
        });
    });

    describe('clearNonce', () => {
        it('should clear cached nonce', async () => {
            await manager.getNonce(mockProvider, '0xAddress', 43114);
            
            manager.clearNonce('0xAddress', 43114);
            
            const nonce = await manager.getNonce(mockProvider, '0xAddress', 43114);
            expect(nonce).toBe(5);
            expect(mockProvider.getTransactionCount).toHaveBeenCalledTimes(2);
        });

        it('should not affect other addresses', async () => {
            await manager.getNonce(mockProvider, '0xAddress1', 43114);
            await manager.getNonce(mockProvider, '0xAddress2', 43114);
            
            manager.clearNonce('0xAddress1', 43114);
            
            const nonce2 = await manager.getNonce(mockProvider, '0xAddress2', 43114);
            expect(nonce2).toBe(6); // Should still be incremented
        });
    });

    describe('clearAll', () => {
        it('should clear all cached nonces', async () => {
            await manager.getNonce(mockProvider, '0xAddress1', 43114);
            await manager.getNonce(mockProvider, '0xAddress2', 1);
            
            manager.clearAll();
            
            const nonce1 = await manager.getNonce(mockProvider, '0xAddress1', 43114);
            const nonce2 = await manager.getNonce(mockProvider, '0xAddress2', 1);
            
            expect(nonce1).toBe(5);
            expect(nonce2).toBe(5);
            expect(mockProvider.getTransactionCount).toHaveBeenCalledTimes(4);
        });
    });

    describe('getCachedNonce', () => {
        it('should return cached nonce if exists', async () => {
            await manager.getNonce(mockProvider, '0xAddress', 43114);
            
            const cached = manager.getCachedNonce('0xAddress', 43114);
            expect(cached).toBe(5);
        });

        it('should return undefined if nonce not cached', () => {
            const cached = manager.getCachedNonce('0xAddress', 43114);
            expect(cached).toBeUndefined();
        });
    });
});

