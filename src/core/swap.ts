import { TransactionResponse } from 'ethers';
import { SwapQuote } from '../types/index.js';
import { ENDPOINTS, DEFAULTS } from '../constants.js';
import { CLOBClient } from './clob.js';
import { Result } from '../utils/result.js';
import { withInstanceCache } from '../utils/cache.js';
import { validateSwapParams, validateChainIdentifier } from '../utils/inputValidators.js';

/**
 * MainnetRFQ uses the zero address to mean "the chain's native coin"
 * (e.g. AVAX on 43114). When the taker is selling native, `msg.value`
 * must equal `takerAmount`; for ERC20 takers it must be 0.
 */
const NATIVE_ZERO_ADDRESS = '0x' + '0'.repeat(40);

/**
 * Default multiplier applied to the simpleSwap gas estimate to absorb
 * variance at submission time. Mirrors the existing DEFAULTS.GAS_BUFFER
 * pattern used in TRANSFER paths.
 */
const SWAP_GAS_BUFFER = DEFAULTS.GAS_BUFFER;

export class SwapClient extends CLOBClient {

        public rfqPairs: Record<number, any> = {};

        /** Resolve a chain name or id string to a numeric chain ID for RFQ routing. */
        protected _resolveChainIdResult(chainIdentifier: number | string): Result<number> {
            if (chainIdentifier === null || chainIdentifier === undefined) {
                return Result.fail('Chain identifier is required.');
            }
            const resolved = this.resolveChainReference(chainIdentifier);
            if (
                resolved.success &&
                resolved.data != null &&
                resolved.data.chainId != null
            ) {
                return Result.ok(resolved.data.chainId);
            }
            const rawNum =
                typeof chainIdentifier === 'number' && Number.isInteger(chainIdentifier)
                    ? chainIdentifier
                    : typeof chainIdentifier === 'string' && /^\d+$/.test(chainIdentifier.trim())
                      ? Number(chainIdentifier.trim())
                      : null;
            if (rawNum !== null && rawNum > 0) {
                return Result.ok(rawNum);
            }
            return Result.fail(
                resolved.error ||
                    `Could not resolve chain identifier '${chainIdentifier}' to a Chain ID.`
            );
        }

        /**
         * Normalize a Dexalot firm-quote response.
         *
         * The HTTP response wraps the executable firm quote inside
         * `{"success": true, "quote": {...}}`. This helper unwraps that
         * envelope so downstream code operates on the inner dict, then
         * applies snake_case → camelCase aliases for top-level
         * identifiers and normalizes the inner `order` dict.
         *
         * Original keys are preserved; nothing is popped or renamed.
         * Envelope-layer failures (`{"success": false, "reason": ...}`)
         * are caught at the fetch site in `_getSwapQuoteBase` BEFORE the
         * transform runs, so this method never sees them.
         */
        private _transformQuoteFromAPI(quote: any): SwapQuote {
            // Unwrap {success: true, quote: {...}} envelope.
            if (
                quote && typeof quote === 'object' &&
                quote.quote && typeof quote.quote === 'object'
            ) {
                quote = quote.quote;
            }

            const transformed: any = { ...quote };

            // Map chainId: prefer existing camelCase, fallback to lowercase/snake_case.
            if (!transformed.chainId) {
                transformed.chainId = quote.chainid ?? quote.chain_id;
            }

            // Map quoteId: prefer existing camelCase, fallback to lowercase/snake_case.
            if (!transformed.quoteId) {
                transformed.quoteId = quote.quoteid ?? quote.quote_id;
            }

            // Normalize the inner order dict so downstream code can read
            // camelCase keys regardless of what the backend emitted.
            if (transformed.order && typeof transformed.order === 'object') {
                transformed.order = this._transformOrderDataFromAPI(transformed.order);
            }

            return transformed as SwapQuote;
        }

        /**
         * Transform order data object fields to camelCase aliases. The
         * original snake_case keys are preserved alongside the aliases
         * so callers reading either shape continue to work.
         */
        private _transformOrderDataFromAPI(orderData: any): any {
            if (!orderData) return orderData;

            const transformed: any = { ...orderData };

            if (transformed.nonceAndMeta === undefined) {
                transformed.nonceAndMeta = orderData.nonce_and_meta;
            }
            if (transformed.makerAsset === undefined) {
                transformed.makerAsset = orderData.maker_asset;
            }
            if (transformed.takerAsset === undefined) {
                transformed.takerAsset = orderData.taker_asset;
            }
            if (transformed.makerAmount === undefined) {
                transformed.makerAmount = orderData.maker_amount;
            }
            if (transformed.takerAmount === undefined) {
                transformed.takerAmount = orderData.taker_amount;
            }

            return transformed;
        }

        /**
         * Get available swap pairs for a specific chain.
         * Cached for 15 minutes (semi-static data).
         * @param chainIdentifier Numeric chain ID or chain display name.
         */
        public async getSwapPairs(chainIdentifier: number | string): Promise<Result<any>> {
            const chainResult = validateChainIdentifier(chainIdentifier, 'chainIdentifier');
            if (!chainResult.success) {
                return Result.fail(chainResult.error!);
            }

            const resolved = this._resolveChainIdResult(chainIdentifier);
            if (!resolved.success || resolved.data == null) {
                return Result.fail(
                    resolved.error ||
                        `Could not resolve chain identifier '${chainIdentifier}' to a Chain ID.`
                );
            }
            const chainId = resolved.data;

            const cachedFn = withInstanceCache(
                this,
                this._semiStaticCache,
                'getSwapPairs',
                async (cid: number): Promise<Result<any>> => {
                    try {
                        if (!this.rfqPairs[cid]) {
                            const data = await this._apiCall<any>('get', ENDPOINTS.RFQ_PAIRS, {
                                params: { chainid: cid },
                            });
                            this.rfqPairs[cid] = data;
                        }
                        return Result.ok(this.rfqPairs[cid]);
                    } catch (e) {
                        return Result.fail(
                            this._sanitizeError(e, `fetching RFQ pairs for chain ${cid}`)
                        );
                    }
                }
            );
            return cachedFn(chainId);
        }

        /**
         * Shared implementation for firm and soft quotes. Public callers use
         * `getSwapFirmQuote` / `getSwapSoftQuote`; this helper centralizes
         * pair resolution, parameter packing, envelope unwrap, and error
         * sanitization so the two public surfaces stay aligned.
         */
        private async _getSwapQuoteBase(
            fromToken: string,
            toToken: string,
            amount: number,
            firm: boolean,
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
                    isbase: isBase ? '1' : '0',
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

                const data = await this._apiCall<any>('get', endpoint, { params });

                // Envelope-layer failure: Dexalot RFQ returns
                // {"success": false, "reason": "..."} on logical failure even
                // with HTTP 200. Surface that as Result.fail BEFORE the
                // transform runs, so callers see the reason verbatim and
                // executeRFQSwap never operates on a garbage payload.
                if (data && typeof data === 'object' && data.success === false) {
                    const reason = data.reason || data.error || 'Quote API returned success=false';
                    return Result.fail(`Cannot execute failed quote: ${reason}`);
                }

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
            return this._getSwapQuoteBase(fromToken, toToken, amount, true, chainId);
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
            return this._getSwapQuoteBase(fromToken, toToken, amount, false, chainId);
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
         * Coerce an order field to bigint, accepting decimal or 0x-hex
         * strings. `nonceAndMeta` arrives 0x-prefixed; `makerAmount` /
         * `takerAmount` arrive as decimal strings; `expiry` arrives as a
         * JSON number. `BigInt()` itself accepts both 0x-hex and decimal
         * representations so a single call covers all of them.
         */
        protected _orderFieldToBigInt(value: unknown): bigint {
            if (value === null || value === undefined || value === '') return 0n;
            if (typeof value === 'bigint') return value;
            if (typeof value === 'number') return BigInt(value);
            return BigInt(String(value));
        }

        /**
         * Compute the `msg.value` to attach to a SimpleSwap call.
         *
         * MainnetRFQ requires `msg.value == takerAmount` when the taker
         * is sending the chain's native token (`takerAsset` is the zero
         * address), and `msg.value == 0` otherwise. Passing the wrong
         * value here causes the contract's `_checkValue` to revert.
         */
        protected _computeMsgValue(orderData: any): bigint {
            const takerAsset = String(
                orderData.takerAsset ?? orderData.taker_asset ?? ''
            ).toLowerCase();
            if (takerAsset === NATIVE_ZERO_ADDRESS) {
                return this._orderFieldToBigInt(
                    orderData.takerAmount ?? orderData.taker_amount
                );
            }
            return 0n;
        }

        /**
         * Best-effort extraction of the on-chain revert reason for a
         * failed tx. Re-runs the original transaction as `eth_call`
         * against the block in which it reverted; the node returns the
         * revert message (e.g. `execution reverted: RF-EXP-01`) which is
         * otherwise dropped from the receipt. Returns `null` if the call
         * cannot be replayed or the node refuses to surface a reason.
         */
        protected async _extractRevertReason(
            provider: any,
            tx: any,
            receipt: any
        ): Promise<string | null> {
            try {
                const blockTag = receipt && receipt.blockNumber != null
                    ? receipt.blockNumber
                    : undefined;
                const callTx: any = {
                    from: tx.from,
                    to: tx.to,
                    data: tx.data,
                };
                if (tx.value !== undefined && tx.value !== null) {
                    callTx.value = tx.value;
                }
                if (tx.gasLimit !== undefined) {
                    callTx.gasLimit = tx.gasLimit;
                }
                if (blockTag !== undefined) {
                    callTx.blockTag = blockTag;
                }

                try {
                    await provider.call(callTx);
                    return null;
                } catch (callExc) {
                    const msg = String((callExc as any)?.message ?? callExc);
                    const marker = 'execution reverted';
                    const idx = msg.indexOf(marker);
                    if (idx !== -1) {
                        const after = msg.slice(idx + marker.length)
                            .replace(/^[\s:]+/, '')
                            .replace(/^["']|["']$/g, '')
                            .trim();
                        return after || marker;
                    }
                    return msg.slice(0, 200) || null;
                }
            } catch {
                return null;
            }
        }

        /**
         * Execute an RFQ swap using a firm quote.
         *
         * Accepts either the inner firm-quote dict (with top-level
         * `signature` and `order` fields) or the raw envelope from
         * the firm-quote API (`{"success": true, "quote": {...}}`) —
         * the envelope is unwrapped automatically.
         */
        public async executeRFQSwap(
            quote: any,
            waitForReceipt: boolean = true
        ): Promise<Result<{ txHash: string; operation: string }>> {
            if (!this.signer) {
                return Result.fail('Signer required');
            }

            // Transform also unwraps the {success, quote} envelope.
            const transformedQuote = this._transformQuoteFromAPI(quote);

            const sig = transformedQuote.signature;
            const orderData = transformedQuote.order;
            if (!sig || !orderData) {
                return Result.fail("Invalid firm quote: missing 'signature' or 'order' field.");
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
                    orderData.takerAmount,
                ];

                // MainnetRFQ requires msg.value == takerAmount for native
                // sells (takerAsset == zero address), 0 otherwise. Pass the
                // same value to estimateGas so the estimator sees the call
                // shape the contract will validate.
                const msgValue = this._computeMsgValue(orderData);

                return await this.withRpcFailover(chainName, async (provider) => {
                    const contract = this._contractForSigner(
                        provider,
                        rfqDep.address,
                        rfqDep.abi
                    );

                    const gasEst = await contract.simpleSwap.estimateGas(
                        orderTuple,
                        sig,
                        { value: msgValue }
                    );
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * SWAP_GAS_BUFFER));

                    const tx: TransactionResponse = await contract.simpleSwap(
                        orderTuple,
                        sig,
                        { value: msgValue, gasLimit }
                    );

                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            const detailParts: string[] = [`tx=${tx.hash}`];
                            if (receipt?.blockNumber != null) {
                                detailParts.push(`block=${receipt.blockNumber}`);
                            }
                            const reason = await this._extractRevertReason(provider, tx, receipt);
                            if (reason) {
                                detailParts.push(`reason=${reason}`);
                            }
                            return Result.fail(`Transaction reverted: ${detailParts.join(', ')}`);
                        }
                        return Result.ok({ txHash: receipt.hash, operation: 'execute_rfq_swap' });
                    }

                    return Result.ok({ txHash: tx.hash, operation: 'execute_rfq_swap' });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'executing swap'));
            }
        }
}
