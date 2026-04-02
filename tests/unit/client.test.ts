import { DexalotClient } from '../../src/core/client';
import { Utils } from '../../src/utils';
import { ethers } from 'ethers';

// Mock ethers
jest.mock('ethers');

describe('DexalotClient', () => {
    let client: DexalotClient;
    const mockDbPath = ':memory:';

    beforeEach(() => {
        // Reset mocks
        jest.clearAllMocks();
    });

    it('unitConversion static covers toBase true and false', () => {
        const spy = jest.spyOn(Utils, 'unitConversion').mockReturnValue('ok');
        expect(DexalotClient.unitConversion('1', 18, true)).toBe('ok');
        expect(DexalotClient.unitConversion('1', 18, false)).toBe('ok');
        expect(spy).toHaveBeenCalledWith('1', 18, true);
        expect(spy).toHaveBeenCalledWith('1', 18, false);
        spy.mockRestore();
    });

    it('should initialize correctly', () => {
        process.env.PRIVATE_KEY = '0x1000000000000000000000000000000000000000000000000000000000000000';
        client = new DexalotClient();
        expect(client).toBeInstanceOf(DexalotClient);
        delete process.env.PRIVATE_KEY;
    });

    it('login should trigger _getAuthHeaders if signer is present', async () => {
        const mockSigner = { getAddress: jest.fn() } as any;
        client = new DexalotClient(mockSigner);
        
        // Mock _getAuthHeaders which comes from CLOBMixin
        const spyAuth = jest.spyOn(client, '_getAuthHeaders').mockResolvedValue('headers' as any);

        await client.login();

        expect(spyAuth).toHaveBeenCalled();
    });

    it('login should do nothing if signer is missing', async () => {
        // Ensure no private key - forces no signer
        delete process.env.PRIVATE_KEY;
        
        client = new DexalotClient(); // No signer
        const spyAuth = jest.spyOn(client, '_getAuthHeaders');

        await client.login();

        expect(spyAuth).not.toHaveBeenCalled();
    });
});
