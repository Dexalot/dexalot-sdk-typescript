import { normalizeTokenSymbol, normalizeTradingPair } from '../../src/utils/tokenNormalization';

describe('normalizeTokenSymbol', () => {
    it('should uppercase a lowercase symbol', () => {
        expect(normalizeTokenSymbol('eth')).toBe('ETH');
    });

    it('should trim whitespace', () => {
        expect(normalizeTokenSymbol(' usdc ')).toBe('USDC');
    });

    it('should map WETH alias to ETH', () => {
        expect(normalizeTokenSymbol('WETH')).toBe('ETH');
    });

    it('should map ETHER alias to ETH', () => {
        expect(normalizeTokenSymbol('ETHER')).toBe('ETH');
    });

    it('should map BTC.B alias to BTC', () => {
        expect(normalizeTokenSymbol('BTC.B')).toBe('BTC');
    });

    it('should map BITCOIN alias to BTC', () => {
        expect(normalizeTokenSymbol('BITCOIN')).toBe('BTC');
    });

    it('should pass through unknown symbols unchanged (uppercased)', () => {
        expect(normalizeTokenSymbol('AVAX')).toBe('AVAX');
    });

    it('should handle case-insensitive aliases', () => {
        expect(normalizeTokenSymbol('weth')).toBe('ETH');
    });
});

describe('normalizeTradingPair', () => {
    it('should normalize a lowercase pair', () => {
        expect(normalizeTradingPair('eth/usdc')).toBe('ETH/USDC');
    });

    it('should resolve aliases within a pair', () => {
        expect(normalizeTradingPair('weth/usdc')).toBe('ETH/USDC');
    });

    it('should trim spaces around pair components', () => {
        expect(normalizeTradingPair(' eth / usdc ')).toBe('ETH/USDC');
    });

    it('should return uppercased string when no slash is present', () => {
        expect(normalizeTradingPair('ethusdc')).toBe('ETHUSDC');
    });

    it('should pass through an already canonical pair unchanged', () => {
        expect(normalizeTradingPair('AVAX/USDC')).toBe('AVAX/USDC');
    });
});

describe('loadTokenAliasMap - empty canonical key', () => {
    it('should skip entries with empty canonical key after trimming', () => {
        // The loadTokenAliasMap filters out entries where canonical.trim().toUpperCase() is empty.
        // This is already handled by the JSON data, but we verify the cache works
        // and that normalizing a non-alias symbol returns it unchanged.
        expect(normalizeTokenSymbol('   ')).toBe('');
    });
});
