/**
 * BaseClient branches that need real ethers JsonRpcProvider (no ethers jest mock).
 */
jest.mock('axios');
import axios from 'axios';
import { BaseClient } from '../../src/core/base';
import { createConfig } from '../../src/core/config';
import * as ethers from 'ethers';
import { JsonRpcProvider } from 'ethers';

const mockedAxios = { request: jest.fn() };

describe('BaseClient RPC and environment branches (real ethers)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.PRIVATE_KEY;
        delete process.env.DEXALOT_RPC_432204;
        delete process.env.DEXALOT_RPC_ALOT;
        (axios.create as jest.Mock).mockReturnValue(mockedAxios);
    });

    it('_rejectInsecureRpcUrls throws when http:// and allowInsecureRpc false', () => {
        const client = new BaseClient(createConfig({ allowInsecureRpc: false }));
        expect(() => client._rejectInsecureRpcUrls(['http://rpc.local'])).toThrow('Insecure RPC');
    });

    it('_rejectInsecureRpcUrls allows http when allowInsecureRpc true', () => {
        const client = new BaseClient(createConfig({ allowInsecureRpc: true }));
        expect(client._rejectInsecureRpcUrls(['http://rpc.local'])).toEqual(['http://rpc.local']);
    });

    it('_getRpcUrls prefers DEXALOT_RPC_<chainId> env', () => {
        process.env.DEXALOT_RPC_99 = 'https://a,https://b';
        const client = new BaseClient(createConfig());
        expect(client._getRpcUrls(99, 'ETH', 'ignored')).toEqual(['https://a', 'https://b']);
        delete process.env.DEXALOT_RPC_99;
    });

    it('_getRpcUrls uses native symbol env when chain id unset', () => {
        process.env.DEXALOT_RPC_AVAX = 'https://avax-only';
        const client = new BaseClient(createConfig());
        expect(client._getRpcUrls(undefined, 'avax', undefined)).toEqual(['https://avax-only']);
        delete process.env.DEXALOT_RPC_AVAX;
    });

    it('_getRpcUrls splits apiRpc when no env override', () => {
        const client = new BaseClient(createConfig());
        expect(client._getRpcUrls(undefined, undefined, ' https://x , https://y ')).toEqual([
            'https://x',
            'https://y',
        ]);
    });

    it('_getRpcUrls returns empty array when nothing provided', () => {
        const client = new BaseClient(createConfig());
        expect(client._getRpcUrls(undefined, undefined, undefined)).toEqual([]);
    });

    it('_fetchEnvironments uses JsonRpcProvider when provider failover disabled (subnet)', async () => {
        const client = new BaseClient(
            createConfig({ parentEnv: 'fuji-multi', providerFailoverEnabled: false })
        );
        mockedAxios.request.mockResolvedValue({
            data: [
                {
                    chainid: 432204,
                    env_type: 'subnet',
                    env: 'prod-multi-subnet',
                    native_token_symbol: 'ALOT',
                    rpc: 'https://subnet.example/rpc',
                    network: 'Dexalot L1',
                },
            ],
        });
        await client._fetchEnvironments();
        expect(mockedAxios.request).toHaveBeenCalled();
        expect(client.subnetProvider).toBeInstanceOf(JsonRpcProvider);
    });

    it('_fetchEnvironments registers subnet with ProviderManager when failover enabled', async () => {
        const client = new BaseClient(
            createConfig({ parentEnv: 'fuji-multi', providerFailoverEnabled: true })
        );
        mockedAxios.request.mockResolvedValue({
            data: [
                {
                    chainid: 432204,
                    env_type: 'subnet',
                    env: 'prod-multi-subnet',
                    native_token_symbol: 'ALOT',
                    rpc: 'https://subnet.example/rpc',
                    network: 'Dexalot L1',
                },
                {
                    chainid: 43114,
                    env_type: 'mainnet',
                    env: 'prod-multi-avax',
                    network: 'Avalanche',
                    rpc: 'https://api.avax.network/ext/bc/C/rpc',
                    native_token_symbol: 'AVAX',
                },
            ],
        });
        await client._fetchEnvironments();
        expect(client._providerManager?.getProviderCount('DEXALOT_L1')).toBeGreaterThan(0);
        expect(client.connectedChainProviders['Avalanche']).toBeInstanceOf(JsonRpcProvider);
    });

    it('withRpcFailover throws when no provider registered', async () => {
        const client = new BaseClient(createConfig({ providerFailoverEnabled: true }));
        await expect(client.withRpcFailover('Unknown', async () => 1)).rejects.toThrow(
            'No RPC provider'
        );
    });

    it('withRpcFailover fails over to second RPC after first throws (maxFailures=1)', async () => {
        const client = new BaseClient(
            createConfig({
                parentEnv: 'fuji-multi',
                providerFailoverEnabled: true,
                providerFailoverMaxFailures: 1,
                retryEnabled: false,
            })
        );
        const pm = client._providerManager!;
        pm.addProviders('FailoverTest', ['http://127.0.0.1:65501', 'http://127.0.0.1:65502']);

        let n = 0;
        const out = await client.withRpcFailover('FailoverTest', async () => {
            n += 1;
            if (n === 1) throw new Error('first rpc down');
            return 99;
        });
        expect(out).toBe(99);
        expect(n).toBe(2);
    });

    it('withRpcFailover throws string lastError when all providers fail', async () => {
        const client = new BaseClient(
            createConfig({
                parentEnv: 'fuji-multi',
                providerFailoverEnabled: true,
                providerFailoverMaxFailures: 1,
                retryEnabled: false,
            })
        );
        client._providerManager!.addProviders('StrErr', ['http://127.0.0.1:65503']);
        await expect(
            client.withRpcFailover('StrErr', async () => {
                throw 'not an Error object';
            })
        ).rejects.toThrow(/All RPC providers failed/);
    });

    it('_contractForSigner throws without signer', () => {
        const client = new BaseClient(createConfig());
        const p = new JsonRpcProvider('http://127.0.0.1:65504');
        expect(() => (client as any)._contractForSigner(p, '0x' + '1'.repeat(40), [])).toThrow(
            'Signer required'
        );
    });

    it('_reconnectContractsForSigner fails without signer', () => {
        const client = new BaseClient(createConfig());
        const r = (client as any)._reconnectContractsForSigner();
        expect(r.success).toBe(false);
    });

    it('getProviderForChain falls back to subnetProvider for Dexalot L1', () => {
        const client = new BaseClient(createConfig({ providerFailoverEnabled: false }));
        const p = new JsonRpcProvider('http://127.0.0.1:65505');
        client.subnetProvider = p;
        expect(client.getProviderForChain('Dexalot L1')).toBe(p);
    });

    it('getAvailableChainNames includes chains from provider manager', () => {
        const client = new BaseClient(createConfig({ providerFailoverEnabled: true }));
        client.chainConfig['ZChain'] = { chain_id: 1 } as any;
        client._providerManager!.addProviders('ZChain', ['http://127.0.0.1:65506']);
        expect(client.getAvailableChainNames()).toContain('ZChain');
    });

    it('getProviderForChain returns provider from manager when healthy', () => {
        const client = new BaseClient(createConfig({ providerFailoverEnabled: true }));
        client._providerManager!.addProviders('Healthy', ['http://127.0.0.1:65511']);
        const p = client._providerManager!.getProvider('Healthy');
        expect(p).not.toBeNull();
        expect(client.getProviderForChain('Healthy')).toBe(p);
    });

    it('withRpcFailover breaks when getProvider returns null mid-loop', async () => {
        const client = new BaseClient(
            createConfig({
                parentEnv: 'fuji-multi',
                providerFailoverEnabled: true,
                providerFailoverMaxFailures: 1,
                retryEnabled: false,
            })
        );
        const pm = client._providerManager!;
        pm.addProviders('NullLoop', ['http://127.0.0.1:65512']);
        jest.spyOn(pm, 'getProviderCount').mockReturnValue(2);
        jest.spyOn(pm, 'getProvider').mockReturnValue(null);
        await expect(client.withRpcFailover('NullLoop', async () => 1)).rejects.toThrow(
            /All RPC providers failed/
        );
    });

    it('withRpcFailover rethrows last Error instance', async () => {
        const client = new BaseClient(
            createConfig({
                parentEnv: 'fuji-multi',
                providerFailoverEnabled: true,
                providerFailoverMaxFailures: 1,
                retryEnabled: false,
            })
        );
        const pm = client._providerManager!;
        pm.addProviders('ErrThrow', ['http://127.0.0.1:65513']);
        const err = new Error('persistent');
        await expect(
            client.withRpcFailover('ErrThrow', async () => {
                throw err;
            })
        ).rejects.toBe(err);
    });

    it('close clears ws manager and resets rate limiters', async () => {
        const client = new BaseClient(createConfig());
        const disconnect = jest.fn();
        (client as any)._wsManager = { disconnect };
        await client.close();
        expect(disconnect).toHaveBeenCalled();
        expect((client as any)._wsManager).toBeNull();
    });

    it('_fetchEnvironments catches JsonRpcProvider failure for subnet (no failover)', async () => {
        const RealJRP = ethers.JsonRpcProvider;
        const spy = jest.spyOn(ethers, 'JsonRpcProvider').mockImplementation(() => {
            throw new Error('subnet provider ctor');
        });
        const client = new BaseClient(
            createConfig({ parentEnv: 'fuji-multi', providerFailoverEnabled: false })
        );
        const warnSpy = jest.spyOn(client._logger, 'warn').mockImplementation(() => {});
        mockedAxios.request.mockResolvedValue({
            data: [
                {
                    chainid: 432204,
                    env_type: 'subnet',
                    env: 'prod-multi-subnet',
                    native_token_symbol: 'ALOT',
                    rpc: 'https://subnet.example/rpc',
                    network: 'Dexalot L1',
                },
            ],
        });
        await client._fetchEnvironments();
        expect(warnSpy).toHaveBeenCalledWith(
            'Failed to init subnet provider',
            expect.objectContaining({ error: expect.stringContaining('subnet provider ctor') })
        );
        spy.mockRestore();
        warnSpy.mockRestore();
    });

    it('_fetchEnvironments catches JsonRpcProvider failure for mainnet entry', async () => {
        const RealJRP = ethers.JsonRpcProvider;
        let n = 0;
        const spy = jest.spyOn(ethers, 'JsonRpcProvider').mockImplementation((url: string) => {
            n += 1;
            if (n === 1) return new RealJRP(url);
            throw new Error('mainnet provider ctor');
        });
        const client = new BaseClient(
            createConfig({ parentEnv: 'fuji-multi', providerFailoverEnabled: false })
        );
        const warnSpy = jest.spyOn(client._logger, 'warn').mockImplementation(() => {});
        mockedAxios.request.mockResolvedValue({
            data: [
                {
                    chainid: 432204,
                    env_type: 'subnet',
                    env: 'prod-multi-subnet',
                    native_token_symbol: 'ALOT',
                    rpc: 'https://subnet.example/rpc',
                    network: 'Dexalot L1',
                },
                {
                    chainid: 43114,
                    env_type: 'mainnet',
                    env: 'prod-multi-avax',
                    network: 'Avalanche',
                    rpc: 'https://api.avax.network/ext/bc/C/rpc',
                    native_token_symbol: 'AVAX',
                },
            ],
        });
        await client._fetchEnvironments();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to init provider for'),
            expect.objectContaining({ error: expect.stringContaining('mainnet provider ctor') })
        );
        spy.mockRestore();
        warnSpy.mockRestore();
    });
});
