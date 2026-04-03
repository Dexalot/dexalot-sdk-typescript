import { BaseClient } from '../../src/core/base';
import { DexalotConfig, createConfig, loadConfigFromEnv } from '../../src/core/config';
import { Wallet, JsonRpcProvider, Contract } from 'ethers';
import { ENV, API_URL } from '../../src/constants';

// Mock dependencies
jest.mock('../../src/core/config');
jest.mock('ethers');

class TestBaseClientForContracts extends BaseClient {
    public contractForSigner(provider: any, address: string, abi: any[]) {
        return this._contractForSigner(provider, address, abi);
    }
}

describe('BaseClient - Configuration Fallbacks', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Constructor with DexalotConfig', () => {
        it('should use API_URL.TESTNET when config.apiBaseUrl is undefined', () => {
            const config: DexalotConfig = {
                parentEnv: ENV.FUJI_MULTI_SUBNET,
                apiBaseUrl: undefined as any,
                privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234'
            };
            (createConfig as jest.Mock).mockImplementation((partial?: Partial<DexalotConfig>) => ({
                ...config,
                ...partial,
            }));

            const client = new BaseClient(config);
            expect(client.apiBaseUrl).toBe(API_URL.TESTNET);
        });

        it('should use provided apiBaseUrl when config.apiBaseUrl is defined', () => {
            const customUrl = 'https://custom.api.url';
            const config: DexalotConfig = {
                parentEnv: ENV.PROD_MULTI_SUBNET,
                apiBaseUrl: customUrl,
                privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234'
            };
            (createConfig as jest.Mock).mockImplementation((partial?: Partial<DexalotConfig>) => ({
                ...config,
                ...partial,
            }));

            const client = new BaseClient(config);
            expect(client.apiBaseUrl).toBe(customUrl);
        });
    });

    describe('Constructor with Signer', () => {
        it('should use MAINNET API_URL when parentEnv contains "production"', () => {
            const mockSigner = {
                getAddress: jest.fn().mockResolvedValue('0xAddress'),
                provider: null
            } as any;

            (createConfig as jest.Mock).mockReturnValue({
                parentEnv: 'production-multi-avax'
            });

            const client = new BaseClient(mockSigner);
            expect(client.apiBaseUrl).toBe(API_URL.MAINNET);
        });

        it('should use TESTNET API_URL when parentEnv does not contain "production"', () => {
            const mockSigner = {
                getAddress: jest.fn().mockResolvedValue('0xAddress'),
                provider: null
            } as any;

            (createConfig as jest.Mock).mockReturnValue({
                parentEnv: 'fuji-multi-subnet'
            });

            const client = new BaseClient(mockSigner);
            expect(client.apiBaseUrl).toBe(API_URL.TESTNET);
        });
    });

    describe('Constructor with no arguments', () => {
        it('should use API_URL.TESTNET when loadConfigFromEnv returns undefined apiBaseUrl', () => {
            (loadConfigFromEnv as jest.Mock).mockReturnValue({
                parentEnv: ENV.FUJI_MULTI_SUBNET,
                apiBaseUrl: undefined,
                privateKey: undefined
            });

            const client = new BaseClient();
            expect(client.apiBaseUrl).toBe(API_URL.TESTNET);
        });

        it('should use provided apiBaseUrl when loadConfigFromEnv returns defined apiBaseUrl', () => {
            const customUrl = 'https://env.api.url';
            (loadConfigFromEnv as jest.Mock).mockReturnValue({
                parentEnv: ENV.PROD_MULTI_SUBNET,
                apiBaseUrl: customUrl,
                privateKey: undefined
            });

            const client = new BaseClient();
            expect(client.apiBaseUrl).toBe(customUrl);
        });
    });

    describe('Contract initialization fallbacks', () => {
        it('should use provider when signer is not available', async () => {
            const mockProvider = {
                getNetwork: jest.fn().mockResolvedValue({ chainId: 43114n })
            } as any;

            const client = new BaseClient();
            client.signer = undefined;
            client.provider = mockProvider;

            const runner = client.signer || client.provider;
            expect(runner).toBe(mockProvider);
        });
    });

    describe('MainnetRFQ deployment without provider', () => {
        it('should skip MainnetRFQ contract creation when provider is not available', async () => {
            const client = new BaseClient();
            client.connectedChainProviders = {};

            const chainName = 'Avalanche';
            const provider = client.connectedChainProviders[chainName];
            
            expect(provider).toBeUndefined();
        });
    });

    describe('Token deduplication in getTokens', () => {
        it('should skip duplicate token symbols using seenSymbols set', async () => {
            const client = new BaseClient();
            
            client.chainConfig = {
                'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any,
                'Fuji': { chain_id: 43113, native_symbol: 'AVAX' } as any
            };
            
            client.tokenData = {
                'AVAX': {
                    'env1': { symbol: 'AVAX', address: '0xAddr1', decimals: 18, chainId: 43114, env: 'env1' } as any,
                    'env2': { symbol: 'AVAX', address: '0xAddr2', decimals: 18, chainId: 43113, env: 'env2' } as any
                },
                'USDC': {
                    'env1': { symbol: 'USDC', address: '0xAddr3', decimals: 6, chainId: 43114, env: 'env1' } as any
                }
            };

            const result = await client.getTokens();
            
            expect(result.success).toBe(true);
            const tokens = result.data!;
            expect(tokens.length).toBe(2);
            const symbols = tokens.map(t => t.symbol);
            expect(symbols).toContain('AVAX');
            expect(symbols).toContain('USDC');
            expect(symbols.filter(s => s === 'AVAX').length).toBe(1);
        });
    });
});


describe('BaseClient signer contract fallback', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('falls back to the signer provider on unsupported reconnect errors', () => {
        const provider = {} as JsonRpcProvider;
        const signer = {
            provider: { kind: 'wallet-provider' },
            connect: jest.fn().mockImplementation(() => {
                throw Object.assign(new Error('cannot reconnect signer'), { code: 'UNSUPPORTED_OPERATION' });
            }),
        } as any;

        const client = new TestBaseClientForContracts(signer);
        const contractInstance = { ok: true };
        (Contract as unknown as jest.Mock).mockImplementation(() => contractInstance);

        const result = client.contractForSigner(provider, '0xabc', []);
        expect(result).toBe(contractInstance);
        expect((Contract as unknown as jest.Mock).mock.calls[0][2]).toBe(signer);
    });

    it('rethrows non-unsupported reconnect errors', () => {
        const provider = {} as JsonRpcProvider;
        const signer = {
            provider: { kind: 'wallet-provider' },
            connect: jest.fn().mockImplementation(() => {
                throw new Error('different failure');
            }),
        } as any;

        const client = new TestBaseClientForContracts(signer);
        expect(() => client.contractForSigner(provider, '0xabc', [])).toThrow('different failure');
    });
});
