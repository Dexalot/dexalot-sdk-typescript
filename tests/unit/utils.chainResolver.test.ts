import {
    normalizeChainAlias,
    inferChainFamily,
    inferEnvironmentKind,
    ChainResolver,
} from '../../src/utils/chainResolver';

describe('normalizeChainAlias', () => {
    it('should lowercase the input', () => {
        expect(normalizeChainAlias('Avalanche')).toBe('avalanche');
    });

    it('should collapse hyphens into spaces', () => {
        expect(normalizeChainAlias('avalanche-fuji')).toBe('avalanche fuji');
    });

    it('should collapse underscores into spaces', () => {
        expect(normalizeChainAlias('avalanche_fuji')).toBe('avalanche fuji');
    });

    it('should strip special characters', () => {
        expect(normalizeChainAlias('avalanche!@#fuji')).toBe('avalanche fuji');
    });

    it('should pass through numeric strings', () => {
        expect(normalizeChainAlias('43114')).toBe('43114');
    });

    it('should handle numeric input', () => {
        expect(normalizeChainAlias(43114)).toBe('43114');
    });
});

describe('inferChainFamily', () => {
    it('should infer "avalanche" from name "Avalanche"', () => {
        expect(inferChainFamily('Avalanche', null)).toBe('avalanche');
    });

    it('should infer "avalanche" from name "Fuji"', () => {
        expect(inferChainFamily('Fuji', null)).toBe('avalanche');
    });

    it('should infer "ethereum" from name "Ethereum"', () => {
        expect(inferChainFamily('Ethereum', null)).toBe('ethereum');
    });

    it('should infer "arbitrum" from name "Arbitrum"', () => {
        expect(inferChainFamily('Arbitrum', null)).toBe('arbitrum');
    });

    it('should infer "avalanche" from chain ID 43114', () => {
        expect(inferChainFamily('SomeChain', 43114)).toBe('avalanche');
    });

    it('should infer "ethereum" from chain ID 1', () => {
        expect(inferChainFamily('SomeChain', 1)).toBe('ethereum');
    });

    it('should return null for unknown chain', () => {
        expect(inferChainFamily('UnknownChain', 999999)).toBeNull();
    });
});

describe('inferEnvironmentKind', () => {
    it('should return "testnet" for chain ID 43113', () => {
        expect(inferEnvironmentKind('SomeChain', 43113)).toBe('testnet');
    });

    it('should return "mainnet" for chain ID 43114', () => {
        expect(inferEnvironmentKind('SomeChain', 43114)).toBe('mainnet');
    });

    it('should return "testnet" when name contains "Fuji"', () => {
        expect(inferEnvironmentKind('Fuji', null)).toBe('testnet');
    });

    it('should return "mainnet" when name contains "mainnet"', () => {
        expect(inferEnvironmentKind('Avalanche mainnet', null)).toBe('mainnet');
    });

    it('should return null for unknown chain', () => {
        expect(inferEnvironmentKind('UnknownChain', 999999)).toBeNull();
    });
});

describe('ChainResolver.resolve', () => {
    const chainConfig = {
        Fuji: { chain_id: 43113 },
        Avalanche: { chain_id: 43114 },
    };

    it('should resolve by exact canonical name', () => {
        const resolver = new ChainResolver(chainConfig, null, null);
        const result = resolver.resolve('Fuji');
        expect(result.success).toBe(true);
        expect(result.data!.canonicalName).toBe('Fuji');
        expect(result.data!.chainId).toBe(43113);
    });

    it('should resolve "avax testnet" alias to Fuji', () => {
        const resolver = new ChainResolver(chainConfig, null, null);
        const result = resolver.resolve('avax testnet');
        expect(result.success).toBe(true);
        expect(result.data!.canonicalName).toBe('Fuji');
    });

    it('should resolve generic "avalanche" alias using active chainId', () => {
        const resolver = new ChainResolver(chainConfig, 43114, null);
        const result = resolver.resolve('avalanche');
        expect(result.success).toBe(true);
        expect(result.data!.canonicalName).toBe('Avalanche');
        expect(result.data!.chainId).toBe(43114);
    });

    it('should resolve numeric chain ID "43113" to Fuji', () => {
        const resolver = new ChainResolver(chainConfig, null, null);
        const result = resolver.resolve('43113');
        expect(result.success).toBe(true);
        expect(result.data!.canonicalName).toBe('Fuji');
    });

    it('should fail for unknown chain "solana"', () => {
        const resolver = new ChainResolver(chainConfig, null, null);
        const result = resolver.resolve('solana');
        expect(result.success).toBe(false);
        expect(result.error).toContain('not recognized');
    });

    it('should resolve "dexalot" to Dexalot L1 when includeDexalotL1 is true', () => {
        const resolver = new ChainResolver(chainConfig, null, 432204);
        const result = resolver.resolve('dexalot', true);
        expect(result.success).toBe(true);
        expect(result.data!.canonicalName).toBe('Dexalot L1');
    });

    it('should fail for empty string', () => {
        const resolver = new ChainResolver(chainConfig, null, null);
        const result = resolver.resolve('');
        expect(result.success).toBe(false);
        expect(result.error).toContain('non-empty');
    });

    it('should fail when no connected chains are available', () => {
        const resolver = new ChainResolver({}, null, null);
        const result = resolver.resolve('avalanche');
        expect(result.success).toBe(false);
        expect(result.error).toContain('No connected chains');
    });

    it('should resolve numeric chain ID as number', () => {
        const resolver = new ChainResolver(chainConfig, null, null);
        const result = resolver.resolve(43113);
        expect(result.success).toBe(true);
        expect(result.data!.canonicalName).toBe('Fuji');
    });

    it('should return null from resolveSpecialChain when includeDexalotL1 is false', () => {
        // "dexalot" is a dexalot alias but without includeDexalotL1, it should not match as special
        const resolver = new ChainResolver(chainConfig, null, null);
        const result = resolver.resolve('dexalot');
        expect(result.success).toBe(false);
        expect(result.error).toContain('not recognized');
    });

    it('should resolve "dexalot" to Dexalot L1 with numeric chain ID when not in resolvable chains', () => {
        // Dexalot L1 IS in chains when includeDexalotL1=true but there are no connected chains with "Dexalot L1" canonical name
        const resolver = new ChainResolver(chainConfig, null, 432204);
        const result = resolver.resolve('dexalot subnet', true);
        expect(result.success).toBe(true);
        expect(result.data!.canonicalName).toBe('Dexalot L1');
    });

    it('should handle numeric chain ID that does not match any chain', () => {
        const resolver = new ChainResolver(chainConfig, null, null);
        const result = resolver.resolve('99999');
        // Falls through to alias matching which also won't match
        expect(result.success).toBe(false);
    });
});

describe('inferChainFamily - bsc and base coverage', () => {
    it('should infer "bsc" from name containing "bsc"', () => {
        expect(inferChainFamily('BSC Testnet', null)).toBe('bsc');
    });

    it('should infer "bsc" from chain ID 56', () => {
        expect(inferChainFamily('SomeChain', 56)).toBe('bsc');
    });

    it('should infer "bsc" from chain ID 97 (testnet)', () => {
        expect(inferChainFamily('SomeChain', 97)).toBe('bsc');
    });

    it('should infer "base" from name containing "base"', () => {
        expect(inferChainFamily('Base Mainnet', null)).toBe('base');
    });

    it('should infer "base" from chain ID 8453', () => {
        expect(inferChainFamily('SomeChain', 8453)).toBe('base');
    });

    it('should infer "base" from chain ID 84532 (testnet)', () => {
        expect(inferChainFamily('SomeChain', 84532)).toBe('base');
    });

    it('should infer "monad" from name containing "monad"', () => {
        expect(inferChainFamily('Monad Testnet', null)).toBe('monad');
    });

    it('should infer "monad" from chain ID 10143', () => {
        expect(inferChainFamily('SomeChain', 10143)).toBe('monad');
    });
});

describe('ChainResolver - mismatch and ambiguity errors', () => {
    it('should return mismatch error when alias specifies testnet but client is on mainnet', () => {
        const resolver = new ChainResolver(
            { 'Avalanche': { chain_id: 43114 } },
            null,
            null
        );
        // "avax testnet" specifically maps to testnet, but client only has mainnet Avalanche
        const result = resolver.resolve('avax testnet');
        expect(result.success).toBe(false);
        expect(result.error).toContain('refers to testnet');
        expect(result.error).toContain('mainnet');
    });

    it('should return mismatch error when alias specifies mainnet but client is on testnet', () => {
        const resolver = new ChainResolver(
            { 'Fuji': { chain_id: 43113 } },
            null,
            null
        );
        // "avax mainnet" specifically maps to mainnet, but client only has testnet Fuji
        const result = resolver.resolve('avax mainnet');
        expect(result.success).toBe(false);
        expect(result.error).toContain('refers to mainnet');
        expect(result.error).toContain('testnet');
    });

    it('should return ambiguous error when generic alias matches multiple chains and no active chainId', () => {
        // Two chains in same family, generic alias, no chainId to disambiguate
        const resolver = new ChainResolver(
            {
                'Fuji': { chain_id: 43113 },
                'Avalanche': { chain_id: 43114 },
            },
            null,
            null
        );
        // "avalanche chain" is a generic alias matching family "avalanche"
        // Both Fuji and Avalanche have family "avalanche", and no chainId to disambiguate
        const result = resolver.resolve('avalanche chain');
        expect(result.success).toBe(false);
        expect(result.error).toContain('ambiguous');
    });

    it('should prefer active chain when generic alias matches multiple chains', () => {
        const resolver = new ChainResolver(
            {
                'Fuji': { chain_id: 43113 },
                'Avalanche': { chain_id: 43114 },
            },
            43113,  // active chain is Fuji
            null
        );
        // "avalanche chain" generic alias, resolved via active chainId
        const result = resolver.resolve('avalanche chain');
        expect(result.success).toBe(true);
        expect(result.data!.canonicalName).toBe('Fuji');
    });
});

describe('ChainResolver - describeEnvironmentKind null path', () => {
    it('should use "current environment" text when chain has null environmentKind', () => {
        // Create a chain with an unknown chain ID (999999) and a name that doesn't hint
        // at testnet/mainnet. The family must match a known alias though.
        // Use "BscCustom" so family = "bsc", but env kind = null (999999 not in known sets)
        const resolver = new ChainResolver(
            { 'BscCustom': { chain_id: 999999 } },
            null,
            null
        );
        // "bsc testnet" alias maps to bsc/testnet, but BscCustom has family=bsc, envKind=null
        // The mismatch error path should call describeEnvironmentKind(null) -> "current environment"
        const result = resolver.resolve('bsc testnet');
        expect(result.success).toBe(false);
        expect(result.error).toContain('current environment');
    });
});

describe('ChainResolver - resolveNumericChain no match', () => {
    it('should fall through when numeric chain ID matches no configured chain', () => {
        const resolver = new ChainResolver(
            { 'Fuji': { chain_id: 43113 } },
            null,
            null
        );
        // 99999 is numeric but doesn't match any chain_id
        const result = resolver.resolve('99999');
        expect(result.success).toBe(false);
        expect(result.error).toContain('not recognized');
    });
});

describe('ChainResolver - chain_id ?? null fallback', () => {
    it('should use null when chain config entry has no chain_id field', () => {
        const resolver = new ChainResolver(
            { 'CustomChain': {} as any },
            null,
            null
        );
        // CustomChain has no chain_id, so config.chain_id ?? null yields null
        // Resolving by name should still work (exact match)
        const result = resolver.resolve('CustomChain');
        expect(result.success).toBe(true);
        expect(result.data!.canonicalName).toBe('CustomChain');
        expect(result.data!.chainId).toBeNull();
    });
});

describe('ChainResolver - preferActiveChain no match', () => {
    it('should return ambiguous error when active chainId does not match any candidate', () => {
        // Two avalanche-family chains, but active chainId is something else entirely
        const resolver = new ChainResolver(
            {
                'Fuji': { chain_id: 43113 },
                'AvalancheMainnet': { chain_id: 43114 },
            },
            999, // active chainId doesn't match either candidate
            null
        );
        // "avax chain" is a generic avalanche alias (not an exact chain name match)
        // Both Fuji and AvalancheMainnet have family=avalanche, so 2 candidates
        // With chainId=999, preferActiveChain can't disambiguate -> ambiguous error
        const result = resolver.resolve('avax chain');
        expect(result.success).toBe(false);
        expect(result.error).toContain('ambiguous');
    });
});

describe('ChainResolver - resolveSpecialChain non-dexalot alias with includeDexalotL1=true', () => {
    it('should return null from resolveSpecialChain for non-Dexalot alias and fall through', () => {
        const resolver = new ChainResolver(
            { 'Fuji': { chain_id: 43113 } },
            null,
            432204
        );
        // "Fuji" is not a Dexalot chain alias, so resolveSpecialChain returns null
        // even though includeDexalotL1=true, then falls through to exact match
        const result = resolver.resolve('Fuji', true);
        expect(result.success).toBe(true);
        expect(result.data!.canonicalName).toBe('Fuji');
    });
});
