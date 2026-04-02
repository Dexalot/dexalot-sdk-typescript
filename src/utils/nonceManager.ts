import { Provider } from 'ethers';

/**
 * Per-(chainId, address) nonce sequencing for transaction submission.
 */
export class AsyncNonceManager {
    private nonces: Map<string, number> = new Map();
    private locks: Map<string, Promise<void>> = new Map();
    private lockResolvers: Map<string, () => void> = new Map();

    /**
     * Generate a unique key for (address, chainId) pair.
     */
    private getKey(address: string, chainId: number): string {
        return `${chainId}:${address.toLowerCase()}`;
    }

    /**
     * Acquire a lock for the given key.
     */
    private async acquireLock(key: string): Promise<void> {
        // Wait for any existing lock
        const existingLock = this.locks.get(key);
        if (existingLock) {
            await existingLock;
        }

        // Create a new lock
        let resolver: () => void;
        const lock = new Promise<void>(resolve => {
            resolver = resolve;
        });
        this.locks.set(key, lock);
        this.lockResolvers.set(key, resolver!);
    }

    /**
     * Release the lock for the given key.
     */
    private releaseLock(key: string): void {
        const resolver = this.lockResolvers.get(key);
        if (resolver) {
            resolver();
            this.locks.delete(key);
            this.lockResolvers.delete(key);
        }
    }

    /**
     * Get the next nonce for the given address on the given chain.
     * 
     * @param provider - Ethers provider to fetch nonce from chain
     * @param address - The address to get the nonce for
     * @param chainId - Optional chain ID (will be fetched from provider if not provided)
     * @returns The next nonce to use
     */
    async getNonce(
        provider: Provider,
        address: string,
        chainId?: number
    ): Promise<number> {
        // Get chainId if not provided
        const resolvedChainId = chainId ?? Number((await provider.getNetwork()).chainId);
        const key = this.getKey(address, resolvedChainId);

        await this.acquireLock(key);
        
        try {
            let nonce = this.nonces.get(key);

            if (nonce === undefined) {
                // Fetch from chain
                nonce = await provider.getTransactionCount(address, 'pending');
            } else {
                nonce += 1;
            }

            this.nonces.set(key, nonce);
            return nonce;
        } finally {
            this.releaseLock(key);
        }
    }

    /**
     * Reset the nonce for the given address by fetching from chain.
     * 
     * @param provider - Ethers provider to fetch nonce from chain
     * @param address - The address to reset the nonce for
     * @param chainId - Optional chain ID (will be fetched from provider if not provided)
     */
    async resetNonce(
        provider: Provider,
        address: string,
        chainId?: number
    ): Promise<void> {
        const resolvedChainId = chainId ?? Number((await provider.getNetwork()).chainId);
        const key = this.getKey(address, resolvedChainId);

        await this.acquireLock(key);
        
        try {
            const nonce = await provider.getTransactionCount(address, 'pending');
            this.nonces.set(key, nonce - 1); // Set to nonce-1 so next getNonce returns correct value
        } finally {
            this.releaseLock(key);
        }
    }

    /**
     * Clear the cached nonce for the given address (without fetching from chain).
     * 
     * @param address - The address to clear the nonce for
     * @param chainId - The chain ID
     */
    clearNonce(address: string, chainId: number): void {
        const key = this.getKey(address, chainId);
        this.nonces.delete(key);
    }

    /**
     * Clear all cached nonces.
     */
    clearAll(): void {
        this.nonces.clear();
    }

    /**
     * Get the current cached nonce value (for testing/debugging).
     * Returns undefined if no nonce is cached.
     */
    getCachedNonce(address: string, chainId: number): number | undefined {
        const key = this.getKey(address, chainId);
        return this.nonces.get(key);
    }
}
