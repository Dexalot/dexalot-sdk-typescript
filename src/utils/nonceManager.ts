import { Provider } from 'ethers';

/**
 * Per-(chainId, address) nonce sequencing for transaction submission.
 *
 * Acquisitions for the same key serialize through a Promise chain:
 * each caller stores the "released" Promise of the previous caller in
 * the `locks` map (the tail of the chain). The next caller reads that
 * tail, captures it in closure, and stores its own tail. The read /
 * store / await sequence is synchronous from the event loop's
 * perspective, so concurrent acquisitions for the same key never lose
 * their place in line — the previous bug where two waiters could each
 * "see" the same tail and both proceed concurrently is gone.
 *
 * Memory: the `locks` map only holds the latest tail per key.
 * Previously-acquired (and released) Promises are referenced only by
 * the closures of any callers still awaiting them; once all such
 * waiters drain, they become unreachable and are garbage collected.
 *
 * Different (chainId, address) keys never block each other.
 */
export class AsyncNonceManager {
    private nonces: Map<string, number> = new Map();
    /** Latest "released" Promise per key (the tail of the FIFO chain). */
    private locks: Map<string, Promise<void>> = new Map();

    /**
     * Generate a unique key for (address, chainId) pair.
     */
    private getKey(address: string, chainId: number): string {
        return `${chainId}:${address.toLowerCase()}`;
    }

    /**
     * Acquire the lock for `key` and return a `release()` function that
     * the caller MUST invoke to unblock the next waiter. The returned
     * Promise resolves when this caller holds the lock.
     */
    private async acquireLock(key: string): Promise<() => void> {
        const previousPending = this.locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        // Atomically (no microtask boundary): capture the previous tail
        // in `previousPending` and publish ourselves as the new tail.
        this.locks.set(key, released);
        try {
            await previousPending;
        } catch {
            // Previous holder's chain rejected (shouldn't happen with
            // our resolver-only Promise, but defend anyway).
        }
        return () => {
            release();
            // If we're still the tail and no later caller has chained
            // onto us, drop the entry so the map doesn't grow unbounded.
            if (this.locks.get(key) === released) {
                this.locks.delete(key);
            }
        };
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

        const release = await this.acquireLock(key);

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
            release();
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

        const release = await this.acquireLock(key);

        try {
            const nonce = await provider.getTransactionCount(address, 'pending');
            // Set to nonce-1 so the next getNonce returns the correct value.
            this.nonces.set(key, nonce - 1);
        } finally {
            release();
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
