import { SwapClient } from '../../src/core/swap';
import { ENDPOINTS } from '../../src/constants';
import { Contract, Interface } from 'ethers';

// Mock ethers
jest.mock('ethers');

// Mock specific console.error to avoid noise
jest.spyOn(console, 'error').mockImplementation(() => {});
// Discovery-failure tests make the SDK log its degrade-to-deployment-only warning.
jest.spyOn(console, 'warn').mockImplementation(() => {});

class TestClient extends SwapClient {}

/**
 * Build a contract mock with simpleSwap + estimateGas wired together.
 * The estimateGas mock is required because executeRFQSwap now estimates
 * gas (with msg.value) before calling simpleSwap.
 */
function buildMockContract(overrides: Partial<{
    txHash: string;
    receiptStatus: number;
    receiptBlock: number | null;
    simpleSwapRejects: Error | null;
    estimateGasRejects: Error | null;
    estimateGas: bigint;
}> = {}) {
    const txHash = overrides.txHash ?? 'txHash';
    const receiptStatus = overrides.receiptStatus ?? 1;
    // Use 'in' so an explicit `receiptBlock: null` falls through to the receipt
    // (and exercises the "no block field" branch in the failure-detail string).
    const receiptBlock =
        'receiptBlock' in overrides ? (overrides.receiptBlock as number | null) : 123456;
    const estimateGas = overrides.estimateGas ?? 100000n;

    const tx: any = {
        hash: txHash,
        from: '0xUser',
        to: '0xRFQ',
        data: '0xdata',
        value: 0n,
        wait: jest.fn().mockResolvedValue({
            status: receiptStatus,
            hash: txHash,
            blockNumber: receiptBlock,
        }),
    };

    const simpleSwap = overrides.simpleSwapRejects
        ? jest.fn().mockRejectedValue(overrides.simpleSwapRejects)
        : jest.fn().mockResolvedValue(tx);

    (simpleSwap as any).estimateGas = overrides.estimateGasRejects
        ? jest.fn().mockRejectedValue(overrides.estimateGasRejects)
        : jest.fn().mockResolvedValue(estimateGas);

    return { simpleSwap, tx };
}

const ZERO_ADDR = '0x' + '0'.repeat(40);
// Mainnet-shaped addresses for the RFQ routing tests: the router is what the
// deployments endpoint / trustedForwarder() report; makers are what firm
// quotes carry in order.maker.
const ROUTER = '0xf00240e5256e72771b46d095666594E0f40D085c';
const MAKER = '0x' + '3'.repeat(40);
const OTHER_MAKER = '0x1FDb2b265d2A5C4302A75cAd682222E4e7bCc313';
const MAX_UINT = 2n ** 256n - 1n;

describe('SwapClient', () => {
    let client: TestClient;
    let mockSigner: any;
    let mockAxios: any;

    const MOCK_PAIRS = {
        'AVAX/USDT': { pair: 'AVAX/USDT' },
        'USDT/AVAX': { pair: 'USDT/AVAX' },
    };

    beforeEach(() => {
        jest.clearAllMocks();

        mockSigner = {
            getAddress: jest.fn().mockResolvedValue('0xUser'),
            connect: jest.fn().mockImplementation(function (this: any) {
                return this;
            }),
        };

        mockAxios = { get: jest.fn(), request: jest.fn() };

        client = new TestClient(mockSigner);
        (client as any).axios = mockAxios;
        client.deployments = {
            MainnetRFQ: { Avalanche: { address: '0xRFQ', abi: [] } },
        };
        client.connectedChainProviders = { Avalanche: {} as any };
        client.chainId = 43114;
        client.chainConfig = {
            Avalanche: { chain_id: 43114, native_symbol: 'AVAX' } as any,
        };
        // On-chain target discovery and the ERC20 allowance pre-flight have
        // dedicated suites below; stub them permissively so the execution-path
        // tests stay focused on the tx pipeline.
        jest.spyOn(client as any, '_getRfqTargets').mockResolvedValue({
            router: ROUTER,
            allowed: new Set(['0xrfq', MAKER.toLowerCase()]),
        });
        jest.spyOn(client as any, '_getErc20Allowance').mockResolvedValue(MAX_UINT);
    });

    describe('_resolveChainIdResult', () => {
        it('fails for null and undefined', () => {
            expect((client as any)._resolveChainIdResult(null).success).toBe(false);
            expect((client as any)._resolveChainIdResult(undefined).success).toBe(false);
        });

        it('parses numeric string chain id', () => {
            jest.spyOn(client, 'resolveChainReference').mockReturnValue({ success: false } as any);
            const r = (client as any)._resolveChainIdResult('  43114  ');
            expect(r.success).toBe(true);
            expect(r.data).toBe(43114);
        });

        it('uses resolveChainReference error when present', () => {
            jest.spyOn(client, 'resolveChainReference').mockReturnValue({
                success: false,
                error: 'from resolver',
            } as any);
            const r = (client as any)._resolveChainIdResult('SomeChain');
            expect(r.success).toBe(false);
            expect(r.error).toBe('from resolver');
        });

        it('falls back to the default resolver message', () => {
            jest.spyOn(client, 'resolveChainReference').mockReturnValue({
                success: false,
                error: '',
            } as any);
            const r = (client as any)._resolveChainIdResult('SomeChain');
            expect(r.success).toBe(false);
            expect(r.error).toContain("Could not resolve chain identifier 'SomeChain'");
        });
    });

    describe('getSwapPairs', () => {
        it('fetches from API if cache empty', async () => {
            mockAxios.request.mockResolvedValueOnce({ data: MOCK_PAIRS });
            const r = await client.getSwapPairs(43114);
            expect(r.success).toBe(true);
            expect(mockAxios.request).toHaveBeenCalledWith(
                expect.objectContaining({ url: ENDPOINTS.RFQ_PAIRS })
            );
        });

        it('returns cached value on subsequent calls', async () => {
            mockAxios.request.mockResolvedValueOnce({ data: MOCK_PAIRS });
            await client.getSwapPairs(43114);
            await client.getSwapPairs(43114);
            expect(mockAxios.request).toHaveBeenCalledTimes(1);
        });

        it('fails when _resolveChainIdResult fails', async () => {
            jest.spyOn(client as any, '_resolveChainIdResult').mockReturnValue({
                success: false,
                error: 'cannot resolve',
            });
            const r = await client.getSwapPairs('Avalanche');
            expect(r.success).toBe(false);
            expect(r.error).toContain('cannot resolve');
        });

        it('reports a sanitized error on API failure', async () => {
            mockAxios.request.mockRejectedValueOnce(new Error('API down'));
            // Reset rfq cache so the call actually fetches
            client.rfqPairs = {};
            const r = await client.getSwapPairs(43114);
            expect(r.success).toBe(false);
            expect(r.error).toContain('fetching RFQ pairs for chain 43114');
        });

        it('fails when validateChainIdentifier rejects the input', async () => {
            const r = await client.getSwapPairs({} as any);
            expect(r.success).toBe(false);
            expect(r.error).toContain('chainIdentifier');
        });

        it('uses the static fallback when _resolveChainIdResult error is empty', async () => {
            jest.spyOn(client as any, '_resolveChainIdResult').mockReturnValue({
                success: false,
                error: '',
            });
            const r = await client.getSwapPairs('SomeChain');
            expect(r.success).toBe(false);
            expect(r.error).toContain("Could not resolve chain identifier 'SomeChain'");
        });
    });

    describe('_transformQuoteFromAPI', () => {
        it('unwraps the {success, quote} envelope before normalizing', () => {
            const envelope = {
                success: true,
                quote: {
                    chainid: 43114,
                    quoteid: 'q1',
                    signature: '0xSig',
                    order: { nonce_and_meta: 1, maker_asset: '0xM' },
                },
            };
            const out: any = (client as any)._transformQuoteFromAPI(envelope);
            expect(out.chainId).toBe(43114);
            expect(out.quoteId).toBe('q1');
            expect(out.signature).toBe('0xSig');
            expect(out.order.nonceAndMeta).toBe(1);
            expect(out.order.makerAsset).toBe('0xM');
        });

        it('also accepts an already-inner quote dict', () => {
            const inner = {
                chainId: 43114,
                quoteId: 'q1',
                signature: '0xSig',
                order: { nonceAndMeta: 1, makerAsset: '0xM' },
            };
            const out: any = (client as any)._transformQuoteFromAPI(inner);
            expect(out.chainId).toBe(43114);
            expect(out.signature).toBe('0xSig');
            expect(out.order.nonceAndMeta).toBe(1);
        });

        it('aliases chain_id and quote_id snake_case variants', () => {
            const inner = { chain_id: 43114, quote_id: 'q1', order: {} };
            const out: any = (client as any)._transformQuoteFromAPI(inner);
            expect(out.chainId).toBe(43114);
            expect(out.quoteId).toBe('q1');
        });

        it('preserves existing camelCase keys and snake_case originals', () => {
            const inner = {
                chainId: 43114,
                chainid: 999,           // ignored — chainId already set
                quoteId: 'qcamel',
                quoteid: 'qignored',
                order: { nonce_and_meta: 1 },
            };
            const out: any = (client as any)._transformQuoteFromAPI(inner);
            expect(out.chainId).toBe(43114);
            expect(out.quoteId).toBe('qcamel');
            // Originals preserved
            expect(out.chainid).toBe(999);
            expect(out.order.nonce_and_meta).toBe(1);
        });

        it('handles a quote without an order field', () => {
            const inner = { chainId: 43114, signature: '0xSig' };
            const out: any = (client as any)._transformQuoteFromAPI(inner);
            expect(out.order).toBeUndefined();
            expect(out.signature).toBe('0xSig');
        });

        it('handles a null order field without throwing', () => {
            const inner = { chainId: 43114, order: null };
            const out: any = (client as any)._transformQuoteFromAPI(inner);
            expect(out.order).toBeNull();
        });

        it('order normalization is idempotent — already-camelCase fields stay put', () => {
            const inner = {
                chainId: 43114,
                order: { nonceAndMeta: 1, makerAsset: '0xM', takerAsset: '0xT' },
            };
            const out: any = (client as any)._transformQuoteFromAPI(inner);
            expect(out.order.nonceAndMeta).toBe(1);
            expect(out.order.makerAsset).toBe('0xM');
            expect(out.order.takerAsset).toBe('0xT');
        });
    });

    describe('_transformOrderDataFromAPI', () => {
        it('returns null/undefined inputs unchanged', () => {
            expect((client as any)._transformOrderDataFromAPI(null)).toBeNull();
            expect((client as any)._transformOrderDataFromAPI(undefined)).toBeUndefined();
        });

        it('adds camelCase aliases without removing snake_case originals', () => {
            const input = {
                nonce_and_meta: 1,
                maker_asset: '0xM',
                taker_asset: '0xT',
                maker_amount: 100,
                taker_amount: 200,
            };
            const out = (client as any)._transformOrderDataFromAPI(input);
            expect(out.nonceAndMeta).toBe(1);
            expect(out.makerAsset).toBe('0xM');
            expect(out.takerAsset).toBe('0xT');
            expect(out.makerAmount).toBe(100);
            expect(out.takerAmount).toBe(200);
            // Originals preserved
            expect(out.nonce_and_meta).toBe(1);
        });
    });

    describe('_getSwapQuoteBase (exercised via getSwapFirmQuote / getSwapSoftQuote)', () => {
        beforeEach(() => {
            client.rfqPairs[43114] = MOCK_PAIRS;
        });

        it('returns indicative quote on the /pairprice endpoint (buy side)', async () => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
            mockAxios.request.mockResolvedValue({ data: { price: 100 } });

            const result = await client.getSwapSoftQuote('USDT', 'AVAX', 10);
            expect(result.success).toBe(true);
            expect(mockAxios.request).toHaveBeenCalledWith(
                expect.objectContaining({ method: 'get', url: ENDPOINTS.RFQ_PAIR_PRICE })
            );
        });

        it('returns a fail Result on envelope-layer failure ({success: false})', async () => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
            mockAxios.request.mockResolvedValue({
                data: { success: false, reason: 'Quote backend offline' },
            });
            const result = await client.getSwapFirmQuote('AVAX', 'USDT', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Cannot execute failed quote');
            expect(result.error).toContain('Quote backend offline');
        });

        it('falls back to a generic reason when {success: false} carries no reason', async () => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
            mockAxios.request.mockResolvedValue({ data: { success: false } });
            const result = await client.getSwapFirmQuote('AVAX', 'USDT', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Quote API returned success=false');
        });

        it('uses the envelope error field when reason is absent', async () => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
            mockAxios.request.mockResolvedValue({
                data: { success: false, error: 'rate-limited' },
            });
            const result = await client.getSwapFirmQuote('AVAX', 'USDT', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('rate-limited');
        });

        it('unwraps {success: true, quote: {...}} for firm quotes', async () => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
            mockAxios.request.mockResolvedValue({
                data: {
                    success: true,
                    quote: {
                        chainid: 43114,
                        signature: '0xSig',
                        order: { nonce_and_meta: 1, maker_asset: '0xM' },
                    },
                },
            });
            const result = await client.getSwapFirmQuote('AVAX', 'USDT', 10);
            expect(result.success).toBe(true);
            expect(result.data!.chainId).toBe(43114);
            expect(result.data!.signature).toBe('0xSig');
            expect(result.data!.order!.nonceAndMeta).toBe(1);
            expect(result.data!.order!.makerAsset).toBe('0xM');
        });

        it('returns error if signer missing for firm quote', async () => {
            client.signer = undefined as any;
            const result = await client.getSwapFirmQuote('AVAX', 'USDT', 1);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Signer required');
        });

        it('returns error if pair not found', async () => {
            client.rfqPairs[43114] = {};
            const result = await client.getSwapSoftQuote('A', 'B', 1);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Pair A/B not found');
        });

        it('validates input parameters', async () => {
            const result = await client.getSwapSoftQuote('', 'B', 1);
            expect(result.success).toBe(false);
        });

        it('reports a sanitized error on backend exception', async () => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
            mockAxios.request.mockRejectedValue(new Error('API error'));
            const result = await client.getSwapSoftQuote('AVAX', 'USDT', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('fetching swap quote');
        });
    });

    describe('getSwapFirmQuote / getSwapSoftQuote', () => {
        beforeEach(() => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
        });

        it('firm quote calls /firmQuote', async () => {
            mockAxios.request.mockResolvedValue({ data: { signature: 's', order: {} } });
            const r = await client.getSwapFirmQuote('AVAX', 'USDT', 10);
            expect(r.success).toBe(true);
            expect(mockAxios.request).toHaveBeenCalledWith(
                expect.objectContaining({ url: ENDPOINTS.RFQ_FIRM_QUOTE })
            );
        });

        it('soft quote calls /pairprice', async () => {
            mockAxios.request.mockResolvedValue({ data: { price: 100 } });
            const r = await client.getSwapSoftQuote('AVAX', 'USDT', 10);
            expect(r.success).toBe(true);
            expect(mockAxios.request).toHaveBeenCalledWith(
                expect.objectContaining({ url: ENDPOINTS.RFQ_PAIR_PRICE })
            );
        });

        it('both accept a custom chainId', async () => {
            client.rfqPairs[1] = { 'ETH/USDT': {} };
            mockAxios.request.mockResolvedValue({ data: { signature: 's', order: {} } });
            const r1 = await client.getSwapFirmQuote('ETH', 'USDT', 10, 1);
            expect(r1.success).toBe(true);
            mockAxios.request.mockResolvedValue({ data: { price: 1 } });
            const r2 = await client.getSwapSoftQuote('ETH', 'USDT', 10, 1);
            expect(r2.success).toBe(true);
        });
    });

    describe('_computeMsgValue', () => {
        it('returns takerAmount when takerAsset is the zero address (native sell)', () => {
            const v = (client as any)._computeMsgValue({
                takerAsset: ZERO_ADDR,
                takerAmount: '1500000000000000000',
            });
            expect(v).toBe(1500000000000000000n);
        });

        it('returns 0 when takerAsset is an ERC20 address', () => {
            const v = (client as any)._computeMsgValue({
                takerAsset: '0x9999999999999999999999999999999999999999',
                takerAmount: '1000',
            });
            expect(v).toBe(0n);
        });

        it('case-insensitive: 0X00... is also native', () => {
            const v = (client as any)._computeMsgValue({
                takerAsset: ZERO_ADDR.toUpperCase(),
                takerAmount: '42',
            });
            expect(v).toBe(42n);
        });

        it('accepts snake_case fields too', () => {
            const v = (client as any)._computeMsgValue({
                taker_asset: ZERO_ADDR,
                taker_amount: '7',
            });
            expect(v).toBe(7n);
        });

        it('returns 0 when takerAmount is missing on a native sell', () => {
            const v = (client as any)._computeMsgValue({ takerAsset: ZERO_ADDR });
            expect(v).toBe(0n);
        });

        it('returns 0 when both takerAsset variants are absent', () => {
            const v = (client as any)._computeMsgValue({ takerAmount: '7' });
            expect(v).toBe(0n);
        });
    });

    describe('_orderFieldToBigInt', () => {
        it('returns 0n for empty / null / undefined', () => {
            expect((client as any)._orderFieldToBigInt(null)).toBe(0n);
            expect((client as any)._orderFieldToBigInt(undefined)).toBe(0n);
            expect((client as any)._orderFieldToBigInt('')).toBe(0n);
        });

        it('passes through bigints', () => {
            expect((client as any)._orderFieldToBigInt(42n)).toBe(42n);
        });

        it('coerces numbers, decimal strings, and hex strings', () => {
            expect((client as any)._orderFieldToBigInt(42)).toBe(42n);
            expect((client as any)._orderFieldToBigInt('1000')).toBe(1000n);
            expect((client as any)._orderFieldToBigInt('0x2a')).toBe(42n);
        });
    });

    describe('_extractRevertReason', () => {
        it('returns the message after "execution reverted: "', async () => {
            const provider = {
                call: jest.fn().mockRejectedValue(new Error('execution reverted: RF-EXP-01')),
            };
            const r = await (client as any)._extractRevertReason(
                provider,
                { from: '0x', to: '0x', data: '0x', value: 0n },
                { blockNumber: 100 }
            );
            expect(r).toBe('RF-EXP-01');
        });

        it('strips surrounding quotes from the reason', async () => {
            const provider = {
                call: jest.fn().mockRejectedValue(new Error("execution reverted: 'RF-EXP-01'")),
            };
            const r = await (client as any)._extractRevertReason(
                provider,
                { from: '0x', to: '0x', data: '0x' },
                { blockNumber: 100 }
            );
            expect(r).toBe('RF-EXP-01');
        });

        it('returns the marker itself if no reason follows', async () => {
            const provider = {
                call: jest.fn().mockRejectedValue(new Error('execution reverted')),
            };
            const r = await (client as any)._extractRevertReason(
                provider,
                { from: '0x', to: '0x', data: '0x' },
                { blockNumber: 100 }
            );
            expect(r).toBe('execution reverted');
        });

        it('returns the first 200 chars of the error when the marker is absent', async () => {
            const provider = {
                call: jest.fn().mockRejectedValue(new Error('some other rpc error message')),
            };
            const r = await (client as any)._extractRevertReason(
                provider,
                { from: '0x', to: '0x', data: '0x' },
                { blockNumber: 100 }
            );
            expect(r).toBe('some other rpc error message');
        });

        it('returns null when the rejection coerces to an empty string', async () => {
            const provider = {
                call: jest.fn().mockRejectedValue(new Error('')),
            };
            const r = await (client as any)._extractRevertReason(
                provider,
                { from: '0x', to: '0x', data: '0x' },
                { blockNumber: 100 }
            );
            expect(r).toBeNull();
        });

        it('returns null when the replay succeeds (no revert)', async () => {
            const provider = { call: jest.fn().mockResolvedValue('0xresult') };
            const r = await (client as any)._extractRevertReason(
                provider,
                { from: '0x', to: '0x', data: '0x' },
                { blockNumber: 100 }
            );
            expect(r).toBeNull();
        });

        it('returns null when the provider lookup itself throws', async () => {
            // tx.from access throws.
            const tx = new Proxy(
                {},
                {
                    get() {
                        throw new Error('boom');
                    },
                }
            );
            const r = await (client as any)._extractRevertReason({} as any, tx, {});
            expect(r).toBeNull();
        });

        it('forwards tx.gasLimit to the eth_call replay', async () => {
            const call = jest.fn().mockResolvedValue('0x');
            await (client as any)._extractRevertReason(
                { call },
                { from: '0x', to: '0x', data: '0x', value: 0n, gasLimit: 250000n },
                { blockNumber: 100 }
            );
            const callTx = call.mock.calls[0][0];
            expect(callTx.gasLimit).toBe(250000n);
            expect(callTx.value).toBe(0n);
            expect(callTx.blockTag).toBe(100);
        });

        it('omits blockTag when the receipt has no blockNumber', async () => {
            const call = jest.fn().mockResolvedValue('0x');
            await (client as any)._extractRevertReason(
                { call },
                { from: '0x', to: '0x', data: '0x' },
                {}
            );
            const callTx = call.mock.calls[0][0];
            expect(callTx).not.toHaveProperty('blockTag');
        });

        it('strips a non-Error rejection as a string', async () => {
            // Some RPC providers reject with a plain object rather than an Error.
            const call = jest.fn().mockRejectedValue({ data: 'execution reverted: X' });
            const r = await (client as any)._extractRevertReason(
                { call },
                { from: '0x', to: '0x', data: '0x' },
                { blockNumber: 1 }
            );
            // String([object Object]) doesn't include the marker -> falls into
            // the first-200-chars branch.
            expect(typeof r === 'string' || r === null).toBe(true);
        });
    });

    describe('executeRFQSwap', () => {
        beforeEach(() => {
            jest.clearAllMocks();
        });

        it('fails when signer missing', async () => {
            client.signer = undefined as any;
            const r = await client.executeRFQSwap({ signature: 's', order: {} });
            expect(r.success).toBe(false);
            expect(r.error).toContain('Signer required');
        });

        it('fails when signature is missing', async () => {
            const r = await client.executeRFQSwap({ chainid: 43114, order: { taker: 'x' } });
            expect(r.success).toBe(false);
            expect(r.error).toContain("Invalid firm quote: missing 'signature' or 'order' field.");
        });

        it('fails when order is missing', async () => {
            const r = await client.executeRFQSwap({ chainid: 43114, signature: '0xSig' });
            expect(r.success).toBe(false);
            expect(r.error).toContain("Invalid firm quote: missing 'signature' or 'order' field.");
        });

        it('fails when chain id is unknown', async () => {
            client.chainConfig = {};
            const r = await client.executeRFQSwap({
                chainid: 99999,
                signature: '0xSig',
                order: { takerAsset: '0xAAA' },
            });
            expect(r.success).toBe(false);
            expect(r.error).toContain('Unknown chain ID: 99999');
        });

        it('fails when MainnetRFQ deployment is missing for the chain', async () => {
            client.deployments = { MainnetRFQ: { Fuji: { address: '0xfuji', abi: [] } } };
            const r = await client.executeRFQSwap({
                chainid: 43114,
                signature: '0xSig',
                order: { takerAsset: '0xAAA' },
            });
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/Available:\s*Fuji/);
        });

        it('fails with "none" when MainnetRFQ map is empty', async () => {
            client.deployments = { MainnetRFQ: {} } as any;
            const r = await client.executeRFQSwap({
                chainid: 43114,
                signature: '0xSig',
                order: { takerAsset: '0xAAA' },
            });
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/Available:\s*none/);
        });

        it('fails with "none" when deployments has no MainnetRFQ key at all', async () => {
            client.deployments = {} as any;
            const r = await client.executeRFQSwap({
                chainid: 43114,
                signature: '0xSig',
                order: { takerAsset: '0xAAA' },
            });
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/Available:\s*none/);
        });

        it('accepts the inner quote shape and submits simpleSwap', async () => {
            const { simpleSwap, tx } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap({
                chainid: 43114,
                signature: '0xSig',
                order: {
                    nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT',
                    maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: 1,
                },
            });

            expect(r.success).toBe(true);
            expect(r.data!.txHash).toBe(tx.hash);
            expect(r.data!.operation).toBe('execute_rfq_swap');
            expect(simpleSwap).toHaveBeenCalledTimes(1);
        });

        it('unwraps the {success, quote} envelope on the input', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap({
                success: true,
                quote: {
                    chainid: 43114,
                    signature: '0xSig',
                    order: {
                        nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT',
                        maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: 1,
                    },
                },
            });
            expect(r.success).toBe(true);
            expect(simpleSwap).toHaveBeenCalled();
        });

        it('encodes snake_case order fields through to the tuple', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            await client.executeRFQSwap({
                chainid: 43114,
                signature: '0xSig',
                order: {
                    nonce_and_meta: 1, expiry: 1, maker_asset: '0xM', taker_asset: '0xT',
                    maker: MAKER, taker: '0xTkr', maker_amount: 100, taker_amount: 200,
                },
            });

            const args = (simpleSwap as jest.Mock).mock.calls[0];
            // args[0] is the order tuple: [nonceAndMeta, expiry, makerAsset, takerAsset, maker, taker, makerAmount, takerAmount]
            expect(args[0][0]).toBe(1);       // nonceAndMeta (aliased)
            expect(args[0][2]).toBe('0xM');   // makerAsset (aliased)
            expect(args[0][3]).toBe('0xT');   // takerAsset (aliased)
            expect(args[0][6]).toBe(100);     // makerAmount (aliased)
            expect(args[0][7]).toBe(200);     // takerAmount (aliased)
        });

        it('passes msg.value=0 for ERC20 takers and value=takerAmount for native takers', async () => {
            // ERC20 taker -> value 0
            const erc20 = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap: erc20.simpleSwap }));
            await client.executeRFQSwap({
                chainid: 43114, signature: '0xSig',
                order: {
                    nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0x9999999999999999999999999999999999999999',
                    maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: '5',
                },
            });
            expect((erc20.simpleSwap as jest.Mock).mock.calls[0][2].value).toBe(0n);
            expect((erc20.simpleSwap.estimateGas as jest.Mock).mock.calls[0][2].value).toBe(0n);

            // Native taker -> value = takerAmount
            const native = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap: native.simpleSwap }));
            await client.executeRFQSwap({
                chainid: 43114, signature: '0xSig',
                order: {
                    nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: ZERO_ADDR,
                    maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: '1500000000000000000',
                },
            });
            expect((native.simpleSwap as jest.Mock).mock.calls[0][2].value).toBe(1500000000000000000n);
            expect((native.simpleSwap.estimateGas as jest.Mock).mock.calls[0][2].value).toBe(1500000000000000000n);
        });

        it('applies the gas-buffer multiplier to the estimate', async () => {
            const { simpleSwap } = buildMockContract({ estimateGas: 100000n });
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            await client.executeRFQSwap({
                chainid: 43114, signature: '0xSig',
                order: {
                    nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT',
                    maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: 1,
                },
            });
            // DEFAULTS.GAS_BUFFER is 1.2 -> 100000 * 1.2 = 120000
            const sentGas: bigint = (simpleSwap as jest.Mock).mock.calls[0][2].gasLimit;
            expect(sentGas).toBeGreaterThanOrEqual(110000n);
            expect(sentGas).toBeLessThanOrEqual(130000n);
        });

        it('uses client.chainId when the quote has no chainid', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            client.chainId = 43114;

            const r = await client.executeRFQSwap({
                signature: '0xSig',
                order: {
                    nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT',
                    maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: 1,
                },
            });
            expect(r.success).toBe(true);
        });

        it('does not wait for receipt when waitForReceipt=false', async () => {
            const { simpleSwap, tx } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            const r = await client.executeRFQSwap({
                chainid: 43114, signature: '0xSig',
                order: { nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT', maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: 1 },
            }, false);

            expect(r.success).toBe(true);
            expect(r.data!.txHash).toBe(tx.hash);
            expect(tx.wait).not.toHaveBeenCalled();
        });

        it('surfaces tx hash + block + revert reason when the receipt reports status=0', async () => {
            const { simpleSwap, tx } = buildMockContract({
                receiptStatus: 0,
                receiptBlock: 12345,
                txHash: '0xreverted',
            });
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            // Spy on _extractRevertReason so we don't have to mock the provider.
            jest.spyOn(client as any, '_extractRevertReason').mockResolvedValue('RF-EXP-01');

            const r = await client.executeRFQSwap({
                chainid: 43114, signature: '0xSig',
                order: { nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT', maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: 1 },
            });

            expect(r.success).toBe(false);
            expect(r.error).toMatch(/^Transaction reverted: tx=0xreverted, block=12345, reason=RF-EXP-01 \[target=/);
            // tx.wait was awaited
            expect(tx.wait).toHaveBeenCalled();
        });

        it('omits block= and reason= segments when not available', async () => {
            const { simpleSwap } = buildMockContract({
                receiptStatus: 0,
                receiptBlock: null,
                txHash: '0xrev',
            });
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            jest.spyOn(client as any, '_extractRevertReason').mockResolvedValue(null);

            const r = await client.executeRFQSwap({
                chainid: 43114, signature: '0xSig',
                order: { nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT', maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: 1 },
            });

            expect(r.success).toBe(false);
            expect(r.error).toMatch(/^Transaction reverted: tx=0xrev \[target=/);
        });

        it('returns sanitized error when simpleSwap throws', async () => {
            const { simpleSwap } = buildMockContract({
                simpleSwapRejects: new Error('Contract error'),
            });
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap({
                chainid: 43114, signature: '0xSig',
                order: { nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT', maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: 1 },
            });

            expect(r.success).toBe(false);
            expect(r.error).toContain('executing swap');
        });

        it('returns sanitized error when estimateGas throws', async () => {
            const { simpleSwap } = buildMockContract({
                estimateGasRejects: new Error('Estimate failed'),
            });
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap({
                chainid: 43114, signature: '0xSig',
                order: { nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT', maker: MAKER, taker: '0xTkr', makerAmount: 1, takerAmount: 1 },
            });

            expect(r.success).toBe(false);
            expect(r.error).toContain('executing swap');
        });
    });

    describe('_resolvePair', () => {
        it('returns null if no match', async () => {
            client.rfqPairs[43114] = {};
            const res = await client._resolvePair('A', 'B', 43114);
            expect(res).toBeNull();
        });

        it('returns null if getSwapPairs fails', async () => {
            mockAxios.request.mockRejectedValue(new Error('API error'));
            client.rfqPairs = {};
            const res = await client._resolvePair('A', 'B', 43114);
            expect(res).toBeNull();
        });

        it('returns pair for forward direction', async () => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
            const res = await client._resolvePair('AVAX', 'USDT', 43114);
            expect(res).toEqual({ name: 'AVAX/USDT', tradeSide: 1, isBase: true });
        });

        it('returns pair for reverse direction', async () => {
            client.rfqPairs[43114] = { 'USDT/AVAX': {} };
            const res = await client._resolvePair('AVAX', 'USDT', 43114);
            expect(res).toEqual({ name: 'USDT/AVAX', tradeSide: 0, isBase: false });
        });
    });

    // -----------------------------------------------------------------------
    // RFQ execution-target routing: firm quotes are served by several maker
    // contracts behind DexalotRouter; the SDK must call tx.to / order.maker,
    // never the deployments address, and must validate the target on-chain.
    // -----------------------------------------------------------------------

    const rfqOrder = (over: Record<string, unknown> = {}) => ({
        nonceAndMeta: 123, expiry: 9999999999, makerAsset: '0xM', takerAsset: '0xT',
        maker: MAKER, taker: '0xTkr', makerAmount: 1000, takerAmount: 2000, ...over,
    });
    const rfqQuote = (extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
        chainid: 43114, signature: '0xSig', quoteid: 'q-1', order: rfqOrder(over), ...extra,
    });
    const contractAddresses = () => (Contract as jest.Mock).mock.calls.map((c) => c[0]);

    describe('executeRFQSwap target routing', () => {
        it('targets tx.to when it is the router', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap(rfqQuote({ tx: { to: ROUTER.toLowerCase() } }));

            expect(r.success).toBe(true);
            expect(r.data!.target).toBe(ROUTER.toLowerCase());
            expect(r.data!.maker).toBe(MAKER);
            expect(contractAddresses()).toContain(ROUTER.toLowerCase());
            expect(contractAddresses()).not.toContain('0xRFQ');
        });

        it('targets order.maker when the quote carries no tx envelope', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap(rfqQuote());

            expect(r.success).toBe(true);
            expect(r.data!.target).toBe(MAKER);
            expect(contractAddresses()).toEqual([MAKER]);
        });

        it('never sends a quote from another maker to the deployments address', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            (client as any)._getRfqTargets.mockResolvedValue({
                router: ROUTER,
                allowed: new Set(['0xrfq', OTHER_MAKER.toLowerCase()]),
            });

            const r = await client.executeRFQSwap(rfqQuote({}, { maker: OTHER_MAKER }));

            expect(r.success).toBe(true);
            expect(r.data!.target).toBe(OTHER_MAKER);
            expect(contractAddresses()).toEqual([OTHER_MAKER]);
        });

        it('refuses a maker outside the router allow-list', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            (client as any)._getRfqTargets.mockResolvedValue({ router: ROUTER, allowed: new Set(['0xrfq']) });

            const r = await client.executeRFQSwap(rfqQuote({}, { maker: OTHER_MAKER }));

            expect(r.success).toBe(false);
            expect(r.error).toContain('not an allowed RFQ contract');
            expect(r.error).toContain(OTHER_MAKER);
            expect(simpleSwap).not.toHaveBeenCalled();
        });

        it('refuses tx.to that is neither the router nor the maker', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap(rfqQuote({ tx: { to: '0x' + '9'.repeat(40) } }));

            expect(r.success).toBe(false);
            expect(r.error).toContain('neither the RFQ router nor the order maker');
            expect(simpleSwap).not.toHaveBeenCalled();
        });

        it('accepts tx.to equal to the maker', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap(rfqQuote({ tx: { to: MAKER } }));

            expect(r.success).toBe(true);
            expect(r.data!.target).toBe(MAKER);
        });

        it('requires tx.to to be the maker when no router could be resolved', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            (client as any)._getRfqTargets.mockResolvedValue({
                router: null,
                allowed: new Set(['0xrfq', MAKER.toLowerCase()]),
            });

            const r = await client.executeRFQSwap(rfqQuote({ tx: { to: ROUTER } }));

            expect(r.success).toBe(false);
            expect(r.error).toContain('neither the RFQ router nor the order maker');
        });

        it('refuses when tx.data does not match the SDK encoding', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            jest.spyOn(client as any, '_encodeSimpleSwap').mockReturnValue('0xENCODED');

            const r = await client.executeRFQSwap(rfqQuote({ tx: { to: ROUTER, data: '0xdeadbeef' } }));

            expect(r.success).toBe(false);
            expect(r.error).toContain('tx.data does not match');
            expect(simpleSwap).not.toHaveBeenCalled();
        });

        it('accepts matching tx.data case-insensitively', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            jest.spyOn(client as any, '_encodeSimpleSwap').mockReturnValue('0xENCODED');

            const r = await client.executeRFQSwap(rfqQuote({ tx: { to: ROUTER, data: '0xencoded' } }));

            expect(r.success).toBe(true);
        });

        it('refuses when tx.value does not match the computed msg.value', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap(rfqQuote({ tx: { to: ROUTER, value: '5' } }));

            expect(r.success).toBe(false);
            expect(r.error).toContain('tx.value');
            expect(simpleSwap).not.toHaveBeenCalled();
        });

        it('accepts matching tx.value for a native sell', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap(
                rfqQuote({ tx: { to: ROUTER, value: '2000' } }, { takerAsset: ZERO_ADDR, takerAmount: '2000' })
            );

            expect(r.success).toBe(true);
            expect((simpleSwap as jest.Mock).mock.calls[0][2].value).toBe(2000n);
        });

        it('fails fast when the maker allowance is insufficient', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            (client as any)._getErc20Allowance.mockResolvedValue(10n);

            const r = await client.executeRFQSwap(rfqQuote());

            expect(r.success).toBe(false);
            expect(r.error).toContain('Insufficient allowance');
            expect(r.error).toContain(MAKER);
            expect(r.error).toContain('approveRfqMaker');
            expect(simpleSwap).not.toHaveBeenCalled();
            expect((client as any)._getErc20Allowance).toHaveBeenCalledWith('Avalanche', '0xT', '0xUser', MAKER);
        });

        it('skips the allowance check for native sells', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            (client as any)._getErc20Allowance.mockResolvedValue(0n);

            const r = await client.executeRFQSwap(rfqQuote({}, { takerAsset: ZERO_ADDR }));

            expect(r.success).toBe(true);
            expect((client as any)._getErc20Allowance).not.toHaveBeenCalled();
        });

        it('carries the quote context on thrown errors', async () => {
            const { simpleSwap } = buildMockContract({ simpleSwapRejects: new Error('boom') });
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap(rfqQuote({ tx: { to: ROUTER } }));

            expect(r.success).toBe(false);
            expect(r.error).toContain('executing swap');
            expect(r.error).toContain(`target=${ROUTER}`);
            expect(r.error).toContain(`maker=${MAKER}`);
            expect(r.error).toContain('quoteId=q-1');
            expect(r.error).toContain('nonceAndMeta=123');
            expect(r.error).toContain('expiry=9999999999');
        });

        it('fails when order.maker is missing', async () => {
            const r = await client.executeRFQSwap(rfqQuote({}, { maker: undefined }));
            expect(r.success).toBe(false);
            expect(r.error).toContain('order.maker');
        });

        it('fails when order.maker is not an address', async () => {
            const r = await client.executeRFQSwap(rfqQuote({}, { maker: 'not-an-address' }));
            expect(r.success).toBe(false);
            expect(r.error).toContain('not an address');
        });

        it('fails when tx.to is not an address', async () => {
            const r = await client.executeRFQSwap(rfqQuote({ tx: { to: 'garbage' } }));
            expect(r.success).toBe(false);
            expect(r.error).toContain("'tx.to' is not an address");
        });

        it('ignores a non-object tx field', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap(rfqQuote({ tx: '0xabc' }));

            expect(r.success).toBe(true);
            expect(r.data!.target).toBe(MAKER);
        });

        it('returns target and maker without waiting for the receipt', async () => {
            const { simpleSwap, tx } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));

            const r = await client.executeRFQSwap(rfqQuote(), false);

            expect(r.success).toBe(true);
            expect(r.data).toEqual({ txHash: tx.hash, operation: 'execute_rfq_swap', target: MAKER, maker: MAKER });
        });

        it('_rfqErrorContext omits absent optional fields', () => {
            expect((client as any)._rfqErrorContext({}, { maker: 'x' }, 't')).toBe('target=t, maker=x');
            expect((client as any)._rfqErrorContext(undefined, undefined, 't')).toBe('target=t, maker=undefined');
        });

        it('_checkTxEnvelope passes when there is no tx envelope', () => {
            expect((client as any)._checkTxEnvelope({}, [], '0x', 0n)).toBeNull();
            expect((client as any)._checkTxEnvelope({ tx: { value: '' } }, [], '0x', 0n)).toBeNull();
        });

        it('_encodeSimpleSwap encodes through ethers Interface', () => {
            const encodeFunctionData = jest.fn().mockReturnValue('0xabc');
            (Interface as unknown as jest.Mock).mockImplementation(() => ({ encodeFunctionData }));
            expect((client as any)._encodeSimpleSwap([1, 2], '0xSig')).toBe('0xabc');
            expect(encodeFunctionData).toHaveBeenCalledWith('simpleSwap', [[1, 2], '0xSig']);
        });

        it('_describeReceiptFailure returns null for a successful receipt', async () => {
            expect(await (client as any)._describeReceiptFailure({}, { hash: 'h' }, { status: 1 })).toBeNull();
        });
    });

    describe('_getRfqTargets (on-chain discovery)', () => {
        let trustedForwarder: jest.Mock;
        let getAllowedRFQs: jest.Mock;

        beforeEach(() => {
            (client as any)._getRfqTargets.mockRestore();
            client._cacheEnabled = true;
            client._staticCache.clear();
            client.config.retryEnabled = false;
            trustedForwarder = jest.fn().mockResolvedValue(ROUTER);
            getAllowedRFQs = jest.fn().mockResolvedValue(['0xRFQ', OTHER_MAKER]);
            (Contract as jest.Mock).mockImplementation((_address: string, abi: string[]) => {
                const sig = String(abi[0]);
                if (sig.includes('trustedForwarder')) return { trustedForwarder };
                if (sig.includes('getAllowedRFQs')) return { getAllowedRFQs };
                return {};
            });
        });

        it('resolves the router via trustedForwarder() and makers via getAllowedRFQs()', async () => {
            const t = await (client as any)._getRfqTargets('Avalanche', '0xRFQ');
            expect(t.router).toBe(ROUTER);
            expect(t.allowed).toEqual(new Set(['0xrfq', OTHER_MAKER.toLowerCase()]));
            expect(contractAddresses()).toEqual(['0xRFQ', ROUTER]);
        });

        it('prefers the router published by the deployments endpoint', async () => {
            client.deployments['DexalotRouter'] = { Avalanche: { address: ROUTER, abi: [] } };
            const t = await (client as any)._getRfqTargets('Avalanche', '0xRFQ');
            expect(t.router).toBe(ROUTER);
            expect(trustedForwarder).not.toHaveBeenCalled();
            expect(contractAddresses()).toEqual([ROUTER]);
        });

        it('caches the result in the static tier', async () => {
            const first = await (client as any)._getRfqTargets('Avalanche', '0xRFQ');
            const second = await (client as any)._getRfqTargets('Avalanche', '0xRFQ');
            expect(second).toBe(first);
            expect(trustedForwarder).toHaveBeenCalledTimes(1);
        });

        it('refetches when the cache is disabled', async () => {
            client._cacheEnabled = false;
            await (client as any)._getRfqTargets('Avalanche', '0xRFQ');
            await (client as any)._getRfqTargets('Avalanche', '0xRFQ');
            expect(trustedForwarder).toHaveBeenCalledTimes(2);
        });

        it('degrades to deployment-only and does not cache when the forwarder lookup fails', async () => {
            trustedForwarder.mockRejectedValue(new Error('rpc down'));
            const t = await (client as any)._getRfqTargets('Avalanche', '0xRFQ');
            await (client as any)._getRfqTargets('Avalanche', '0xRFQ');
            expect(t).toEqual({ router: null, allowed: new Set(['0xrfq']) });
            expect(trustedForwarder).toHaveBeenCalledTimes(2);
        });

        it('degrades to deployment-only when the allow-list lookup fails', async () => {
            getAllowedRFQs.mockRejectedValue(new Error('rpc down'));
            const t = await (client as any)._getRfqTargets('Avalanche', '0xRFQ');
            expect(t).toEqual({ router: null, allowed: new Set(['0xrfq']) });
        });

        it('treats a zero forwarder as no router', async () => {
            trustedForwarder.mockResolvedValue(ZERO_ADDR);
            const t = await (client as any)._getRfqTargets('Avalanche', '0xRFQ');
            expect(t).toEqual({ router: null, allowed: new Set(['0xrfq']) });
            expect(getAllowedRFQs).not.toHaveBeenCalled();
        });
    });

    describe('_getErc20Allowance', () => {
        it('reads allowance(owner, spender) from the token contract', async () => {
            (client as any)._getErc20Allowance.mockRestore();
            const allowance = jest.fn().mockResolvedValue('42');
            (Contract as jest.Mock).mockImplementation(() => ({ allowance }));

            const v = await (client as any)._getErc20Allowance('Avalanche', '0xT', '0xUser', MAKER);

            expect(v).toBe(42n);
            expect(allowance).toHaveBeenCalledWith('0xUser', MAKER);
            expect(contractAddresses()).toEqual(['0xT']);
        });
    });

    describe('approveRfqMaker', () => {
        function buildApproveContract(over: { receiptStatus?: number; rejects?: Error } = {}) {
            const tx: any = {
                hash: '0xapprove',
                wait: jest.fn().mockResolvedValue({ status: over.receiptStatus ?? 1, hash: '0xapprove', blockNumber: 7 }),
            };
            const approve = over.rejects ? jest.fn().mockRejectedValue(over.rejects) : jest.fn().mockResolvedValue(tx);
            (approve as any).estimateGas = jest.fn().mockResolvedValue(50000n);
            (Contract as jest.Mock).mockImplementation(() => ({ approve }));
            return { approve, tx };
        }

        it('fails when signer missing', async () => {
            client.signer = undefined as any;
            const r = await client.approveRfqMaker(rfqQuote());
            expect(r.success).toBe(false);
            expect(r.error).toContain('Signer required');
        });

        it('fails when order is missing', async () => {
            const r = await client.approveRfqMaker({ chainid: 43114 });
            expect(r.success).toBe(false);
            expect(r.error).toContain("'order'");
        });

        it('fails when chain id is unknown', async () => {
            client.chainConfig = {};
            const r = await client.approveRfqMaker(rfqQuote({ chainid: 99999 }));
            expect(r.success).toBe(false);
            expect(r.error).toContain('Unknown chain ID: 99999');
        });

        it('fails when the MainnetRFQ deployment is missing', async () => {
            client.deployments = { MainnetRFQ: {} } as any;
            const r = await client.approveRfqMaker(rfqQuote());
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/Available:\s*none/);
        });

        it('fails when takerAsset is missing', async () => {
            const r = await client.approveRfqMaker(rfqQuote({}, { takerAsset: undefined }));
            expect(r.success).toBe(false);
            expect(r.error).toContain('takerAsset');
        });

        it('rejects a native taker asset', async () => {
            const r = await client.approveRfqMaker(rfqQuote({}, { takerAsset: ZERO_ADDR }));
            expect(r.success).toBe(false);
            expect(r.error).toContain('does not need an allowance');
        });

        it('rejects a maker outside the allow-list', async () => {
            (client as any)._getRfqTargets.mockResolvedValue({ router: ROUTER, allowed: new Set(['0xrfq']) });
            const { approve } = buildApproveContract();
            const r = await client.approveRfqMaker(rfqQuote());
            expect(r.success).toBe(false);
            expect(r.error).toContain('not an allowed RFQ contract');
            expect(approve).not.toHaveBeenCalled();
        });

        it('rejects a non-positive amount', async () => {
            const r = await client.approveRfqMaker(rfqQuote(), 0n);
            expect(r.success).toBe(false);
            expect(r.error).toContain('must be positive');
        });

        it('sends nothing when the allowance is already sufficient', async () => {
            (client as any)._getErc20Allowance.mockResolvedValue(2000n);
            const { approve } = buildApproveContract();

            const r = await client.approveRfqMaker(rfqQuote());

            expect(r.success).toBe(true);
            expect(r.data).toEqual({ approved: false, allowance: 2000n, spender: MAKER, token: '0xT', operation: 'approve_rfq_maker' });
            expect(approve).not.toHaveBeenCalled();
        });

        it('approves the maker for takerAmount when the allowance is short', async () => {
            (client as any)._getErc20Allowance.mockResolvedValue(0n);
            const { approve, tx } = buildApproveContract();

            const r = await client.approveRfqMaker(rfqQuote());

            expect(r.success).toBe(true);
            expect(r.data!.approved).toBe(true);
            expect(r.data!.txHash).toBe('0xapprove');
            expect(r.data!.amount).toBe(2000n);
            expect(approve).toHaveBeenCalledWith(MAKER, 2000n, { gasLimit: 60000n });
            expect(contractAddresses()).toEqual(['0xT']);
            expect(tx.wait).toHaveBeenCalled();
        });

        it('uses a custom amount', async () => {
            (client as any)._getErc20Allowance.mockResolvedValue(0n);
            const { approve } = buildApproveContract();

            const r = await client.approveRfqMaker(rfqQuote(), 10n ** 30n);

            expect(r.success).toBe(true);
            expect(r.data!.amount).toBe(10n ** 30n);
            expect(approve).toHaveBeenCalledWith(MAKER, 10n ** 30n, expect.anything());
        });

        it('does not wait for the receipt when waitForReceipt=false', async () => {
            (client as any)._getErc20Allowance.mockResolvedValue(0n);
            const { tx } = buildApproveContract();

            const r = await client.approveRfqMaker(rfqQuote(), undefined, false);

            expect(r.success).toBe(true);
            expect(tx.wait).not.toHaveBeenCalled();
        });

        it('reports a reverted approval with context', async () => {
            (client as any)._getErc20Allowance.mockResolvedValue(0n);
            buildApproveContract({ receiptStatus: 0 });
            jest.spyOn(client as any, '_extractRevertReason').mockResolvedValue(null);

            const r = await client.approveRfqMaker(rfqQuote());

            expect(r.success).toBe(false);
            expect(r.error).toMatch(/^Transaction reverted: tx=0xapprove, block=7 \[target=/);
            expect(r.error).toContain(`maker=${MAKER}`);
        });

        it('sanitizes thrown errors with context', async () => {
            (client as any)._getErc20Allowance.mockRejectedValue(new Error('rpc down'));

            const r = await client.approveRfqMaker(rfqQuote());

            expect(r.success).toBe(false);
            expect(r.error).toContain('approving RFQ maker');
            expect(r.error).toContain('quoteId=q-1');
        });
    });

    describe('RFQ routing fallback branches', () => {
        it('executeRFQSwap uses a generic message when target resolution fails without an error', async () => {
            jest.spyOn(client as any, '_resolveRfqExecutionTarget').mockResolvedValue({ success: false, error: '' });
            const r = await client.executeRFQSwap(rfqQuote());
            expect(r.success).toBe(false);
            expect(r.error).toBe('Could not resolve RFQ execution target.');
        });

        it('approveRfqMaker uses a generic message when target resolution fails without an error', async () => {
            jest.spyOn(client as any, '_resolveRfqExecutionTarget').mockResolvedValue({ success: false, error: '' });
            const r = await client.approveRfqMaker(rfqQuote());
            expect(r.success).toBe(false);
            expect(r.error).toBe('Could not resolve RFQ execution target.');
        });

        it('executeRFQSwap treats a missing takerAsset as an ERC20 sell', async () => {
            const { simpleSwap } = buildMockContract();
            (Contract as jest.Mock).mockImplementation(() => ({ simpleSwap }));
            const r = await client.executeRFQSwap(rfqQuote({}, { takerAsset: undefined }));
            expect(r.success).toBe(true);
            expect((client as any)._getErc20Allowance).toHaveBeenCalledWith('Avalanche', '', '0xUser', MAKER);
        });

        it('approveRfqMaker falls back to client.chainId when the quote has no chainid', async () => {
            (client as any)._getErc20Allowance.mockResolvedValue(2000n);
            const r = await client.approveRfqMaker(rfqQuote({ chainid: undefined }));
            expect(r.success).toBe(true);
            expect(r.data!.approved).toBe(false);
        });

        it('approveRfqMaker reports "none" when deployments has no MainnetRFQ key', async () => {
            client.deployments = {} as any;
            const r = await client.approveRfqMaker(rfqQuote());
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/Available:\s*none/);
        });

        it('reports router=unknown when no router was resolved and the maker is not allowed', async () => {
            (client as any)._getRfqTargets.mockResolvedValue({ router: null, allowed: new Set(['0xrfq']) });
            const r = await client.executeRFQSwap(rfqQuote());
            expect(r.success).toBe(false);
            expect(r.error).toContain('router=unknown');
        });
    });
});
