/**
 * Chain alias resolution system.
 *
 * Resolves human-friendly chain names/aliases (e.g., "avax", "fuji testnet")
 * to canonical chain identifiers used by the Dexalot SDK. Matches the
 * Python SDK's resolve_chain_reference() implementation.
 */

import chainAliasesData from '../data/chainAliases.json';
import { Result } from './result.js';
import { KNOWN_CHAIN_IDS } from '../constants.js';

// Known chain IDs for environment inference
const TESTNET_CHAIN_IDS = new Set([KNOWN_CHAIN_IDS.AVAX_FUJI, 97, 84532, 10143, 11155111, 421614]);
const MAINNET_CHAIN_IDS = new Set([KNOWN_CHAIN_IDS.AVAX_MAINNET, 1, 56, 8453, 42161]);

export interface ResolvedChain {
    canonicalName: string;
    chainId: number | null;
    family: string | null;
    environmentKind: string | null;
    matchedAlias: string;
}

interface ChainConfig {
    chain_id: number;
    [key: string]: any;
}

interface NormalizedAliasEntry {
    connectedChain: string;
    genericAliases: Set<string>;
    testnetAliases: Set<string>;
    mainnetAliases: Set<string>;
}

interface NormalizedDexalotChain {
    canonicalName: string;
    genericAliases: Set<string>;
    testnetAliases: Set<string>;
    mainnetAliases: Set<string>;
}

/**
 * Normalize a chain reference by collapsing separators and case differences.
 */
export function normalizeChainAlias(chainReference: string | number): string {
    let normalized = String(chainReference).trim().toLowerCase();
    normalized = normalized.replace(/[-_/]+/g, ' ');
    normalized = normalized.replace(/[^a-z0-9\s]/g, ' ');
    return normalized.replace(/\s+/g, ' ').trim();
}

// Cache for the loaded and normalized registry
let _cachedRegistry: { connectedChains: NormalizedAliasEntry[]; dexalotChain: NormalizedDexalotChain } | null = null;

function loadChainAliasRegistry() {
    if (_cachedRegistry) return _cachedRegistry;

    const connectedChains: NormalizedAliasEntry[] = [];
    for (const entry of chainAliasesData.connected_chains) {
        connectedChains.push({
            connectedChain: entry.connected_chain.trim().toLowerCase(),
            genericAliases: new Set(
                entry.generic_aliases.filter((a: string) => a.trim()).map((a: string) => normalizeChainAlias(a))
            ),
            testnetAliases: new Set(
                entry.testnet_aliases.filter((a: string) => a.trim()).map((a: string) => normalizeChainAlias(a))
            ),
            mainnetAliases: new Set(
                entry.mainnet_aliases.filter((a: string) => a.trim()).map((a: string) => normalizeChainAlias(a))
            ),
        });
    }

    const dc = chainAliasesData.dexalot_chain;
    const dexalotChain: NormalizedDexalotChain = {
        canonicalName: dc.canonical_name,
        genericAliases: new Set(
            dc.generic_aliases.filter((a: string) => a.trim()).map((a: string) => normalizeChainAlias(a))
        ),
        testnetAliases: new Set(
            dc.testnet_aliases.filter((a: string) => a.trim()).map((a: string) => normalizeChainAlias(a))
        ),
        mainnetAliases: new Set(
            dc.mainnet_aliases.filter((a: string) => a.trim()).map((a: string) => normalizeChainAlias(a))
        ),
    };

    _cachedRegistry = { connectedChains, dexalotChain };
    return _cachedRegistry;
}

/**
 * Infer the chain family from canonical name and chain ID.
 */
export function inferChainFamily(canonicalName: string, chainId: number | null): string | null {
    const normalized = normalizeChainAlias(canonicalName);
    if (
        chainId === KNOWN_CHAIN_IDS.AVAX_FUJI || chainId === KNOWN_CHAIN_IDS.AVAX_MAINNET ||
        ['avalanche', 'avax', 'fuji'].some(t => normalized.includes(t))
    ) return 'avalanche';
    if (
        chainId === 1 || chainId === 11155111 ||
        ['ethereum', 'eth', 'sepolia'].some(t => normalized.includes(t))
    ) return 'ethereum';
    if (
        chainId === 42161 || chainId === 421614 ||
        ['arbitrum', 'arb'].some(t => normalized.includes(t))
    ) return 'arbitrum';
    if (
        chainId === 56 || chainId === 97 ||
        ['bsc', 'binance', 'bnb', 'chapel'].some(t => normalized.includes(t))
    ) return 'bsc';
    if (
        chainId === 8453 || chainId === 84532 ||
        ['base', 'coinbase'].some(t => normalized.includes(t))
    ) return 'base';
    if (chainId === 10143 || normalized.includes('monad')) return 'monad';
    return null;
}

/**
 * Infer environment kind (testnet/mainnet) from canonical name and chain ID.
 */
export function inferEnvironmentKind(canonicalName: string, chainId: number | null): string | null {
    const normalized = normalizeChainAlias(canonicalName);
    if (chainId !== null && TESTNET_CHAIN_IDS.has(chainId)) return 'testnet';
    if (chainId !== null && MAINNET_CHAIN_IDS.has(chainId)) return 'mainnet';
    if (['testnet', 'fuji', 'chapel', 'sepolia'].some(t => normalized.includes(t))) return 'testnet';
    if (normalized.includes('mainnet')) return 'mainnet';
    return null;
}

/**
 * Chain resolver that uses client state (chainConfig, chainId, subnetChainId)
 * to resolve human-friendly chain references to canonical chain info.
 */
export class ChainResolver {
    private chainConfig: Record<string, ChainConfig>;
    private chainId: number | null;
    private subnetChainId: number | null;

    constructor(
        chainConfig: Record<string, ChainConfig>,
        chainId: number | null,
        subnetChainId: number | null
    ) {
        this.chainConfig = chainConfig;
        this.chainId = chainId;
        this.subnetChainId = subnetChainId;
    }

    /**
     * Build the list of resolvable chains from current client config.
     */
    private getResolvableChains(includeDexalotL1: boolean): ResolvedChain[] {
        const chains: ResolvedChain[] = [];
        if (includeDexalotL1) {
            chains.push({
                canonicalName: 'Dexalot L1',
                chainId: this.subnetChainId,
                family: null,
                environmentKind: null,
                matchedAlias: 'Dexalot L1',
            });
        }
        for (const [name, config] of Object.entries(this.chainConfig)) {
            const cid = config.chain_id ?? null;
            chains.push({
                canonicalName: name,
                chainId: cid,
                family: inferChainFamily(name, cid),
                environmentKind: inferEnvironmentKind(name, cid),
                matchedAlias: name,
            });
        }
        return chains;
    }

    private static resolvedChain(chain: ResolvedChain, matchedAlias: string | number): Result<ResolvedChain> {
        return Result.ok({
            canonicalName: chain.canonicalName,
            chainId: chain.chainId,
            family: chain.family,
            environmentKind: chain.environmentKind,
            matchedAlias: String(matchedAlias),
        });
    }

    private resolveSpecialChain(normalized: string, chains: ResolvedChain[], ref: string | number): Result<ResolvedChain> | null {
        const dc = loadChainAliasRegistry().dexalotChain;
        const allAliases = new Set([...dc.genericAliases, ...dc.testnetAliases, ...dc.mainnetAliases]);
        if (!allAliases.has(normalized)) return null;
        // When resolveSpecialChain is called, includeDexalotL1 is always true,
        // so getResolvableChains(true) guarantees a Dexalot L1 entry exists.
        const match = chains.find(c => c.canonicalName === dc.canonicalName)!;
        return ChainResolver.resolvedChain(match, ref);
    }

    private resolveNumericChain(normalized: string, chains: ResolvedChain[], ref: string | number): Result<ResolvedChain> | null {
        if (!/^\d+$/.test(normalized)) return null;
        const match = chains.find(c => c.chainId !== null && String(c.chainId) === normalized);
        return match ? ChainResolver.resolvedChain(match, ref) : null;
    }

    private resolveExactChain(normalized: string, chains: ResolvedChain[], ref: string | number): Result<ResolvedChain> | null {
        const exact = chains.filter(c => normalizeChainAlias(c.canonicalName) === normalized);
        return exact.length === 1 ? ChainResolver.resolvedChain(exact[0], ref) : null;
    }

    private matchAliasGroups(normalized: string): Array<[string, string | null]> {
        const matched: Array<[string, string | null]> = [];
        for (const entry of loadChainAliasRegistry().connectedChains) {
            if (entry.genericAliases.has(normalized)) matched.push([entry.connectedChain, null]);
            if (entry.testnetAliases.has(normalized)) matched.push([entry.connectedChain, 'testnet']);
            if (entry.mainnetAliases.has(normalized)) matched.push([entry.connectedChain, 'mainnet']);
        }
        return matched;
    }

    private static dedupeChains(chains: ResolvedChain[]): ResolvedChain[] {
        const seen = new Map<string, ResolvedChain>();
        for (const c of chains) seen.set(c.canonicalName, c);
        return [...seen.values()];
    }

    private candidateChains(chains: ResolvedChain[], matchedGroups: Array<[string, string | null]>): ResolvedChain[] {
        const candidates = chains.filter(chain =>
            matchedGroups.some(([family, reqEnv]) =>
                chain.family === family && (reqEnv === null || chain.environmentKind === reqEnv)
            )
        );
        return ChainResolver.dedupeChains(candidates);
    }

    private preferActiveChain(candidates: ResolvedChain[], ref: string | number): Result<ResolvedChain> | null {
        if (candidates.length === 1) return ChainResolver.resolvedChain(candidates[0], ref);
        if (this.chainId === null) return null;
        const match = candidates.find(c => c.chainId === this.chainId);
        return match ? ChainResolver.resolvedChain(match, ref) : null;
    }

    private static availableChainNames(chains: ResolvedChain[]): string[] {
        return chains.map(c => c.canonicalName).sort();
    }

    /**
     * Resolve a human-friendly chain alias to the canonical connected chain.
     */
    resolve(chainReference: string | number, includeDexalotL1: boolean = false): Result<ResolvedChain> {
        const normalized = normalizeChainAlias(chainReference);
        if (!normalized) return Result.fail('Chain reference must be a non-empty string or chain ID.');

        const chains = this.getResolvableChains(includeDexalotL1);
        if (chains.length === 0) return Result.fail('No connected chains are available for resolution.');

        if (includeDexalotL1) {
            const special = this.resolveSpecialChain(normalized, chains, chainReference);
            if (special) return special;
        }

        const numeric = this.resolveNumericChain(normalized, chains, chainReference);
        if (numeric) return numeric;

        const exact = this.resolveExactChain(normalized, chains, chainReference);
        if (exact) return exact;

        const matchedGroups = this.matchAliasGroups(normalized);
        if (matchedGroups.length === 0) {
            const available = ChainResolver.availableChainNames(chains);
            return Result.fail(`Chain '${chainReference}' is not recognized in the current Dexalot environment. Available chains: ${JSON.stringify(available)}`);
        }

        const candidates = this.candidateChains(chains, matchedGroups);
        const preferred = this.preferActiveChain(candidates, chainReference);
        if (preferred) return preferred;

        // Mismatch error
        const requestedFamilies = new Set(matchedGroups.map(([f]) => f));
        const sameFamily = chains.filter(c => c.family && requestedFamilies.has(c.family));
        const explicitEnv = matchedGroups.find(([, env]) => env !== null)?.[1] ?? null;
        if (sameFamily.length > 0 && explicitEnv !== null) {
            const connected = sameFamily.map(c => c.canonicalName).sort();
            const connectedEnvs = [...new Set(sameFamily.map(c => c.environmentKind).filter((k): k is string => k !== null))].sort();
            const envText = connectedEnvs.join(', ') || 'current environment';
            return Result.fail(
                `Chain '${chainReference}' refers to ${explicitEnv}, but this client is connected to ${envText}. Try one of: ${JSON.stringify(connected)}`
            );
        }

        const available = ChainResolver.availableChainNames(chains);
        return Result.fail(`Chain '${chainReference}' is ambiguous in the current Dexalot environment. Available chains: ${JSON.stringify(available)}`);
    }
}
