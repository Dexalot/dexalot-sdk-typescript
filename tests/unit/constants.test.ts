import { wsApiUrlForRestBase, WS_API_URL, API_URL } from '../../src/constants';

describe('wsApiUrlForRestBase', () => {
    it('should convert HTTPS URL to wss WebSocket URL', () => {
        expect(wsApiUrlForRestBase('https://api.dexalot.com')).toBe(
            'wss://api.dexalot.com/api/ws'
        );
    });

    it('should convert HTTP URL to ws WebSocket URL', () => {
        expect(wsApiUrlForRestBase('http://localhost:8080')).toBe(
            'ws://localhost:8080/api/ws'
        );
    });

    it('should handle testnet URL', () => {
        expect(wsApiUrlForRestBase('https://api.dexalot-test.com')).toBe(
            'wss://api.dexalot-test.com/api/ws'
        );
    });

    it('should strip trailing slash before building WS URL', () => {
        expect(wsApiUrlForRestBase('https://api.dexalot.com/')).toBe(
            'wss://api.dexalot.com/api/ws'
        );
    });

    it('should default to mainnet when given null', () => {
        const expected = wsApiUrlForRestBase(API_URL.MAINNET);
        expect(wsApiUrlForRestBase(null)).toBe(expected);
    });

    it('should default to mainnet when given undefined', () => {
        const expected = wsApiUrlForRestBase(API_URL.MAINNET);
        expect(wsApiUrlForRestBase(undefined)).toBe(expected);
    });

    it('should throw Error for invalid protocol', () => {
        expect(() => wsApiUrlForRestBase('ftp://api.dexalot.com')).toThrow(Error);
    });
});

describe('WS_API_URL', () => {
    it('should equal wsApiUrlForRestBase called with mainnet URL', () => {
        expect(WS_API_URL).toBe(wsApiUrlForRestBase(API_URL.MAINNET));
    });
});
