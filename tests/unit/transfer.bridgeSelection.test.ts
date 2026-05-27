import { TransferClient } from '../../src/core/transfer';
import { ACCESS_ID } from '../../src/constants';

class TestClient extends TransferClient {}

describe('TransferClient._getBridgeId — ICM vs. LayerZero selection', () => {
    let client: TestClient;

    beforeEach(() => {
        // _getBridgeId is a pure function over (chainName, useLayerZero) and the
        // ICM_CHAINS constant, so no signer / provider / contract setup is needed.
        client = new TestClient();
    });

    it('selects ICM for an Avalanche-named chain', () => {
        expect(client._getBridgeId('Avalanche', false)).toBe(ACCESS_ID.ICM);
    });

    it('selects ICM for a Fuji-named chain', () => {
        expect(client._getBridgeId('Fuji', false)).toBe(ACCESS_ID.ICM);
    });

    it('selects ICM for a GUNZ-named chain (special-cased outside ICM_CHAINS)', () => {
        // GUNZ uses ICM but is not listed in ICM_CHAINS; the special-case
        // lives in _getBridgeId itself for parity with the Python SDK.
        expect(client._getBridgeId('GUNZ', false)).toBe(ACCESS_ID.ICM);
    });

    it('matches ICM chain names case-insensitively', () => {
        expect(client._getBridgeId('avalanche', false)).toBe(ACCESS_ID.ICM);
        expect(client._getBridgeId('fuji', false)).toBe(ACCESS_ID.ICM);
        expect(client._getBridgeId('gunz-testnet', false)).toBe(ACCESS_ID.ICM);
    });

    it('falls back to LayerZero for any other chain', () => {
        expect(client._getBridgeId('Arbitrum', false)).toBe(ACCESS_ID.LZ);
        expect(client._getBridgeId('Base', false)).toBe(ACCESS_ID.LZ);
        expect(client._getBridgeId('OtherChain', false)).toBe(ACCESS_ID.LZ);
    });

    it('forces LayerZero when useLayerZero=true even on ICM chains', () => {
        expect(client._getBridgeId('Avalanche', true)).toBe(ACCESS_ID.LZ);
        expect(client._getBridgeId('Fuji', true)).toBe(ACCESS_ID.LZ);
        expect(client._getBridgeId('GUNZ', true)).toBe(ACCESS_ID.LZ);
    });

    it('keeps LayerZero when useLayerZero=true on a non-ICM chain', () => {
        expect(client._getBridgeId('Arbitrum', true)).toBe(ACCESS_ID.LZ);
    });
});
