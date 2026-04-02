import { TransactionResponse } from 'ethers';
import { SwapQuote } from '../types/index.js';
import { ENDPOINTS, DEFAULTS } from '../constants.js';
import { CLOBClient } from './clob.js';
import { Result } from '../utils/result.js';
import { withInstanceCache } from '../utils/cache.js';
import { validateSwapParams, validateChainIdentifier } from '../utils/inputValidators.js';

export class SwapClient extends CLOBClient {

        public rfqPairs: Record<number, any> = {};

        /**
         * Transform API quote response to match standardized field names (camelCase).
         * Maps lowercase/snake_case API fields to camelCase SDK fields.
         * Preserves existing camelCase fields if present, otherwise transforms from alternative formats.
         */
        private _transformQuoteFromAPI(quote: any): SwapQuote {
            const transformed: any = { ...quote };

            // Transform chainId: prefer existing camelCase, fallback to lowercase/snake_case
            if (!transformed.chainId) {
                transformed.chainId = quote.chainid ?? quote.chain_id;
            }

            // Transform secureQuote: prefer existing camelCase, fallback to lowercase/snake_case
            if (transformed.secureQuote) {
                // Already exists, but ensure nested fields are transformed
                transformed.secureQuote = this._transformSecureQuoteFromAPI(transformed.secureQuote);
            } else if (quote.securequote) {
                transformed.secureQuote = this._transformSecureQuoteFromAPI(quote.securequote);
            } else if (quote.secure_quote) {
                transformed.secureQuote = this._transformSecureQuoteFromAPI(quote.secure_quote);
            } else if (quote.secureQuote) {
                transformed.secureQuote = this._transformSecureQuoteFromAPI(quote.secureQuote);
            }

            // Transform quoteId: prefer existing camelCase, fallback to lowercase/snake_case
            if (!transformed.quoteId) {
                transformed.quoteId = quote.quoteid ?? quote.quote_id;
            }

            return transformed as SwapQuote;
        }

        /**
         * Transform secureQuote object fields to camelCase.
         */
        private _transformSecureQuoteFromAPI(secureQuote: any): any {
            if (!secureQuote) return secureQuote;

            const transformed: any = { ...secureQuote };

            // Transform data/order object if present
            if (secureQuote.data) {
                transformed.data = this._transformOrderDataFromAPI(secureQuote.data);
            }
            if (secureQuote.order) {
                transformed.order = this._transformOrderDataFromAPI(secureQuote.order);
            }

            return transformed;
        }

        /**
         * Transform order data object fields to camelCase.
         */
        private _transformOrderDataFromAPI(orderData: any): any {
            if (!orderData) return orderData;

            const transformed: any = { ...orderData };

            // Transform nonceAndMeta: prefer existing camelCase, fallback to snake_case
            if (transformed.nonceAndMeta === undefined) {
                transformed.nonceAndMeta = orderData.nonce_and_meta;
            }

            // Transform makerAsset: prefer existing camelCase, fallback to snake_case
            if (transformed.makerAsset === undefined) {
                transformed.makerAsset = orderData.maker_asset;
            }

            // Transform takerAsset: prefer existing camelCase, fallback to snake_case
            if (transformed.takerAsset === undefined) {
                transformed.takerAsset = orderData.taker_asset;
            }

            // Transform makerAmount: prefer existing camelCase, fallback to snake_case
            if (transformed.makerAmount === undefined) {
                transformed.makerAmount = orderData.maker_amount;
            }

            // Transform takerAmount: prefer existing camelCase, fallback to snake_case
            if (transformed.takerAmount === undefined) {
                transformed.takerAmount = orderData.taker_amount;
            }

            return transformed;
        }

        /**
         * Get available swap pairs for a specific chain.
         * Cached for 15 minutes (semi-static data).
         */
        public async getSwapPairs(chainId: number): Promise<Result<any>> {
            const cachedFn = withInstanceCache(
                this,
                this._semiStaticCache,
                'getSwapPairs',
                async (chainId: number): Promise<Result<any>> => {
                    const chainResult = validateChainIdentifier(chainId, 'chainId');
                    if (!chainResult.success) {
                        return Result.fail(chainResult.error!);
                    }

                    try {
                        if (!this.rfqPairs[chainId]) {
                            const data = await this._apiCall<any>('get', ENDPOINTS.RFQ_PAIRS, { 
                                params: { chainid: chainId } 
                            });
                            this.rfqPairs[chainId] = data;
                        }
                        return Result.ok(this.rfqPairs[chainId]);
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, `fetching RFQ pairs for chain ${chainId}`));
                    }
                }
            );
            return cachedFn(chainId);
        }

        /**
         * Get a swap quote (firm or indicative).
         */
        public async getSwapQuote(
            fromToken: string, 
            toToken: string, 
            amount: number, 
            firm: boolean = false, 
            chainId?: number
        ): Promise<Result<SwapQuote>> {
            const validationResult = validateSwapParams(fromToken, toToken, amount);
            if (!validationResult.success) {
                return Result.fail(validationResult.error!);
            }

            const cid = chainId || this.chainId;
            
            try {
                const pair = await this._resolvePair(fromToken, toToken, cid);
                if (!pair) {
                    return Result.fail(`Pair ${fromToken}/${toToken} not found`);
                }

                const isBase = pair.isBase;
                const side = pair.tradeSide;
                
                const params: any = {
                    chainid: cid,
                    pair: pair.name,
                    amount: amount.toString(),
                    isbase: isBase ? "1" : "0",
                    side: side.toString(),
                };

                const endpoint = firm ? ENDPOINTS.RFQ_FIRM_QUOTE : ENDPOINTS.RFQ_PAIR_PRICE;
                if (firm) {
                    if (!this.signer) {
                        return Result.fail('Signer required for firm quote');
                    }
                    params['address'] = await this.signer.getAddress();
                } else {
                    params['taker'] = DEFAULTS.TAKER_ADDRESS;
                }

                const data = await this._apiCall<SwapQuote>('get', endpoint, { params });
                const transformed = this._transformQuoteFromAPI(data);
                return Result.ok(transformed);
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'fetching swap quote'));
            }
        }

        /**
         * Get a firm quote for swap execution.
         */
        public async getSwapFirmQuote(
            fromToken: string, 
            toToken: string, 
            amount: number, 
            chainId?: number
        ): Promise<Result<SwapQuote>> {
            return this.getSwapQuote(fromToken, toToken, amount, true, chainId);
        }

        /**
         * Get an indicative (soft) quote.
         */
        public async getSwapSoftQuote(
            fromToken: string, 
            toToken: string, 
            amount: number, 
            chainId?: number
        ): Promise<Result<SwapQuote>> {
            return this.getSwapQuote(fromToken, toToken, amount, false, chainId);
        }

        public async _resolvePair(from: string, to: string, chainId: number) {
            const pairsResult = await this.getSwapPairs(chainId);
            if (!pairsResult.success) {
                return null;
            }
            
            const pairs = pairsResult.data;
            const p1 = `${from}/${to}`;
            const p2 = `${to}/${from}`;
            
            if (pairs[p1]) return { name: p1, tradeSide: 1, isBase: true };
            if (pairs[p2]) return { name: p2, tradeSide: 0, isBase: false };

            return null;
        }

        /**
         * Execute an RFQ swap using a firm quote.
         */
        public async executeRFQSwap(
            quote: any,
            waitForReceipt: boolean = true
        ): Promise<Result<{ tx_hash: string; operation: string }>> {
            if (!this.signer) {
                return Result.fail('Signer required');
            }

            // Transform quote to ensure standardized field names
            const transformedQuote = this._transformQuoteFromAPI(quote);
            
            const secureQuote = transformedQuote.secureQuote;
            if (!secureQuote) {
                return Result.fail('Invalid quote: missing secureQuote');
            }

            const sig = secureQuote.signature;
            const orderData = secureQuote.data || secureQuote.order;

            if (!sig || !orderData) {
                return Result.fail('Invalid secure quote: missing signature or order data');
            }

            const chainId = transformedQuote.chainId || this.chainId;
            const chainName = this._getChainNameFromId(chainId);
            
            if (!chainName) {
                return Result.fail(`Unknown chain ID: ${chainId}`);
            }

            const rfqDep = this._mainnetRfqDeployment(chainName);
            if (!rfqDep) {
                const available = Object.keys(this.deployments['MainnetRFQ'] || {}).join(', ');
                return Result.fail(
                    `RFQ contract not found for '${chainName}'. Available: ${available || 'none'}`
                );
            }

            try {
                const orderTuple = [
                    orderData.nonceAndMeta,
                    orderData.expiry,
                    orderData.makerAsset,
                    orderData.takerAsset,
                    orderData.maker,
                    orderData.taker,
                    orderData.makerAmount,
                    orderData.takerAmount
                ];

                return await this.withRpcFailover(chainName, async (provider) => {
                    const contract = this._contractForSigner(
                        provider,
                        rfqDep.address,
                        rfqDep.abi
                    );
                    const tx = await contract.simpleSwap(orderTuple, sig);
                    
                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({ tx_hash: receipt.hash, operation: 'execute_rfq_swap' });
                    }

                    return Result.ok({ tx_hash: tx.hash, operation: 'execute_rfq_swap' });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'executing swap'));
            }
        }
}
