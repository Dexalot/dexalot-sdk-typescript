
import { SwapClient } from '../../src/core/swap';
import { ENDPOINTS, DEFAULTS } from '../../src/constants';
import { Contract } from 'ethers';

// Mock ethers
jest.mock('ethers');

// Mock specific console.error to avoid noise
jest.spyOn(console, 'error').mockImplementation(() => {});

class TestClient extends SwapClient {}

describe('SwapClient', () => {
    let client: TestClient;
    let mockSigner: any;
    let mockAxios: any;

    const MOCK_PAIRS = {
        'AVAX/USDT': { pair: 'AVAX/USDT' },
        'USDT/AVAX': { pair: 'USDT/AVAX' } // Normally mirrors
    };

    beforeEach(() => {
        jest.clearAllMocks();

        mockSigner = {
            getAddress: jest.fn().mockResolvedValue('0xUser'),
            connect: jest.fn().mockImplementation(function (this: any) {
                return this;
            })
        };

        mockAxios = {
            get: jest.fn(),
            request: jest.fn()
        };

        client = new TestClient(mockSigner);
        // Inject mock axios
        (client as any).axios = mockAxios;
        client.deployments = {
            'MainnetRFQ': {
                'Avalanche': { address: '0xRFQ', abi: [] }
            }
        };
        client.connectedChainProviders = { Avalanche: {} as any };
        client.chainId = 43114;
        // Setup chainConfig for chain name resolution
        client.chainConfig = {
            'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any
        };
    });

    describe('getSwapPairs', () => {
        it('should fetch from API if cache empty', async () => {
            mockAxios.request.mockResolvedValueOnce({ data: MOCK_PAIRS });
            const result = await client.getSwapPairs(43114);
            expect(result.success).toBe(true);
            expect(result.data).toEqual(MOCK_PAIRS);
        });

        it('should return from cache if present', async () => {
            client.rfqPairs[43114] = MOCK_PAIRS;
            const result = await client.getSwapPairs(43114);
            expect(result.success).toBe(true);
            expect(result.data).toEqual(MOCK_PAIRS);
            expect(mockAxios.request).not.toHaveBeenCalled();
        });

        it('should return error on API failure', async () => {
            mockAxios.request.mockRejectedValue(new Error("API Fail"));
            const result = await client.getSwapPairs(43114);
            expect(result.success).toBe(false);
            expect(result.error).toContain('fetching RFQ pairs');
        });

        it('should fail validation for invalid chainId', async () => {
            const result = await client.getSwapPairs(-1);
            expect(result.success).toBe(false);
            expect(result.error).toContain('chainId');
        });
    });

    describe('_transformQuoteFromAPI', () => {
        it('should transform lowercase fields to camelCase', () => {
            const quote = {
                chainid: 43114,
                securequote: {
                    signature: '0xSig',
                    data: {
                        nonce_and_meta: 1,
                        expiry: 1,
                        maker_asset: '0xM',
                        taker_asset: '0xT',
                        maker: '0xMkr',
                        taker: '0xTkr',
                        maker_amount: 100,
                        taker_amount: 200
                    }
                },
                quoteid: 'q123'
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.chainId).toBe(43114);
            expect(transformed.secureQuote).toBeDefined();
            expect(transformed.secureQuote.signature).toBe('0xSig');
            expect(transformed.secureQuote.data.nonceAndMeta).toBe(1);
            expect(transformed.secureQuote.data.makerAsset).toBe('0xM');
            expect(transformed.secureQuote.data.takerAsset).toBe('0xT');
            expect(transformed.secureQuote.data.makerAmount).toBe(100);
            expect(transformed.secureQuote.data.takerAmount).toBe(200);
            expect(transformed.quoteId).toBe('q123');
        });

        it('should prefer existing camelCase fields', () => {
            const quote = {
                chainId: 43114,
                secureQuote: {
                    signature: '0xSig',
                    data: {
                        nonceAndMeta: 1,
                        makerAsset: '0xM',
                        takerAsset: '0xT',
                        makerAmount: 100,
                        takerAmount: 200
                    }
                },
                quoteId: 'q123',
                chainid: 999, // Should be ignored
                securequote: {}, // Should be ignored
                quoteid: 'ignored' // Should be ignored
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.chainId).toBe(43114); // Prefer existing
            expect(transformed.quoteId).toBe('q123'); // Prefer existing
            expect(transformed.secureQuote).toBeDefined();
            expect(transformed.secureQuote.data.nonceAndMeta).toBe(1); // Prefer existing
        });

        it('should handle secure_quote (snake_case) field', () => {
            const quote = {
                chainid: 43114,
                secure_quote: {
                    signature: '0xSig',
                    data: {
                        nonce_and_meta: 1
                    }
                }
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.secureQuote).toBeDefined();
            expect(transformed.secureQuote.signature).toBe('0xSig');
            expect(transformed.secureQuote.data.nonceAndMeta).toBe(1);
        });

        it('should handle order field (legacy)', () => {
            const quote = {
                chainid: 43114,
                securequote: {
                    signature: '0xSig',
                    order: {
                        nonce_and_meta: 1,
                        maker_asset: '0xM'
                    }
                }
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.secureQuote.order).toBeDefined();
            expect(transformed.secureQuote.order.nonceAndMeta).toBe(1);
            expect(transformed.secureQuote.order.makerAsset).toBe('0xM');
        });

        it('should handle secureQuote (camelCase) field when securequote and secure_quote are missing', () => {
            // Create an object where secureQuote exists but won't be in transformed due to property descriptor
            const quote: any = {
                chainid: 43114
            };
            // Use Object.defineProperty to create a non-enumerable property that won't be copied by spread
            Object.defineProperty(quote, 'secureQuote', {
                value: {
                    signature: '0xSig',
                    data: {
                        nonce_and_meta: 1
                    }
                },
                enumerable: false, // Non-enumerable, so won't be in spread
                configurable: true
            });

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.secureQuote).toBeDefined();
            expect(transformed.secureQuote.signature).toBe('0xSig');
            expect(transformed.secureQuote.data.nonceAndMeta).toBe(1);
        });

        it('should handle chain_id (snake_case) field', () => {
            const quote = {
                chain_id: 43114,
                securequote: {
                    signature: '0xSig'
                }
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.chainId).toBe(43114);
        });

        it('should handle quote_id (snake_case) field', () => {
            const quote = {
                chainid: 43114,
                quote_id: 'q123',
                securequote: {
                    signature: '0xSig'
                }
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.quoteId).toBe('q123');
        });

        it('should transform nested fields when secureQuote already exists', () => {
            const quote = {
                chainId: 43114,
                secureQuote: {
                    signature: '0xSig',
                    data: {
                        nonce_and_meta: 1,
                        maker_asset: '0xM'
                    }
                }
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.secureQuote.data.nonceAndMeta).toBe(1);
            expect(transformed.secureQuote.data.makerAsset).toBe('0xM');
        });

        it('should handle secureQuote with only data field (no order)', () => {
            const quote = {
                chainid: 43114,
                securequote: {
                    signature: '0xSig',
                    data: {
                        nonce_and_meta: 1
                    }
                    // No order field
                }
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.secureQuote.data).toBeDefined();
            expect(transformed.secureQuote.data.nonceAndMeta).toBe(1);
            expect(transformed.secureQuote.order).toBeUndefined();
        });

        it('should handle secureQuote with only order field (no data)', () => {
            const quote = {
                chainid: 43114,
                securequote: {
                    signature: '0xSig',
                    order: {
                        nonce_and_meta: 1
                    }
                    // No data field
                }
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.secureQuote.order).toBeDefined();
            expect(transformed.secureQuote.order.nonceAndMeta).toBe(1);
            expect(transformed.secureQuote.data).toBeUndefined();
        });

        it('should handle null/undefined secureQuote', () => {
            const quote = {
                chainid: 43114,
                securequote: null
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            // When securequote is null, it's not included in the spread, so secureQuote is undefined
            expect(transformed.secureQuote).toBeUndefined();
        });

        it('should handle null/undefined orderData', () => {
            const quote = {
                chainid: 43114,
                securequote: {
                    signature: '0xSig',
                    data: null
                }
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.secureQuote.data).toBeNull();
        });

        it('should handle partial order data fields', () => {
            const quote = {
                chainid: 43114,
                securequote: {
                    signature: '0xSig',
                    data: {
                        nonceAndMeta: 1, // Already camelCase
                        maker_asset: '0xM', // Needs transformation
                        // Missing other fields
                    }
                }
            };

            const transformed = (client as any)._transformQuoteFromAPI(quote);
            expect(transformed.secureQuote.data.nonceAndMeta).toBe(1);
            expect(transformed.secureQuote.data.makerAsset).toBe('0xM');
            expect(transformed.secureQuote.data.takerAsset).toBeUndefined();
        });

        it('should handle null secureQuote in _transformSecureQuoteFromAPI', () => {
            const result = (client as any)._transformSecureQuoteFromAPI(null);
            expect(result).toBeNull();
        });

        it('should handle undefined secureQuote in _transformSecureQuoteFromAPI', () => {
            const result = (client as any)._transformSecureQuoteFromAPI(undefined);
            expect(result).toBeUndefined();
        });

        it('should handle null orderData in _transformOrderDataFromAPI', () => {
            const result = (client as any)._transformOrderDataFromAPI(null);
            expect(result).toBeNull();
        });

        it('should handle undefined orderData in _transformOrderDataFromAPI', () => {
            const result = (client as any)._transformOrderDataFromAPI(undefined);
            expect(result).toBeUndefined();
        });
    });

    describe('getSwapQuote', () => {
        beforeEach(() => {
             // Mock default pair resolution
             client.rfqPairs[43114] = MOCK_PAIRS;
        });

        it('should return indicative quote (Buy Side)', async () => {
             client.rfqPairs[43114] = { 'AVAX/USDT': {} };
             mockAxios.request.mockResolvedValue({ data: { price: 100 } });

             const result = await client.getSwapQuote('USDT', 'AVAX', 10);
             expect(result.success).toBe(true);
             expect(mockAxios.request).toHaveBeenCalledWith(expect.objectContaining({
                 method: 'get',
                 url: ENDPOINTS.RFQ_PAIR_PRICE
             }));
        });

        it('should transform quote fields from API response', async () => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
            mockAxios.request.mockResolvedValue({
                data: {
                    chainid: 43114,
                    securequote: {
                        signature: '0xSig',
                        data: {
                            nonce_and_meta: 1,
                            maker_asset: '0xM'
                        }
                    }
                }
            });

            const result = await client.getSwapQuote('AVAX', 'USDT', 10, true);
            expect(result.success).toBe(true);
            expect(result.data.chainId).toBe(43114);
            expect(result.data.secureQuote).toBeDefined();
            expect(result.data.secureQuote.data.nonceAndMeta).toBe(1);
            expect(result.data.secureQuote.data.makerAsset).toBe('0xM');
        });

        it('should return firm quote', async () => {
             client.rfqPairs[43114] = { 'AVAX/USDT': {} };
             mockAxios.request.mockResolvedValue({ data: { securequote: {} } });

             const result = await client.getSwapQuote('AVAX', 'USDT', 10, true);
             expect(result.success).toBe(true);
        });

        it('should return error if signer missing for firm quote', async () => {
             client.signer = undefined as any;
             const result = await client.getSwapQuote('AVAX', 'USDT', 1, true);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer required');
        });

        it('should return error if pair not found', async () => {
             client.rfqPairs[43114] = {}; // Empty
             const result = await client.getSwapQuote('A', 'B', 1);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Pair A/B not found');
        });

        it('should validate input parameters', async () => {
            const result = await client.getSwapQuote('', 'B', 1);
            expect(result.success).toBe(false);
        });

        it('should handle error in catch block', async () => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
            mockAxios.request.mockRejectedValue(new Error('API error'));
            const result = await client.getSwapQuote('AVAX', 'USDT', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('fetching swap quote');
        });
    });

    describe('getSwapFirmQuote', () => {
        beforeEach(() => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
        });

        it('should call getSwapQuote with firm=true', async () => {
            mockAxios.request.mockResolvedValue({ data: { securequote: {} } });
            const result = await client.getSwapFirmQuote('AVAX', 'USDT', 10);
            expect(result.success).toBe(true);
            expect(mockAxios.request).toHaveBeenCalledWith(expect.objectContaining({
                method: 'get',
                url: ENDPOINTS.RFQ_FIRM_QUOTE
            }));
        });

        it('should support custom chainId', async () => {
            client.rfqPairs[1] = { 'ETH/USDT': {} };
            mockAxios.request.mockResolvedValue({ data: { securequote: {} } });
            const result = await client.getSwapFirmQuote('ETH', 'USDT', 10, 1);
            expect(result.success).toBe(true);
        });
    });

    describe('getSwapSoftQuote', () => {
        beforeEach(() => {
            client.rfqPairs[43114] = { 'AVAX/USDT': {} };
        });

        it('should call getSwapQuote with firm=false', async () => {
            mockAxios.request.mockResolvedValue({ data: { price: 100 } });
            const result = await client.getSwapSoftQuote('AVAX', 'USDT', 10);
            expect(result.success).toBe(true);
            expect(mockAxios.request).toHaveBeenCalledWith(expect.objectContaining({
                method: 'get',
                url: ENDPOINTS.RFQ_PAIR_PRICE
            }));
        });

        it('should support custom chainId', async () => {
            client.rfqPairs[1] = { 'ETH/USDT': {} };
            mockAxios.request.mockResolvedValue({ data: { price: 100 } });
            const result = await client.getSwapSoftQuote('ETH', 'USDT', 10, 1);
            expect(result.success).toBe(true);
        });
    });

    describe('executeRFQSwap', () => {
        it('should call contract simpleSwap', async () => {
             const mockContract = {
                 simpleSwap: jest.fn().mockResolvedValue({ 
                     hash: 'txHash',
                     wait: jest.fn().mockResolvedValue({ status: 1, hash: 'txHash' })
                 })
             };
             (Contract as jest.Mock).mockImplementation(() => mockContract);

             const quote = {
                 chainid: 43114,
                 securequote: {
                     signature: '0xSig',
                     data: {
                         nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT',
                         maker: '0xMkr', taker: '0xTkr', makerAmount: 1, takerAmount: 1
                     }
                 }
             };

             const result = await client.executeRFQSwap(quote);
             expect(result.success).toBe(true);
             expect(result.data?.tx_hash).toBe('txHash');
             expect(result.data?.operation).toBe('execute_rfq_swap');
             expect(mockContract.simpleSwap).toHaveBeenCalled();
        });

        it('should handle legacy quote structure (order field)', async () => {
             const mockContract = { 
                 simpleSwap: jest.fn().mockResolvedValue({ 
                     hash: 'txHash',
                     wait: jest.fn().mockResolvedValue({ status: 1, hash: 'txHash' })
                 })
             };
             (Contract as jest.Mock).mockImplementation(() => mockContract);

             const quote = {
                 chainid: 43114,
                 securequote: {
                     signature: '0xSig',
                     order: { // Legacy field
                         nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT',
                         maker: '0xMkr', taker: '0xTkr', makerAmount: 1, takerAmount: 1
                     }
                 }
             };

             const result = await client.executeRFQSwap(quote);
             expect(result.success).toBe(true);
             expect(mockContract.simpleSwap).toHaveBeenCalled();
        });

        it('should return error if signer missing', async () => {
             client.signer = undefined as any;
             const result = await client.executeRFQSwap({});
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer required');
        });

        it('should return error if securequote missing', async () => {
             const result = await client.executeRFQSwap({});
             expect(result.success).toBe(false);
             expect(result.error).toContain('Invalid quote: missing secureQuote');
        });

        it('should handle transformed field names in executeRFQSwap', async () => {
            const mockContract = {
                simpleSwap: jest.fn().mockResolvedValue({ 
                    hash: 'txHash',
                    wait: jest.fn().mockResolvedValue({ status: 1, hash: 'txHash' })
                })
            };
            (Contract as jest.Mock).mockImplementation(() => mockContract);

            // Quote with lowercase/snake_case fields
            const quote = {
                chainid: 43114,
                securequote: {
                    signature: '0xSig',
                    data: {
                        nonce_and_meta: 1,
                        expiry: 1,
                        maker_asset: '0xM',
                        taker_asset: '0xT',
                        maker: '0xMkr',
                        taker: '0xTkr',
                        maker_amount: 100,
                        taker_amount: 200
                    }
                }
            };

            const result = await client.executeRFQSwap(quote);
            expect(result.success).toBe(true);
            expect(mockContract.simpleSwap).toHaveBeenCalled();
            // Verify the order tuple uses transformed field names
            const callArgs = mockContract.simpleSwap.mock.calls[0];
            expect(callArgs[0][0]).toBe(1); // nonceAndMeta
            expect(callArgs[0][2]).toBe('0xM'); // makerAsset
            expect(callArgs[0][3]).toBe('0xT'); // takerAsset
            expect(callArgs[0][6]).toBe(100); // makerAmount
            expect(callArgs[0][7]).toBe(200); // takerAmount
        });

        it('should return error if RFQ contract not found for chain', async () => {
            client.deployments['MainnetRFQ'] = {};
            const quote = { chainid: 43114, securequote: { signature: 's', data: {} } };
            const result = await client.executeRFQSwap(quote);
            expect(result.success).toBe(false);
            expect(result.error).toContain("RFQ contract not found for 'Avalanche'");
        });

        it('should return error if chainId is unknown', async () => {
            client.chainConfig = {}; // Empty - no chain config
            
            const quote = { 
                chainid: 99999, // Unknown chain ID 
                securequote: { signature: 's', data: {} } 
            };
            const result = await client.executeRFQSwap(quote);
            expect(result.success).toBe(false);
            expect(result.error).toContain("Unknown chain ID: 99999");
        });

        it('should use client.chainId when quote has no chainid', async () => {
            const mockContract = { 
                simpleSwap: jest.fn().mockResolvedValue({ 
                    hash: 'txHash',
                    wait: jest.fn().mockResolvedValue({ status: 1, hash: 'txHash' })
                })
            };
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            client.chainId = 43114;
            
            const quote = { 
                securequote: { 
                    signature: 's', 
                    data: { nonceAndMeta: 1, expiry: 1, makerAsset: 'a', takerAsset: 'b', maker: 'm', taker: 't', makerAmount: 1, takerAmount: 1 } 
                } 
            };
            const result = await client.executeRFQSwap(quote);
            expect(result.success).toBe(true);
            expect(mockContract.simpleSwap).toHaveBeenCalled();
        });

        it('should return error if signature is missing', async () => {
            const mockContract = { 
                simpleSwap: jest.fn().mockResolvedValue({ 
                    hash: 'txHash',
                    wait: jest.fn().mockResolvedValue({ status: 1, hash: 'txHash' })
                })
            };
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            
            const quote = {
                chainid: 43114,
                securequote: {
                    data: {
                        nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT',
                        maker: '0xMkr', taker: '0xTkr', makerAmount: 1, takerAmount: 1
                    }
                }
            };
            const result = await client.executeRFQSwap(quote);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid secure quote: missing signature or order data');
        });

        it('should return error if orderData is missing', async () => {
            const mockContract = { 
                simpleSwap: jest.fn().mockResolvedValue({ 
                    hash: 'txHash',
                    wait: jest.fn().mockResolvedValue({ status: 1, hash: 'txHash' })
                })
            };
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            
            const quote = {
                chainid: 43114,
                securequote: {
                    signature: '0xSig'
                }
            };
            const result = await client.executeRFQSwap(quote);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid secure quote: missing signature or order data');
        });

        it('should not wait for receipt when waitForReceipt=false in executeRFQSwap', async () => {
            const mockContract = { 
                simpleSwap: jest.fn().mockResolvedValue({ hash: 'txHash' })
            };
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            client.chainId = 43114;
            
            const quote = { 
                securequote: { 
                    signature: 's', 
                    data: { nonceAndMeta: 1, expiry: 1, makerAsset: 'a', takerAsset: 'b', maker: 'm', taker: 't', makerAmount: 1, takerAmount: 1 } 
                } 
            };
            const result = await client.executeRFQSwap(quote, false);
            
            expect(result.success).toBe(true);
            expect(result.data?.tx_hash).toBe('txHash');
            expect(result.data?.operation).toBe('execute_rfq_swap');
            expect(mockContract.simpleSwap).toHaveBeenCalled();
        });

        it('should return error when receipt status is not 1 in executeRFQSwap', async () => {
            const mockContract = { 
                simpleSwap: jest.fn().mockResolvedValue({ 
                    hash: 'txHash',
                    wait: jest.fn().mockResolvedValue({ status: 0, hash: 'txHash' })
                })
            };
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            client.chainId = 43114;
            
            const quote = { 
                securequote: { 
                    signature: 's', 
                    data: { nonceAndMeta: 1, expiry: 1, makerAsset: 'a', takerAsset: 'b', maker: 'm', taker: 't', makerAmount: 1, takerAmount: 1 } 
                } 
            };
            const result = await client.executeRFQSwap(quote, true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should handle contract call error', async () => {
            const mockContract = {
                simpleSwap: jest.fn().mockRejectedValue(new Error('Contract error'))
            };
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            
            const quote = {
                chainid: 43114,
                securequote: {
                    signature: '0xSig',
                    data: {
                        nonceAndMeta: 1, expiry: 1, makerAsset: '0xM', takerAsset: '0xT',
                        maker: '0xMkr', taker: '0xTkr', makerAmount: 1, takerAmount: 1
                    }
                }
            };
            const result = await client.executeRFQSwap(quote);
            expect(result.success).toBe(false);
            expect(result.error).toContain('executing swap');
        });
    });

    describe('_resolvePair', () => {
         it('should return null if no match', async () => {
              client.rfqPairs[43114] = {};
              const res = await client._resolvePair('A', 'B', 43114);
              expect(res).toBeNull();
         });

         it('should return null if getSwapPairs fails', async () => {
              mockAxios.request.mockRejectedValue(new Error('API error'));
              const res = await client._resolvePair('A', 'B', 43114);
              expect(res).toBeNull();
         });

         it('should return pair for forward direction', async () => {
              client.rfqPairs[43114] = { 'AVAX/USDT': {} };
              const res = await client._resolvePair('AVAX', 'USDT', 43114);
              expect(res).toEqual({ name: 'AVAX/USDT', tradeSide: 1, isBase: true });
         });

         it('should return pair for reverse direction', async () => {
              client.rfqPairs[43114] = { 'USDT/AVAX': {} };
              const res = await client._resolvePair('AVAX', 'USDT', 43114);
              expect(res).toEqual({ name: 'USDT/AVAX', tradeSide: 0, isBase: false });
         });
    });
});
