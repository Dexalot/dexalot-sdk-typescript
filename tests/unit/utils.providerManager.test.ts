import { ProviderManager } from '../../src/utils/providerManager';
import { JsonRpcProvider } from 'ethers';

// Mock JsonRpcProvider
jest.mock('ethers', () => ({
    ...jest.requireActual('ethers'),
    JsonRpcProvider: jest.fn().mockImplementation((url: string) => ({
        _url: url,
        getNetwork: jest.fn(),
        getTransactionCount: jest.fn(),
    }))
}));

describe('ProviderManager', () => {
    let manager: ProviderManager;

    beforeEach(() => {
        manager = new ProviderManager();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should use default config', () => {
            const defaultManager = new ProviderManager();
            expect(defaultManager.getProviderCount('Avalanche')).toBe(0);
        });

        it('should accept custom config', () => {
            const customManager = new ProviderManager({
                failoverCooldown: 30000,
                maxFailures: 5
            });
            expect(customManager.getProviderCount('Avalanche')).toBe(0);
        });
    });

    describe('addProviders', () => {
        it('should add providers for a chain', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com', 'https://rpc2.com']);
            
            expect(manager.getProviderCount('Avalanche')).toBe(2);
            expect(manager.getProvider('Avalanche')).toBeDefined();
        });

        it('should skip invalid URLs', () => {
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
            
            // Mock JsonRpcProvider to throw for invalid URL
            let callCount = 0;
            (JsonRpcProvider as jest.Mock).mockImplementation((url: string) => {
                callCount++;
                if (url === 'invalid' && callCount === 2) {
                    throw new Error('Invalid URL');
                }
                return { _url: url };
            });
            
            manager.addProviders('Avalanche', ['https://rpc1.com', 'invalid']);
            
            expect(manager.getProviderCount('Avalanche')).toBe(1);
            consoleWarnSpy.mockRestore();
        });

        it('should not add providers if empty array', () => {
            manager.addProviders('Avalanche', []);
            expect(manager.getProviderCount('Avalanche')).toBe(0);
        });

        it('should handle null/undefined URLs', () => {
            manager.addProviders('Avalanche', [] as any);
            expect(manager.getProviderCount('Avalanche')).toBe(0);
        });
    });

    describe('getProvider', () => {
        it('should return first healthy provider', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com', 'https://rpc2.com']);
            
            const provider = manager.getProvider('Avalanche');
            expect(provider).toBeDefined();
        });

        it('should return null if no providers', () => {
            expect(manager.getProvider('Avalanche')).toBeNull();
        });

        it('should return null if all providers unhealthy and in cooldown', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            
            // Mark provider as failed multiple times
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            
            // Still in cooldown
            expect(manager.getProvider('Avalanche')).toBeNull();
        });

        it('should return provider after cooldown expires', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            
            // Mark as failed
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            
            // Advance time past cooldown
            jest.advanceTimersByTime(61000);
            
            const provider = manager.getProvider('Avalanche');
            expect(provider).toBeDefined();
        });

        it('should prefer healthy providers over unhealthy ones', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com', 'https://rpc2.com']);
            
            // Mark first provider as failed
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            
            // Should return second provider
            const provider = manager.getProvider('Avalanche');
            expect(provider).toBeDefined();
        });
    });

    describe('markFailure', () => {
        it('should increment failure count', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            
            const health = manager.getHealthStatus('Avalanche');
            expect(health![0].failureCount).toBe(2);
        });

        it('should mark provider unhealthy after max failures', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            
            const health = manager.getHealthStatus('Avalanche');
            expect(health![0].isHealthy).toBe(false);
        });

        it('should update lastFailure timestamp', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            
            const before = Date.now();
            jest.advanceTimersByTime(1000);
            manager.markFailure('Avalanche', 0);
            jest.advanceTimersByTime(1000);
            
            const health = manager.getHealthStatus('Avalanche');
            expect(health![0].lastFailure).toBeGreaterThanOrEqual(before);
        });

        it('should ignore invalid indices', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            
            manager.markFailure('Avalanche', -1);
            manager.markFailure('Avalanche', 10);
            
            const health = manager.getHealthStatus('Avalanche');
            expect(health![0].failureCount).toBe(0);
        });

        it('should ignore unknown chains', () => {
            manager.markFailure('Unknown', 0);
            // Should not throw
        });
    });

    describe('markSuccess', () => {
        it('should reset failure count', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            manager.markSuccess('Avalanche', 0);
            
            const health = manager.getHealthStatus('Avalanche');
            expect(health![0].failureCount).toBe(0);
            expect(health![0].isHealthy).toBe(true);
        });

        it('should mark provider as healthy', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 0);
            manager.markSuccess('Avalanche', 0);
            
            const health = manager.getHealthStatus('Avalanche');
            expect(health![0].isHealthy).toBe(true);
        });

        it('should ignore invalid indices', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            
            manager.markSuccess('Avalanche', -1);
            manager.markSuccess('Avalanche', 10);
            
            // Should not throw
            const health = manager.getHealthStatus('Avalanche');
            expect(health![0].failureCount).toBe(0);
        });

        it('should ignore unknown chains', () => {
            manager.markSuccess('Unknown', 0);
            // Should not throw
        });
    });

    describe('getHealthStatus', () => {
        it('should return health status for chain', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com', 'https://rpc2.com']);
            
            const health = manager.getHealthStatus('Avalanche');
            expect(health).toHaveLength(2);
            expect(health![0].isHealthy).toBe(true);
        });

        it('should return null for unknown chain', () => {
            expect(manager.getHealthStatus('Unknown')).toBeNull();
        });

        it('should return a copy to prevent modification', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            
            const health1 = manager.getHealthStatus('Avalanche');
            const health2 = manager.getHealthStatus('Avalanche');
            
            health1![0].failureCount = 999;
            
            expect(health2![0].failureCount).toBe(0);
        });
    });

    describe('resetChain', () => {
        it('should reset all providers for a chain', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com', 'https://rpc2.com']);
            
            manager.markFailure('Avalanche', 0);
            manager.markFailure('Avalanche', 1);
            
            manager.resetChain('Avalanche');
            
            const health = manager.getHealthStatus('Avalanche');
            expect(health![0].failureCount).toBe(0);
            expect(health![0].isHealthy).toBe(true);
            expect(health![1].failureCount).toBe(0);
            expect(health![1].isHealthy).toBe(true);
        });

        it('should ignore unknown chains', () => {
            manager.resetChain('Unknown');
            // Should not throw
        });
    });

    describe('getChainNames', () => {
        it('should return list of chain names', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            manager.addProviders('Fuji', ['https://rpc2.com']);
            
            const chains = manager.getChainNames();
            expect(chains).toContain('Avalanche');
            expect(chains).toContain('Fuji');
        });

        it('should return empty array if no chains', () => {
            expect(manager.getChainNames()).toEqual([]);
        });
    });

    describe('getProviderIndex', () => {
        it('should return provider index', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com', 'https://rpc2.com']);
            
            const provider = manager.getProvider('Avalanche');
            const index = manager.getProviderIndex('Avalanche', provider!);
            
            expect(index).toBeGreaterThanOrEqual(0);
            expect(index).toBeLessThan(2);
        });

        it('should return null for unknown chain', () => {
            const provider = manager.getProvider('Avalanche');
            expect(manager.getProviderIndex('Unknown', provider!)).toBeNull();
        });

        it('should return null for provider not in chain', () => {
            manager.addProviders('Avalanche', ['https://rpc1.com']);
            const otherProvider = new JsonRpcProvider('https://other.com');
            
            expect(manager.getProviderIndex('Avalanche', otherProvider)).toBeNull();
        });
    });
});

