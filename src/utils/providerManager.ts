import { JsonRpcProvider, Provider } from 'ethers';

/**
 * Provider health tracking.
 */
interface ProviderHealth {
    failureCount: number;
    lastFailure: number;
    isHealthy: boolean;
}

/**
 * Provider manager configuration.
 */
export interface ProviderManagerConfig {
    /** Cooldown period in ms before retrying failed provider (default: 60000) */
    failoverCooldown?: number;
    /** Max failures before marking provider unhealthy (default: 3) */
    maxFailures?: number;
}

const DEFAULT_CONFIG: Required<ProviderManagerConfig> = {
    failoverCooldown: 60000,
    maxFailures: 3,
};

/**
 * RPC provider failover manager.
 * Tracks provider health and automatically fails over to healthy providers.
 * Matches Python SDK's ProviderManager implementation.
 */
export class ProviderManager {
    private providers: Map<string, JsonRpcProvider[]> = new Map();
    private health: Map<string, ProviderHealth[]> = new Map();
    private readonly config: Required<ProviderManagerConfig>;

    constructor(config: ProviderManagerConfig = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Add providers for a chain.
     * 
     * @param chainName - Name of the chain (e.g., "Avalanche", "Fuji")
     * @param rpcUrls - List of RPC URLs (primary first, fallbacks after)
     */
    addProviders(chainName: string, rpcUrls: string[]): void {
        if (!rpcUrls || rpcUrls.length === 0) {
            return;
        }

        const providers: JsonRpcProvider[] = [];
        const healthList: ProviderHealth[] = [];

        for (const url of rpcUrls) {
            try {
                providers.push(new JsonRpcProvider(url));
                healthList.push({
                    failureCount: 0,
                    lastFailure: 0,
                    isHealthy: true,
                });
            } catch (error) {
                // Skip invalid URLs
                console.warn(`Failed to create provider for ${url}:`, error);
            }
        }

        if (providers.length > 0) {
            this.providers.set(chainName, providers);
            this.health.set(chainName, healthList);
        }
    }

    /**
     * Get the first healthy provider for a chain.
     * Returns null if no healthy providers are available.
     * 
     * @param chainName - Name of the chain
     * @returns Provider or null
     */
    getProvider(chainName: string): Provider | null {
        const providers = this.providers.get(chainName);
        const healthList = this.health.get(chainName);

        if (!providers || !healthList || providers.length === 0) {
            return null;
        }

        const now = Date.now();

        // First pass: find a healthy provider
        for (let i = 0; i < providers.length; i++) {
            if (healthList[i].isHealthy) {
                return providers[i];
            }
        }

        // Second pass: check if any unhealthy provider has cooled down
        for (let i = 0; i < providers.length; i++) {
            const health = healthList[i];
            if (!health.isHealthy && now - health.lastFailure >= this.config.failoverCooldown) {
                // Reset and try again
                health.isHealthy = true;
                health.failureCount = 0;
                return providers[i];
            }
        }

        // All providers unhealthy and still in cooldown
        return null;
    }

    /**
     * Get the number of providers for a chain.
     */
    getProviderCount(chainName: string): number {
        return this.providers.get(chainName)?.length ?? 0;
    }

    /**
     * Get the index of a provider for a chain.
     */
    getProviderIndex(chainName: string, provider: Provider): number | null {
        const providers = this.providers.get(chainName);
        if (!providers) return null;

        const index = providers.indexOf(provider as JsonRpcProvider);
        return index >= 0 ? index : null;
    }

    /**
     * Mark a provider as failed.
     * 
     * @param chainName - Name of the chain
     * @param providerIndex - Index of the provider in the chain's provider list
     */
    markFailure(chainName: string, providerIndex: number): void {
        const healthList = this.health.get(chainName);
        if (!healthList || providerIndex < 0 || providerIndex >= healthList.length) {
            return;
        }

        const health = healthList[providerIndex];
        health.failureCount += 1;
        health.lastFailure = Date.now();

        if (health.failureCount >= this.config.maxFailures) {
            health.isHealthy = false;
        }
    }

    /**
     * Mark a provider as successful (reset failure count).
     * 
     * @param chainName - Name of the chain
     * @param providerIndex - Index of the provider
     */
    markSuccess(chainName: string, providerIndex: number): void {
        const healthList = this.health.get(chainName);
        if (!healthList || providerIndex < 0 || providerIndex >= healthList.length) {
            return;
        }

        const health = healthList[providerIndex];
        health.failureCount = 0;
        health.isHealthy = true;
    }

    /**
     * Get health status for all providers on a chain (for debugging/monitoring).
     */
    getHealthStatus(chainName: string): ProviderHealth[] | null {
        const healthList = this.health.get(chainName);
        if (!healthList) return null;
        
        // Return a copy to prevent external modification
        return healthList.map(h => ({ ...h }));
    }

    /**
     * Reset all providers for a chain to healthy state.
     */
    resetChain(chainName: string): void {
        const healthList = this.health.get(chainName);
        if (!healthList) return;

        for (const health of healthList) {
            health.failureCount = 0;
            health.lastFailure = 0;
            health.isHealthy = true;
        }
    }

    /**
     * Get list of chain names with registered providers.
     */
    getChainNames(): string[] {
        return Array.from(this.providers.keys());
    }
}
