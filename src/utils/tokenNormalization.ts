/**
 * Normalize user-supplied token symbols and trading pairs.
 *
 * Applies ASCII case-folding (uppercase), trims whitespace, and maps optional
 * synonyms from data/tokenAliases.json (canonical -> list of aliases) to canonical symbols.
 */

import tokenAliasesData from '../data/tokenAliases.json';

let _aliasMap: Record<string, string> | null = null;

function loadTokenAliasMap(): Record<string, string> {
    if (_aliasMap) return _aliasMap;

    const raw = tokenAliasesData.aliases;
    const out: Record<string, string> = {};

    for (const [canonical, aliases] of Object.entries(raw)) {
        const cu = canonical.trim().toUpperCase();
        for (const alias of aliases) {
            const au = alias.trim().toUpperCase();
            if (au) {
                out[au] = cu;
            }
        }
    }

    _aliasMap = out;
    return out;
}

/**
 * Return canonical token symbol (strip, upper, apply alias map).
 */
export function normalizeTokenSymbol(symbol: string): string {
    const s = symbol.trim().toUpperCase();
    return loadTokenAliasMap()[s] || s;
}

/**
 * Return canonical BASE/QUOTE (each leg normalized like a token symbol).
 */
export function normalizeTradingPair(pair: string): string {
    const trimmed = pair.trim();
    const parts = trimmed.split('/', 2);
    if (parts.length !== 2) {
        return trimmed.toUpperCase();
    }
    const base = parts[0].trim();
    const quote = parts[1].trim();
    return `${normalizeTokenSymbol(base)}/${normalizeTokenSymbol(quote)}`;
}
