import { Interface, TransactionResponse } from 'ethers';
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

/**
 * The RFQ API serves firm quotes from several maker contracts (the legacy
 * MainnetRFQ plus DexalotRFQ instances), all reachable through DexalotRouter,
 * which `MainnetRFQ.trustedForwarder()` points at. Each maker has its own
 * EIP-712 domain and swap signer, so a quote is only valid on `order.maker`
 * (called directly, or via the router which forwards the call to it). The
 * deployments endpoint publishes the legacy MainnetRFQ and the DexalotRouter
 * but not the individual makers, so the allow-list is read on-chain with
 * these ABI fragments (and the router too, when the backend does not
 * publish it).
 */
const RFQ_TRUSTED_FORWARDER_ABI = ['function trustedForwarder() view returns (address)'];
const ROUTER_ALLOWED_RFQS_ABI = ['function getAllowedRFQs() view returns (address[])'];
/**
 * simpleSwap((uint256,uint128,address,address,address,address,uint256,uint256),bytes)
 * is shared by MainnetRFQ, DexalotRFQ and the router's forwarding fallback.
 */
const SIMPLE_SWAP_ABI = [
    'function simpleSwap((uint256 nonceAndMeta, uint128 expiry, address makerAsset, address takerAsset, address maker, address taker, uint256 makerAmount, uint256 takerAmount) _order, bytes _signature) payable',
];
const ERC20_ALLOWANCE_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 value) returns (bool)',
];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Router address and lowercase maker addresses it forwards to. */
export interface RfqTargets {
    router: string | null;
    allowed: Set<string>;
}

export interface RfqSwapResult {
    txHash: string;
    operation: string;
    /** Contract `simpleSwap` was sent to: the router (`tx.to`) or `order.maker`. */
    target: string;
    maker: string;
}

export interface RfqApprovalResult {
    approved: boolean;
    txHash?: string;
    amount?: bigint;
    allowance?: bigint;
    spender: string;
    token: string;
    operation: string;
}

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
        ): Promise<Result<RfqSwapResult>> {
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

            // The deployments (legacy) contract only anchors router/maker
            // discovery; it is never the execution target.
            const rfqDep = this._mainnetRfqDeployment(chainName);
            if (!rfqDep) {
                const available = Object.keys(this.deployments['MainnetRFQ'] || {}).join(', ');
                return Result.fail(
                    `RFQ contract not found for '${chainName}'. Available: ${available || 'none'}`
                );
            }

            const targetRes = await this._resolveRfqExecutionTarget(
                chainName,
                rfqDep.address,
                transformedQuote,
                orderData
            );
            if (!targetRes.success || !targetRes.data) {
                return Result.fail(targetRes.error || 'Could not resolve RFQ execution target.');
            }
            const target = targetRes.data;
            const maker = String(orderData.maker);
            const context = this._rfqErrorContext(transformedQuote, orderData, target);

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

                const envelopeError = this._checkTxEnvelope(transformedQuote, orderTuple, sig, msgValue);
                if (envelopeError) {
                    return Result.fail(`${envelopeError} [${context}]`);
                }

                // ERC20 sells: the maker contract pulls funds with transferFrom,
                // so the allowance must be granted to order.maker (not the
                // router and not the legacy MainnetRFQ). Fail here with a clear
                // message instead of letting the contract revert.
                const takerAsset = String(orderData.takerAsset ?? '');
                if (takerAsset.toLowerCase() !== NATIVE_ZERO_ADDRESS) {
                    const needed = this._orderFieldToBigInt(orderData.takerAmount);
                    const owner = await this.signer.getAddress();
                    const allowance = await this._getErc20Allowance(chainName, takerAsset, owner, maker);
                    if (allowance < needed) {
                        return Result.fail(
                            `Insufficient allowance: RFQ maker ${maker} may spend ${allowance} of ` +
                                `${takerAsset}, swap needs ${needed}. Call approveRfqMaker(quote) first ` +
                                `(approvals are per maker contract) [${context}]`
                        );
                    }
                }

                return await this.withRpcFailover(chainName, async (provider) => {
                    const contract = this._contractForSigner(provider, target, SIMPLE_SWAP_ABI);

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
                        const failure = await this._describeReceiptFailure(provider, tx, receipt);
                        if (failure) {
                            return Result.fail(`${failure} [${context}]`);
                        }
                        return Result.ok({
                            txHash: receipt!.hash,
                            operation: 'execute_rfq_swap',
                            target,
                            maker,
                        });
                    }

                    return Result.ok({ txHash: tx.hash, operation: 'execute_rfq_swap', target, maker });
                });
            } catch (e) {
                return Result.fail(`${this._sanitizeError(e, 'executing swap')} [${context}]`);
            }
        }

        /**
         * Grant the quote's maker contract an ERC20 allowance for the taker asset.
         *
         * Firm quotes are served by several maker contracts and each one pulls
         * the taker asset with `transferFrom` itself, so the allowance has to
         * be granted to `order.maker` — approving the router or the legacy
         * MainnetRFQ address does nothing for a quote from another maker.
         * Call this before `executeRFQSwap` when selling an ERC20 token.
         *
         * The maker is validated against the router's on-chain allow-list
         * before any approval is sent. Native-asset sells need no allowance
         * and are rejected.
         *
         * @param quote Firm quote (or its `{success, quote}` envelope).
         * @param amountWei Allowance to grant in base units; defaults to the
         *   quote's `takerAmount`.
         * @param waitForReceipt Block until the approval is mined.
         * @returns `approved=false` with the current `allowance` when nothing
         *   had to be sent, or `approved=true` with the approval `txHash`.
         */
        public async approveRfqMaker(
            quote: any,
            amountWei?: bigint,
            waitForReceipt: boolean = true
        ): Promise<Result<RfqApprovalResult>> {
            if (!this.signer) {
                return Result.fail('Signer required');
            }

            const transformedQuote = this._transformQuoteFromAPI(quote);
            const orderData = transformedQuote.order;
            if (!orderData) {
                return Result.fail("Invalid firm quote: missing 'order' field.");
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

            const takerAsset = String(orderData.takerAsset ?? '');
            if (!takerAsset) {
                return Result.fail("Invalid firm quote: missing 'order.takerAsset' field.");
            }
            if (takerAsset.toLowerCase() === NATIVE_ZERO_ADDRESS) {
                return Result.fail(
                    'Native taker asset does not need an allowance; executeRFQSwap sends it as msg.value.'
                );
            }

            const targetRes = await this._resolveRfqExecutionTarget(
                chainName,
                rfqDep.address,
                transformedQuote,
                orderData
            );
            if (!targetRes.success || !targetRes.data) {
                return Result.fail(targetRes.error || 'Could not resolve RFQ execution target.');
            }
            const maker = String(orderData.maker);
            const needed = amountWei ?? this._orderFieldToBigInt(orderData.takerAmount);
            if (needed <= 0n) {
                return Result.fail('Approval amount must be positive.');
            }
            const context = this._rfqErrorContext(transformedQuote, orderData, maker);

            try {
                const owner = await this.signer.getAddress();
                const allowance = await this._getErc20Allowance(chainName, takerAsset, owner, maker);
                if (allowance >= needed) {
                    return Result.ok({
                        approved: false,
                        allowance,
                        spender: maker,
                        token: takerAsset,
                        operation: 'approve_rfq_maker',
                    });
                }

                return await this.withRpcFailover(chainName, async (provider) => {
                    const token = this._contractForSigner(provider, takerAsset, ERC20_ALLOWANCE_ABI);
                    const gasEst = await token.approve.estimateGas(maker, needed);
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * SWAP_GAS_BUFFER));
                    const tx: TransactionResponse = await token.approve(maker, needed, { gasLimit });

                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        const failure = await this._describeReceiptFailure(provider, tx, receipt);
                        if (failure) {
                            return Result.fail(`${failure} [${context}]`);
                        }
                    }
                    return Result.ok({
                        approved: true,
                        txHash: tx.hash,
                        amount: needed,
                        spender: maker,
                        token: takerAsset,
                        operation: 'approve_rfq_maker',
                    });
                });
            } catch (e) {
                return Result.fail(`${this._sanitizeError(e, 'approving RFQ maker')} [${context}]`);
            }
        }

        // ------------------------------------------------------------------
        // RFQ execution-target discovery and validation
        // ------------------------------------------------------------------

        /**
         * Discover the RFQ router and the maker contracts it forwards to.
         *
         * The router address comes from the deployments endpoint
         * (`DexalotRouter` for the chain) when the backend publishes it, and
         * otherwise from `trustedForwarder()` on the deployments (legacy
         * MainnetRFQ) contract. The allowed makers always come from
         * `getAllowedRFQs()` on that router — the API does not list them and
         * the router's own allow-list is what it enforces. The deployments
         * address is always part of the allowed set.
         *
         * Cached in the static tier (1h) per API base URL and deployment
         * address. Lookup failures are not cached and degrade to
         * `{ router: null, allowed: {deployment} }` — the legacy behaviour —
         * so a quote from another maker is refused rather than sent to the
         * wrong contract.
         */
        protected async _getRfqTargets(chainName: string, deploymentAddress: string): Promise<RfqTargets> {
            const deployment = deploymentAddress.toLowerCase();
            const cacheKey = `rfq_targets:${this.apiBaseUrl}:${deployment}`;
            if (this._cacheEnabled) {
                const cached = this._staticCache.get<RfqTargets>(cacheKey);
                if (cached) return cached;
            }

            const allowed = new Set<string>([deployment]);
            let router: string | null = null;
            try {
                let routerAddr: string | null = this._dexalotRouterDeployment(chainName)?.address ?? null;
                if (!routerAddr) {
                    const forwarder = await this.withRpcFailover(chainName, async (provider) =>
                        this._contractReadOnly(provider, deploymentAddress, RFQ_TRUSTED_FORWARDER_ABI).trustedForwarder()
                    );
                    if (forwarder && String(forwarder).toLowerCase() !== NATIVE_ZERO_ADDRESS) {
                        routerAddr = String(forwarder);
                    }
                }
                if (routerAddr) {
                    const routerAddress = routerAddr;
                    const makers = await this.withRpcFailover(chainName, async (provider) =>
                        this._contractReadOnly(provider, routerAddress, ROUTER_ALLOWED_RFQS_ABI).getAllowedRFQs()
                    );
                    for (const m of Array.from(makers as Iterable<unknown>)) {
                        allowed.add(String(m).toLowerCase());
                    }
                    router = routerAddress;
                }
            } catch (e) {
                this._logger.warn(
                    `Could not resolve RFQ router/allowed makers via ${deploymentAddress}; ` +
                        'only the deployments address will be accepted as maker',
                    { error: this._sanitizeError(e, 'resolving RFQ targets') }
                );
                return { router: null, allowed: new Set<string>([deployment]) };
            }

            const result: RfqTargets = { router, allowed };
            if (this._cacheEnabled) {
                this._staticCache.set(cacheKey, result);
            }
            return result;
        }

        /**
         * Pick and validate the contract `simpleSwap` must be sent to.
         *
         * `order.maker` must be on the router's allow-list (or be the
         * deployments address). If the quote carries `tx.to` it must be the
         * router or the maker; it is then used as the target so the call
         * follows the API's own routing. Otherwise the maker is called directly.
         */
        protected async _resolveRfqExecutionTarget(
            chainName: string,
            deploymentAddress: string,
            quote: any,
            orderData: any
        ): Promise<Result<string>> {
            const makerRaw = orderData.maker;
            if (!makerRaw) {
                return Result.fail("Invalid firm quote: missing 'order.maker' field.");
            }
            const maker = String(makerRaw);
            if (!ADDRESS_RE.test(maker)) {
                return Result.fail(`Invalid firm quote: 'order.maker' is not an address: ${maker}`);
            }

            const { router, allowed } = await this._getRfqTargets(chainName, deploymentAddress);
            if (!allowed.has(maker.toLowerCase())) {
                return Result.fail(
                    `Firm quote maker ${maker} is not an allowed RFQ contract ` +
                        `(router=${router ?? 'unknown'}); refusing to execute`
                );
            }

            const txMeta = quote?.tx && typeof quote.tx === 'object' ? quote.tx : null;
            const txTo = txMeta?.to;
            if (!txTo) {
                return Result.ok(maker);
            }
            const txToStr = String(txTo);
            if (!ADDRESS_RE.test(txToStr)) {
                return Result.fail(`Invalid firm quote: 'tx.to' is not an address: ${txToStr}`);
            }
            const permitted = new Set<string>([maker.toLowerCase()]);
            if (router) permitted.add(router.toLowerCase());
            if (!permitted.has(txToStr.toLowerCase())) {
                return Result.fail(
                    `Firm quote tx.to ${txToStr} is neither the RFQ router nor the order maker ` +
                        `${maker}; refusing to execute`
                );
            }
            return Result.ok(txToStr);
        }

        /**
         * Cross-check the API's `tx` envelope against the call the SDK encodes.
         * The SDK always builds the calldata itself; the envelope is only used
         * to detect disagreement. Returns an error message when `tx.data` or
         * `tx.value` are present and differ, `null` otherwise.
         */
        protected _checkTxEnvelope(quote: any, orderTuple: unknown[], sig: string, msgValue: bigint): string | null {
            const txMeta = quote?.tx && typeof quote.tx === 'object' ? quote.tx : {};
            if (txMeta.data) {
                const expected = this._encodeSimpleSwap(orderTuple, sig);
                if (String(txMeta.data).toLowerCase() !== expected.toLowerCase()) {
                    return 'Firm quote tx.data does not match the SDK-encoded simpleSwap call; refusing to execute';
                }
            }
            if (txMeta.value !== undefined && txMeta.value !== null && txMeta.value !== '') {
                if (this._orderFieldToBigInt(txMeta.value) !== msgValue) {
                    return (
                        `Firm quote tx.value ${txMeta.value} does not match the computed msg.value ` +
                        `${msgValue}; refusing to execute`
                    );
                }
            }
            return null;
        }

        /** ABI-encode `simpleSwap(order, signature)` calldata. */
        protected _encodeSimpleSwap(orderTuple: unknown[], sig: string): string {
            return String(new Interface(SIMPLE_SWAP_ABI).encodeFunctionData('simpleSwap', [orderTuple, sig]));
        }

        /** `allowance(owner, spender)` of an ERC20 token in base units. */
        protected async _getErc20Allowance(
            chainName: string,
            token: string,
            owner: string,
            spender: string
        ): Promise<bigint> {
            const raw = await this.withRpcFailover(chainName, async (provider) =>
                this._contractReadOnly(provider, token, ERC20_ALLOWANCE_ABI).allowance(owner, spender)
            );
            return BigInt(raw);
        }

        /** Compact `key=value` trail appended to swap errors for diagnosis. */
        protected _rfqErrorContext(quote: any, orderData: any, target: string): string {
            const parts = [`target=${target}`, `maker=${orderData?.maker}`];
            if (quote?.quoteId) parts.push(`quoteId=${quote.quoteId}`);
            const nonceAndMeta = orderData?.nonceAndMeta;
            if (nonceAndMeta !== undefined && nonceAndMeta !== null && nonceAndMeta !== '') {
                parts.push(`nonceAndMeta=${nonceAndMeta}`);
            }
            const expiry = orderData?.expiry;
            if (expiry !== undefined && expiry !== null && expiry !== '') {
                parts.push(`expiry=${expiry}`);
            }
            return parts.join(', ');
        }

        /** `Transaction reverted: ...` message for a failed receipt, or `null` on success. */
        protected async _describeReceiptFailure(provider: any, tx: any, receipt: any): Promise<string | null> {
            if (receipt && receipt.status === 1) {
                return null;
            }
            const detailParts: string[] = [`tx=${tx.hash}`];
            if (receipt?.blockNumber != null) {
                detailParts.push(`block=${receipt.blockNumber}`);
            }
            const reason = await this._extractRevertReason(provider, tx, receipt);
            if (reason) {
                detailParts.push(`reason=${reason}`);
            }
            return `Transaction reverted: ${detailParts.join(', ')}`;
        }
}
