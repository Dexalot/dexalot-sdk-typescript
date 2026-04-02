import { TransferClient } from '../../src/core/transfer';
import { Utils } from '../../src/utils';
import { Contract } from 'ethers';
import { DEFAULTS } from '../../src/constants';

jest.mock('ethers');
jest.mock('../../src/utils');

class TC extends TransferClient {}

describe('TransferClient extra branch coverage', () => {
    let client: TC;
    let mockSigner: { getAddress: jest.Mock; connect: jest.Mock; provider?: unknown };

    beforeEach(() => {
        jest.clearAllMocks();
        mockSigner = {
            getAddress: jest.fn().mockResolvedValue('0x' + 'a'.repeat(40)),
            connect: jest.fn().mockReturnThis(),
        };
        (Utils.unitConversion as jest.Mock).mockImplementation((v: unknown, _d: number, w?: boolean) =>
            w ? `${v}wei` : '1'
        );
        (Utils.toBytes32 as jest.Mock).mockReturnValue('0xbytes32');
        (Utils.fromBytes32 as jest.Mock).mockReturnValue('SYM');

        (Contract as unknown as jest.Mock).mockImplementation(() => ({
            getBalance: jest.fn().mockResolvedValue([1n, 1n, 1n]),
            balanceOf: jest.fn().mockResolvedValue(100n),
        }));

        client = new TC(mockSigner as any);
        client.portfolioSubContractView = {} as any;
        client.portfolioSubContract = { address: '0xsub', abi: [] } as any;
        client.chainConfig = {
            Avalanche: { chain_id: 43114, native_symbol: 'AVAX' } as any,
        };
        client.deployments = {
            PortfolioMain: { Avalanche: { address: '0xpm', abi: [] } },
            MainnetRFQ: { Avalanche: { address: '0xrfq', abi: [] } },
        };
        client.config.retryEnabled = false;
        (client as any).axios = { request: jest.fn() };
    });

    it('_resolveErc20TokenInfo returns null when token key missing', () => {
        expect((client as any)._resolveErc20TokenInfo('Avalanche', 1, 'MISSING')).toBeNull();
    });

    it('_resolveErc20TokenInfo resolves by chainId', () => {
        client.tokenData = {
            USDC: { e: { chainId: 43114, address: '0xusdc', decimals: 6, env: 'prod' } },
        };
        const r = (client as any)._resolveErc20TokenInfo('Avalanche', 43114, 'USDC');
        expect(r).toEqual({ address: '0xusdc', decimals: 6 });
    });

    it('_resolveErc20TokenInfo falls back to fuji env name', () => {
        client.tokenData = {
            T: { f: { chainId: 2, address: '0xf', decimals: 18, env: 'fuji-multi' } },
        };
        const r = (client as any)._resolveErc20TokenInfo('Fuji Testnet', 999, 'T');
        expect(r?.address).toBe('0xf');
    });

    it('_resolveErc20TokenInfo falls back to avalanche prod env', () => {
        client.tokenData = {
            T: { p: { chainId: 2, address: '0xp', decimals: 18, env: 'prod-multi' } },
        };
        const r = (client as any)._resolveErc20TokenInfo('Avalanche C-Chain', 999, 'T');
        expect(r?.address).toBe('0xp');
    });

    it('_resolveErc20TokenInfo returns null for zero address', () => {
        client.tokenData = {
            Z: { e: { chainId: 1, address: DEFAULTS.ZERO_ADDRESS, decimals: 18, env: 'e' } },
        };
        expect((client as any)._resolveErc20TokenInfo('Avalanche', 1, 'Z')).toBeNull();
    });

    it('_resolveQueryAddress validates explicit address', async () => {
        const r = await (client as any)._resolveQueryAddress('not-an-address');
        expect(r.success).toBe(false);
    });

    it('_resolveQueryAddress uses signer when param omitted', async () => {
        const r = await (client as any)._resolveQueryAddress();
        expect(r.success).toBe(true);
    });

    it('_resolveQueryAddress fails when signer getAddress throws', async () => {
        const c = new TC(mockSigner as any);
        (c as any).signer = { getAddress: jest.fn().mockRejectedValue(new Error('nope')) };
        const r = await (c as any)._resolveQueryAddress();
        expect(r.success).toBe(false);
    });

    it('getDepositBridgeFee requires signer', async () => {
        const c = new TC(null as any);
        const r = await c.getDepositBridgeFee('USDC', 1, 'Avalanche');
        expect(r.success).toBe(false);
        expect(r.error).toContain('Signer required');
    });

    it('getDepositBridgeFee fails token validation', async () => {
        const r = await client.getDepositBridgeFee('bad!', 1, 'Avalanche');
        expect(r.success).toBe(false);
    });

    it('getDepositBridgeFee fails amount validation', async () => {
        const r = await client.getDepositBridgeFee('USDC', -1, 'Avalanche');
        expect(r.success).toBe(false);
    });

    it('getDepositBridgeFee fails when chain not resolved', async () => {
        jest.spyOn(client, 'resolveChainReference').mockReturnValue({ success: false, error: 'bad' } as any);
        const r = await client.getDepositBridgeFee('USDC', 1, 'Nope');
        expect(r.success).toBe(false);
    });

    it('getDepositBridgeFee fails when chain not in chainConfig', async () => {
        jest.spyOn(client, 'resolveChainReference').mockReturnValue({
            success: true,
            data: { canonicalName: 'Ghost' },
        } as any);
        const r = await client.getDepositBridgeFee('USDC', 1, 'Ghost');
        expect(r.success).toBe(false);
    });

    it('getDepositBridgeFee fails when PortfolioMain missing', async () => {
        client.deployments = { PortfolioMain: {} };
        const r = await client.getDepositBridgeFee('USDC', 1, 'Avalanche');
        expect(r.success).toBe(false);
        expect(r.error).toContain('PortfolioMain');
    });

    it('getDepositBridgeFee fails when chain_id missing', async () => {
        client.chainConfig = { Avalanche: { native_symbol: 'AVAX' } as any };
        const r = await client.getDepositBridgeFee('USDC', 1, 'Avalanche');
        expect(r.success).toBe(false);
    });

    it('transferToken fails when transferPortfolio fails', async () => {
        jest.spyOn(client, 'transferPortfolio').mockResolvedValue({
            success: false,
            error: 'tp fail',
        } as any);
        const r = await client.transferToken('USDC', '0x' + 'b'.repeat(40), 1);
        expect(r.success).toBe(false);
    });

    it('transferToken uses default message when transferPortfolio fails without error', async () => {
        jest.spyOn(client, 'transferPortfolio').mockResolvedValue({
            success: false,
            data: null,
            error: '',
        } as any);
        const r = await client.transferToken('USDC', '0x' + 'b'.repeat(40), 1);
        expect(r.success).toBe(false);
        expect(r.error).toBe('Transfer failed');
    });

    it('getTokenDetails prefers evmDecimals when evmdecimals absent', async () => {
        (client as any).axios.request.mockResolvedValue({
            data: [
                {
                    symbol: 'TT',
                    env: 'prod-multi',
                    address: '0xt',
                    name: 'T',
                    evmDecimals: 9,
                    chainid: 1,
                },
            ],
        });
        const r = await client.getTokenDetails('TT');
        expect(r.success).toBe(true);
        expect((r.data as any)['prod-multi'].decimals).toBe(9);
    });

    it('_getL1NativeBalance uses withRpcFailover when PM available', async () => {
        client._providerManager!.addProviders('DEXALOT_L1', ['http://127.0.0.1:65520']);
        jest.spyOn(client, 'withRpcFailover').mockResolvedValue(5n as any);
        jest.spyOn(client, 'isChainRpcAvailable').mockReturnValue(true);
        const entry = await client._getL1NativeBalance('0xaddr');
        expect(entry.balance).toBeDefined();
    });

    it('_getL1NativeBalance catches withRpcFailover error', async () => {
        jest.spyOn(client, 'isChainRpcAvailable').mockReturnValue(true);
        jest.spyOn(client, 'withRpcFailover').mockRejectedValue(new Error('rpc down'));
        const entry = await client._getL1NativeBalance('0xaddr');
        expect(String(entry.balance)).toContain('Error');
    });

    it('_getL1NativeBalance uses subnetProvider fallback', async () => {
        jest.spyOn(client, 'isChainRpcAvailable').mockReturnValue(false);
        client.subnetProvider = { getBalance: jest.fn().mockResolvedValue(2n) } as any;
        const entry = await client._getL1NativeBalance('0xaddr');
        expect(entry.balance).toBe('1');
    });

    it('_getNativeBalance records RPC error message', async () => {
        const p = { getBalance: jest.fn().mockRejectedValue(new Error('bal err')) } as any;
        const e = await (client as any)._getNativeBalance('C', p, '0xx', 'ETH');
        expect(e.balance).toContain('bal err');
    });

    it('_getErc20Balance returns error when token missing in tokenData', async () => {
        const r = await (client as any)._getErc20Balance('C', 1, {} as any, '0xx', 'NONE');
        expect(r.error).toContain('not found');
    });

    it('_getErc20Balance catches balanceOf failure', async () => {
        client.tokenData = {
            X: { e: { chainId: 1, address: '0xtok', decimals: 18, env: 'e' } },
        };
        (Contract as unknown as jest.Mock).mockImplementationOnce(() => ({
            balanceOf: jest.fn().mockRejectedValue(new Error('ofail')),
        }));
        const r = await (client as any)._getErc20Balance('C', 1, {} as any, '0xx', 'X');
        expect(r.balance).toContain('ofail');
    });

    it('_fetchErc20Balances skips tokens without address on chain', async () => {
        client.tokenData = {
            A: { e: { chainId: 99, address: DEFAULTS.ZERO_ADDRESS, decimals: 18, env: 'e' } },
        };
        const info: any = { chain_balances: [] };
        await (client as any)._fetchErc20Balances(info, 99, 'Avalanche', {} as any, '0xx');
        expect(info.chain_balances.length).toBe(0);
    });

    it('getAllChainWalletBalances outer catch', async () => {
        jest.spyOn(client, '_resolveQueryAddress').mockResolvedValue({ success: true, data: '0xx' } as any);
        jest.spyOn(client, 'getAvailableChainNames').mockImplementation(() => {
            throw new Error('boom');
        });
        const r = await client.getAllChainWalletBalances();
        expect(r.success).toBe(false);
    });

    it('getAllPortfolioBalances catch returns sanitized error', async () => {
        client.portfolioSubContractView = null;
        const sub = { address: '0xv', abi: [] };
        client.portfolioSubContract = sub as any;
        jest.spyOn(client, 'withRpcFailover').mockRejectedValue(new Error('pfail'));
        const r = await client.getAllPortfolioBalances();
        expect(r.success).toBe(false);
    });

    it('_resolveQueryAddress returns explicit valid address unchanged', async () => {
        const addr = '0x' + 'a'.repeat(40);
        const r = await (client as any)._resolveQueryAddress(addr);
        expect(r.success).toBe(true);
        expect(r.data).toBe(addr);
    });

    it('getTokenDetails fails token symbol validation', async () => {
        const r = await client.getTokenDetails('bad_symbol!');
        expect(r.success).toBe(false);
    });

    it('getDepositBridgeFee catch when RPC layer throws', async () => {
        client.tokenData = {
            USDC: { e: { chainId: 43114, address: '0xusdc', decimals: 6, env: 'prod-multi' } },
        };
        jest.spyOn(client, 'withRpcFailover').mockRejectedValue(new Error('bridge rpc'));
        const r = await client.getDepositBridgeFee('USDC', 1, 'Avalanche');
        expect(r.success).toBe(false);
        expect(r.error).toContain('bridge');
    });

    it('getChainWalletBalances outer catch', async () => {
        client.chainConfig = { Avalanche: { chain_id: 43114, native_symbol: 'AVAX' } as any };
        jest.spyOn(client, 'isChainRpcAvailable').mockReturnValue(true);
        jest.spyOn(client, 'withRpcFailover').mockRejectedValue(new Error('chain bal'));
        const r = await client.getChainWalletBalances('Avalanche');
        expect(r.success).toBe(false);
    });

    it('_getNativeBalance records successful balance', async () => {
        const p = { getBalance: jest.fn().mockResolvedValue(42n) } as any;
        const e = await (client as any)._getNativeBalance('C', p, '0x' + 'b'.repeat(40), 'AVAX');
        expect(e.balance).toBe('1');
    });

    it('_getErc20Balance resolves token via fuji name fallback', async () => {
        client.tokenData = {
            T: { f: { chainId: 2, address: '0xtok', decimals: 6, env: 'fuji-multi' } },
        };
        (Contract as unknown as jest.Mock).mockImplementationOnce(() => ({
            balanceOf: jest.fn().mockResolvedValue(9n),
        }));
        const r = await (client as any)._getErc20Balance('Fuji Testnet', 999, {} as any, '0xx', 'T');
        expect(r.balance).toBe('1');
    });

    it('_getErc20Balance resolves token via avalanche prod name fallback', async () => {
        client.tokenData = {
            T: { p: { chainId: 2, address: '0xtok2', decimals: 8, env: 'prod-multi' } },
        };
        (Contract as unknown as jest.Mock).mockImplementationOnce(() => ({
            balanceOf: jest.fn().mockResolvedValue(3n),
        }));
        const r = await (client as any)._getErc20Balance('Avalanche C-Chain', 999, {} as any, '0xx', 'T');
        expect(r.balance).toBe('1');
    });

    it('_getErc20Balance returns error when token cannot be matched to chain', async () => {
        client.tokenData = {
            T: { e: { chainId: 2, address: '0xtok', decimals: 18, env: 'fuji-multi' } },
        };
        const r = await (client as any)._getErc20Balance('Ethereum', 1, {} as any, '0xx', 'T');
        expect(r.error).toContain('not available');
    });

    it('getAllPortfolioBalances catch when subnet view deployment exists', async () => {
        client.deployments = {
            ...client.deployments,
            PortfolioSub: { address: '0xpsub', abi: [] },
        };
        const spy = jest.spyOn(client, 'withRpcFailover').mockRejectedValue(new Error('portfolio list'));
        const r = await client.getAllPortfolioBalances();
        expect(r.success).toBe(false);
        expect(r.error).toContain('portfolio');
        spy.mockRestore();
    });
});
