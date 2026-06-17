import { Contract, ethers, TransactionResponse, toBigInt } from 'ethers';
import { Utils } from '../utils/index.js';
import { OrderRequest, Pair, OrderBook, Order, Candle, MarketSnapshot } from '../types/index.js';
import { ENDPOINTS, ENV, DEFAULTS, wsApiUrlForRestBase } from '../constants.js';
import { normalizeTradingPair } from '../utils/tokenNormalization.js';

/**
 * Allowed candle bar sizes for `getCandles`. Each maps to the
 * (intervalnum, intervalstr) tuple the backend expects.
 */
const CANDLE_INTERVALS: Record<string, { num: number; str: string }> = {
    '1m': { num: 1, str: 'minute' },
    '5m': { num: 5, str: 'minute' },
    '15m': { num: 15, str: 'minute' },
    '30m': { num: 30, str: 'minute' },
    '1h': { num: 1, str: 'hour' },
    '4h': { num: 4, str: 'hour' },
    '1d': { num: 1, str: 'day' },
};
const CANDLE_LIMIT_MAX = 500;
import { WebSocketManager } from '../utils/websocketManager.js';
import { BaseClient } from './base.js';
import { Result } from '../utils/result.js';
import { withInstanceCache } from '../utils/cache.js';
import {
    SIDE_NAMES,
    ORDER_TYPE_NAMES,
    TIME_IN_FORCE_NAMES,
    ORDER_STATUS_NAMES,
    enumIntToName,
    parseOrderType,
    parseTimeInForce,
    parseStp,
    validateOrderCombo,
} from './orderTypes.js';
import {
    Big,
    toWei,
    fromWei,
    checkDisplayPrecision,
    checkTradeAmountBounds,
} from '../utils/decimal.js';
import {
    validatePairFormat,
    validateOrderParams,
    validateOrderIdFormat,
    validatePositiveNumber
} from '../utils/inputValidators.js';

export class CLOBClient extends BaseClient {

        public _cachedSignature: string | null = null;

        /**
         * Transform API pair response to match standardized field names.
         * Maps lowercase/camelCase API fields to snake_case SDK fields.
         * Preserves existing snake_case fields if present, otherwise transforms from alternative formats.
         */
        private _transformPairFromAPI(item: any): any {
            const transformed: any = { ...item };
            
            // Transform base_decimals: prefer existing snake_case, fallback to variations
            if (transformed.base_decimals === undefined) {
                transformed.base_decimals = item.base_evmdecimals ?? item.baseEvmDecimals ?? item.base_evm_decimals;
            }
            
            // Transform quote_decimals: prefer existing snake_case, fallback to variations
            if (transformed.quote_decimals === undefined) {
                transformed.quote_decimals = item.quote_evmdecimals ?? item.quoteEvmDecimals ?? item.quote_evm_decimals;
            }
            
            // Transform base_display_decimals: prefer existing snake_case, fallback to variations
            if (transformed.base_display_decimals === undefined) {
                transformed.base_display_decimals = item.base_display_decimals ?? item.basedisplaydecimals ?? item.baseDisplayDecimals;
            }
            
            // Transform quote_display_decimals: prefer existing snake_case, fallback to variations
            if (transformed.quote_display_decimals === undefined) {
                transformed.quote_display_decimals = item.quote_display_decimals ?? item.quotedisplaydecimals ?? item.quoteDisplayDecimals;
            }
            
            // Transform min_trade_amount: prefer existing snake_case, fallback to variations
            if (transformed.min_trade_amount === undefined) {
                transformed.min_trade_amount = item.min_trade_amount ?? item.mintrade_amnt ?? item.minTradeAmnt;
            }
            
            // Transform max_trade_amount: prefer existing snake_case, fallback to variations
            if (transformed.max_trade_amount === undefined) {
                transformed.max_trade_amount = item.max_trade_amount ?? item.maxtrade_amnt ?? item.maxTradeAmnt;
            }
            
            return transformed;
        }

        private _coerceOrderNumeric(value: unknown, fieldName: string): number {
            if (value === null || value === undefined || value === '') {
                return 0;
            }
            if (typeof value === 'number') {
                if (!Number.isFinite(value)) {
                    throw new Error(`Order field '${fieldName}' must be numeric.`);
                }
                return value;
            }
            if (typeof value === 'bigint') {
                return Number(value);
            }
            if (typeof value === 'string') {
                const raw = value.trim();
                if (!raw) {
                    return 0;
                }
                const parsed = Number(raw);
                if (!Number.isFinite(parsed)) {
                    throw new Error(`Order field '${fieldName}' must be numeric.`);
                }
                return parsed;
            }
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) {
                throw new Error(`Order field '${fieldName}' must be numeric.`);
            }
            return parsed;
        }

        private _coerceOrderBlock(value: unknown, fieldName: string): number {
            if (value === null || value === undefined) {
                throw new Error(`Order missing required '${fieldName}' field.`);
            }
            if (typeof value === 'boolean') {
                throw new Error(`Order field '${fieldName}' must be an integer block number.`);
            }
            if (typeof value === 'number') {
                if (!Number.isInteger(value)) {
                    throw new Error(`Order field '${fieldName}' must be an integer block number.`);
                }
                return value;
            }
            if (typeof value === 'bigint') {
                return Number(value);
            }
            if (typeof value === 'string') {
                const raw = value.trim();
                if (!raw) {
                    throw new Error(`Order missing required '${fieldName}' field.`);
                }
                const parsed = Number.parseInt(raw, raw.startsWith('0x') ? 16 : 10);
                if (!Number.isInteger(parsed)) {
                    throw new Error(`Order field '${fieldName}' must be an integer block number.`);
                }
                return parsed;
            }
            const parsed = Number(value);
            if (!Number.isInteger(parsed)) {
                throw new Error(`Order field '${fieldName}' must be an integer block number.`);
            }
            return parsed;
        }

        private _coerceOptionalOrderBlock(value: unknown, fieldName: string): number | null {
            if (value === null || value === undefined) {
                return null;
            }
            if (typeof value === 'string' && !value.trim()) {
                return null;
            }
            return this._coerceOrderBlock(value, fieldName);
        }

        private _enumToName(value: unknown, mapping: Record<number, string>): unknown {
            // Delegates to the shared order-type model so read and write paths
            // share one mapping; unknown integers become an explicit
            // "UNKNOWN(<n>)" sentinel rather than a fabricated label.
            return enumIntToName(value, mapping);
        }

        /**
         * Resolve and validate (timeInForce, stp) for an order. Returns the
         * integer type2/stp values or a failure describing the invalid
         * modifier / combination. Shared by every write path so the order-type
         * matrix is enforced uniformly. Defaults preserve prior behavior
         * (GTC / CANCEL_TAKER).
         */
        private _resolveOrderModifiers(
            type1Enum: number,
            timeInForce: unknown,
            stp: unknown,
            hasPrice: boolean
        ): Result<{ type2: number; stp: number }> {
            const tif = parseTimeInForce(timeInForce ?? 'GTC');
            if (!tif.success) {
                return Result.fail(tif.error!);
            }
            const stpRes = parseStp(stp ?? 'CANCEL_TAKER');
            if (!stpRes.success) {
                return Result.fail(stpRes.error!);
            }
            const combo = validateOrderCombo(type1Enum, tif.data!, hasPrice);
            if (!combo.success) {
                return Result.fail(combo.error!);
            }
            return Result.ok({ type2: tif.data!, stp: stpRes.data! });
        }

        private _toHexIdentifier(value: unknown): string {
            if (typeof value === 'string') {
                return value;
            }
            if (value instanceof Uint8Array) {
                return ethers.hexlify(value);
            }
            if (typeof value === 'bigint') {
                return ethers.toBeHex(value, 32);
            }
            return this._slotToBytes32Hex(value);
        }

        private _findPairInfoByTradePairId(tradePairId: string | undefined): Pair | undefined {
            if (!tradePairId) {
                return undefined;
            }
            return Object.values(this.pairs).find(
                (pair) => DataHexString(String(pair.tradePairId)) === DataHexString(String(tradePairId))
            );
        }

        private _resolvePairFromOrder(order: any): string | undefined {
            const pair = order.pair ?? order.tradePair ?? order.trade_pair;
            return typeof pair === 'string' ? pair : undefined;
        }

        private _resolveTradePairIdFromPair(pair: string | undefined): string | undefined {
            if (!pair) {
                return undefined;
            }
            const pairData = this.pairs[pair];
            return pairData ? this._toHexIdentifier(pairData.tradePairId) : undefined;
        }

        private _buildCanonicalOrder(params: {
            internalOrderId: string;
            clientOrderId: string;
            tradePairId: string;
            pair: string;
            price: number;
            totalAmount: number;
            quantity: number;
            quantityFilled: number;
            totalFee: number;
            traderAddress: string;
            side: string;
            type1: string;
            type2: string;
            status: string;
            updateBlock: number | null;
            createBlock: number | null;
            createTs?: string | null;
            updateTs?: string | null;
            tx?: string | null;
        }): Order {
            return {
                internalOrderId: params.internalOrderId,
                clientOrderId: params.clientOrderId,
                tradePairId: params.tradePairId,
                pair: params.pair,
                price: params.price,
                totalAmount: params.totalAmount,
                quantity: params.quantity,
                quantityFilled: params.quantityFilled,
                totalFee: params.totalFee,
                traderAddress: params.traderAddress,
                side: params.side,
                type1: params.type1,
                type2: params.type2,
                status: params.status,
                updateBlock: params.updateBlock,
                createBlock: params.createBlock,
                createTs: params.createTs ?? null,
                updateTs: params.updateTs ?? null,
                tx: params.tx ?? null,
            };
        }

        /**
         * Fetch and store trading pair metadata.
         * Cached for 15 minutes (semi-static data).
         * Returns the list of pair data objects.
         */
        public async getClobPairs(): Promise<Result<Pair[]>> {
            const cachedFn = withInstanceCache(
                this,
                this._semiStaticCache,
                'getClobPairs',
                async (): Promise<Result<Pair[]>> => {
                    try {
                        const data = await this._apiCall<any[]>('get', ENDPOINTS.TRADING_PAIRS);

                        // Transform pairs before processing
                        const transformedData = data.map(item => this._transformPairFromAPI(item));
                        const pairList: Pair[] = [];

                        for (const item of transformedData) {
                            const isSubnetEnv = item.env === this.subnetEnv ||
                                                item.env === ENV.PROD_MULTI_SUBNET ||
                                                item.env === ENV.FUJI_MULTI_SUBNET;

                            if (isSubnetEnv) {
                                const pairName = item.pair;
                                // Display decimals are contractual: the trading contract
                                // enforces them and a wrong client-side default produces
                                // a T-TMDQ-01 rejection. If the API omits them, drop the
                                // pair with a warning rather than silently substitute 18.
                                // Note: 0 is a valid value — use null/undefined check.
                                if (item.base_display_decimals == null || item.quote_display_decimals == null) {
                                    this._logger.warn(
                                        `Pair ${pairName} dropped at ingest: missing display decimals`,
                                        {
                                            pair: pairName,
                                            base_display_decimals: item.base_display_decimals,
                                            quote_display_decimals: item.quote_display_decimals,
                                        }
                                    );
                                    continue;
                                }
                                const pairData: Pair = {
                                    pair: pairName,
                                    base: item.base,
                                    quote: item.quote,
                                    base_decimals: item.base_decimals,
                                    quote_decimals: item.quote_decimals,
                                    base_display_decimals: item.base_display_decimals,
                                    quote_display_decimals: item.quote_display_decimals,
                                    min_trade_amount: parseFloat(String(item.min_trade_amount || 0)),
                                    max_trade_amount: parseFloat(String(item.max_trade_amount || 0)),
                                    tradePairId: Utils.toBytes32(pairName),
                                };
                                this.pairs[pairName] = pairData;
                                pairList.push(pairData);
                            }
                        }
                        return Result.ok(pairList);
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, 'fetching pairs'));
                    }
                }
            );
            return cachedFn();
        }

        public _ensurePairExists(pair: string): boolean {
            return !!this.pairs[pair];
        }

        /**
         * Validate and quantize an order's price/amount against the pair's
         * display decimals and min/max trade-amount bounds.
         *
         * Inputs whose precision exceeds the pair's display decimals are
         * rejected — the SDK does not silently round, because that would
         * silently slip orders (e.g. a stop at 99.99 quietly becoming 99.9).
         * Float-representation noise (residual <= 1e-10) is tolerated and
         * snapped to the nearest displayable value.
         *
         * After the display-precision check, the resulting notional
         * (`price * amount`) is checked against the pair's bounds (quote-
         * token denominated) so the SDK fails fast instead of waiting for
         * the contract to reject.
         *
         * @param price Order price (null or 0 skips the price-side checks)
         * @param amount Order amount (always validated)
         * @param pairData Resolved pair metadata
         */
        protected _normalizeOrderAmounts(
            price: number | string | Big | null | undefined,
            amount: number | string | Big,
            pairData: Pair
        ): Result<{ price: Big | null; amount: Big }> {
            let normalizedPrice: Big | null = null;
            if (price !== null && price !== undefined && price !== 0 && price !== '0' && price !== '') {
                const priceRes = checkDisplayPrecision(
                    price,
                    pairData.quote_display_decimals,
                    'price'
                );
                if (!priceRes.success) return Result.fail(priceRes.error!);
                normalizedPrice = priceRes.data!;
            }

            const amountRes = checkDisplayPrecision(
                amount,
                pairData.base_display_decimals,
                'amount'
            );
            if (!amountRes.success) return Result.fail(amountRes.error!);
            const normalizedAmount = amountRes.data!;

            const boundsRes = checkTradeAmountBounds(
                normalizedPrice,
                normalizedAmount,
                pairData.min_trade_amount,
                pairData.max_trade_amount,
                pairData.pair
            );
            if (!boundsRes.success) return Result.fail(boundsRes.error!);

            return Result.ok({ price: normalizedPrice, amount: normalizedAmount });
        }

        /** Fetch CLOB pairs if needed, then verify the pair exists. */
        public async _ensurePairExistsAsync(pair: string): Promise<boolean> {
            if (this._ensurePairExists(pair)) return true;
            const r = await this.getClobPairs();
            return r.success && !!this.pairs[pair];
        }

        /** Run an operation against TradePairs on the subnet RPC with provider failover. */
        private async _withL1TradePairsContract<T>(fn: (contract: Contract) => Promise<T>): Promise<T> {
            const d = this._tradePairsDeployment();
            if (!d) {
                throw new Error('TradePairs contract not initialized.');
            }
            return this.withRpcFailover(this._dexalotL1DisplayName(), (p) =>
                fn(this._contractForSigner(p, d.address, d.abi))
            );
        }

        /** Normalize an order id argument to 32-byte `0x` hex for contract calls. */
        private _orderIdToBytes32Hex(orderId: string | Uint8Array): string {
            if (orderId instanceof Uint8Array) {
                const b = new Uint8Array(32);
                const len = orderId.length;
                if (len <= 32) {
                    b.set(orderId, 32 - len);
                } else {
                    b.set(orderId.slice(len - 32));
                }
                return ethers.hexlify(b);
            }
            const stripped = orderId.trim();
            if (/^0x/i.test(stripped)) {
                const hexStr = stripped.slice(2).toLowerCase();
                if (hexStr.length % 2 !== 0) {
                    throw new Error('Hex order IDs must have an even number of characters.');
                }
                const buf = ethers.getBytes(('0x' + hexStr) as `0x${string}`);
                return ethers.zeroPadValue(ethers.hexlify(buf), 32);
            }
            if (/^\d+$/.test(stripped)) {
                return ethers.toBeHex(BigInt(stripped), 32);
            }
            if (stripped.length === 64 && /^[0-9a-fA-F]+$/.test(stripped)) {
                return ethers.zeroPadValue(('0x' + stripped) as `0x${string}`, 32);
            }
            const enc = new TextEncoder().encode(stripped);
            if (enc.length > 32) {
                throw new Error('Plain-string order IDs must fit in 32 bytes.');
            }
            const paddedArr = new Uint8Array(32);
            paddedArr.set(enc);
            return ethers.hexlify(paddedArr);
        }

        private _classifyOrderIdInput(orderId: string | Uint8Array): 'internal' | 'ambiguous' | 'client' {
            if (orderId instanceof Uint8Array) {
                return 'ambiguous';
            }
            const s = orderId.trim();
            if (/^0x/i.test(s)) {
                return 'ambiguous';
            }
            if (/^\d+$/.test(s)) {
                return 'internal';
            }
            if (s.length === 64 && /^[0-9a-fA-F]+$/.test(s)) {
                return 'ambiguous';
            }
            return 'client';
        }

        private _buildOrderResolutionSequence(orderId: string | Uint8Array): Array<'internal' | 'client'> {
            const kind = this._classifyOrderIdInput(orderId);
            if (kind === 'client') {
                return ['client'];
            }
            return ['internal', 'client'];
        }

        private _isEmptyOrderData(orderData: unknown[]): boolean {
            if (!Array.isArray(orderData) || orderData.length === 0) {
                return true;
            }
            const NULL_BYTES32 =
                '0x0000000000000000000000000000000000000000000000000000000000000000';
            return DataHexString(String(orderData[0])) === DataHexString(NULL_BYTES32);
        }

        private async _fetchOrderByInternalId(
            contract: Contract,
            inputBytes32: string
        ): Promise<unknown[] | null> {
            const raw = await contract.getOrder(inputBytes32);
            const orderData = raw as unknown[];
            if (!Array.isArray(orderData)) {
                return null;
            }
            return this._isEmptyOrderData(orderData) ? null : orderData;
        }

        private async _fetchOrderByClientIdPath(
            contract: Contract,
            inputBytes32: string
        ): Promise<unknown[] | null> {
            const address = await this.signer!.getAddress();
            let raw = await contract.getOrderByClientOrderId(address, inputBytes32);
            let orderData = raw as unknown[];
            if (Array.isArray(orderData) && !this._isEmptyOrderData(orderData)) {
                return orderData;
            }
            const c = contract as Contract & {
                getOrderByClientId?: (owner: string, clientId: string) => Promise<unknown[]>;
            };
            if (typeof c.getOrderByClientId === 'function') {
                raw = await c.getOrderByClientId(address, inputBytes32);
                orderData = raw as unknown[];
                if (Array.isArray(orderData) && !this._isEmptyOrderData(orderData)) {
                    return orderData;
                }
            }
            return null;
        }

        private async _resolveOrderReference(
            contract: Contract,
            orderId: string | Uint8Array
        ): Promise<Result<{ idType: 'internal' | 'client'; orderData: unknown[] }>> {
            let inputBytes32: string;
            try {
                inputBytes32 = this._orderIdToBytes32Hex(orderId);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return Result.fail(msg);
            }
            const attempts = this._buildOrderResolutionSequence(orderId);
            const errors: string[] = [];
            for (const attempt of attempts) {
                try {
                    const orderData =
                        attempt === 'internal'
                            ? await this._fetchOrderByInternalId(contract, inputBytes32)
                            : await this._fetchOrderByClientIdPath(contract, inputBytes32);
                    if (orderData) {
                        return Result.ok({ idType: attempt, orderData });
                    }
                } catch (err: unknown) {
                    errors.push(err instanceof Error ? err.message : String(err));
                }
            }
            if (errors.length > 0) {
                return Result.fail(errors[0]!);
            }
            return Result.fail('Order not found (checked supported ID paths).');
        }

        private _slotToBytes32Hex(slot: unknown): string {
            if (typeof slot === 'string' && slot.startsWith('0x')) {
                return ethers.zeroPadValue(slot as `0x${string}`, 32);
            }
            if (typeof slot === 'bigint') {
                return ethers.toBeHex(slot, 32);
            }
            return ethers.zeroPadValue(ethers.hexlify(slot as Uint8Array), 32);
        }

        private _getOrCreateWsManager(): WebSocketManager | null {
            if (!this.config.wsManagerEnabled) {
                return null;
            }
            if (!this._wsManager) {
                this._wsManager = new WebSocketManager(
                    wsApiUrlForRestBase(this.apiBaseUrl),
                    {
                        pingInterval: this.config.wsPingInterval,
                        pingTimeout: this.config.wsPingTimeout,
                        reconnectInitialDelay: this.config.wsReconnectInitialDelay,
                        reconnectMaxDelay: this.config.wsReconnectMaxDelay,
                        reconnectExponentialBase: this.config.wsReconnectExponentialBase,
                        reconnectMaxAttempts: this.config.wsReconnectMaxAttempts,
                    },
                    {
                        wsTimeOffsetMs: this.config.wsTimeOffsetMs,
                        auth: this.signer
                            ? {
                                  getAddress: () => this.signer!.getAddress(),
                                  signMessage: (m: string) => this.signer!.signMessage(m),
                              }
                            : undefined,
                    }
                );
            }
            return this._wsManager;
        }

        /**
         * Subscribe to WebSocket events. Requires wsManagerEnabled in config.
         */
        public async subscribeToEvents(
            topic: string,
            callback: (data: unknown) => void,
            isPrivate: boolean = false
        ): Promise<void> {
            if (!this.config.wsManagerEnabled) {
                throw new Error('WebSocket Manager is disabled. Set wsManagerEnabled=true in config.');
            }
            const manager = this._getOrCreateWsManager();
            if (!manager) {
                throw new Error('WebSocket manager unavailable.');
            }

            let orderbookPair: string | null = null;
            if (!isPrivate) {
                if (topic.startsWith('OrderBook/')) {
                    orderbookPair = topic.slice('OrderBook/'.length);
                } else if (topic.includes('/') && topic.split('/').length === 2) {
                    orderbookPair = topic;
                }
            }

            if (orderbookPair) {
                const pr = validatePairFormat(orderbookPair, 'pair');
                if (!pr.success) {
                    throw new Error(pr.error || `Invalid trading pair in WebSocket topic: ${orderbookPair}`);
                }
                const normalized = this.normalizePair(orderbookPair);
                if (!(await this._ensurePairExistsAsync(normalized))) {
                    throw new Error(`Trading pair not found for WebSocket: ${normalized}`);
                }
                const pd = this.pairs[normalized] || ({} as Pair);
                const orderbookDecimal = Number(
                    pd.quote_display_decimals ?? pd.base_display_decimals ?? 8
                );
                manager.subscribe(
                    topic,
                    callback as (data: any) => void,
                    isPrivate,
                    { kind: 'orderbook', pair: normalized, decimal: orderbookDecimal }
                );
            } else {
                manager.subscribe(topic, callback as (data: any) => void, isPrivate);
            }

            if (!manager.isConnected) {
                manager.connect();
            }
        }

        public unsubscribeFromEvents(topic: string): void {
            if (this._wsManager) {
                this._wsManager.unsubscribe(topic);
            }
        }

        public async closeWebsocket(graceS: number = 3): Promise<void> {
            if (!this._wsManager) return;
            const mgr = this._wsManager;
            this._wsManager = null;
            mgr.disconnect();
            const ms = Math.max(0, graceS) * 1000;
            if (ms > 0) {
                await new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 100)));
            }
        }

        /**
         * Fetch the most recent OHLCV candles for a CLOB trading pair.
         *
         * Wraps `GET /api/trading/candle-chunk` (count-back endpoint). The
         * backend returns up to `limit` candles ending at the current time,
         * in chronological order. Cached for 1 second (orderbook tier).
         */
        public async getCandles(
            pair: string,
            interval: string,
            limit: number
        ): Promise<Result<Candle[]>> {
            const pairResult = validatePairFormat(pair, 'pair');
            if (!pairResult.success) return Result.fail(pairResult.error!);

            const intervalSpec = CANDLE_INTERVALS[interval];
            if (!intervalSpec) {
                const allowed = Object.keys(CANDLE_INTERVALS).join(', ');
                return Result.fail(`Invalid interval '${interval}'. Allowed: ${allowed}.`);
            }

            if (!Number.isInteger(limit) || limit < 1 || limit > CANDLE_LIMIT_MAX) {
                return Result.fail(
                    `Invalid limit: must be an integer in [1, ${CANDLE_LIMIT_MAX}], got ${limit}.`
                );
            }

            const cachedFn = withInstanceCache(
                this,
                this._orderbookCache,
                'getCandles',
                async (p: string, i: string, l: number): Promise<Result<Candle[]>> => {
                    const normalizedPair = normalizeTradingPair(p);
                    const params = {
                        pair: normalizedPair,
                        intervalnum: intervalSpec.num,
                        intervalstr: intervalSpec.str,
                        count: l,
                    };
                    try {
                        const data = await this._apiCall<any>('get', ENDPOINTS.TRADING_CANDLE_CHUNK, { params });
                        if (!Array.isArray(data)) {
                            return Result.fail(
                                `Unexpected candle response shape: expected list, got ${typeof data}.`
                            );
                        }
                        return Result.ok(data as Candle[]);
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, 'fetching candles'));
                    }
                }
            );
            return cachedFn(pair, interval, limit);
        }

        /**
         * Fetch the global market snapshot for all CLOB pairs.
         *
         * Wraps `GET /api/stats/market-snapshot`. Returns the full envelope
         * (per-pair list with rolling 24h OHLCV, plus exchange-wide totals).
         * Cached for 1 second (orderbook tier).
         */
        public async getMarketSnapshot(): Promise<Result<MarketSnapshot>> {
            const cachedFn = withInstanceCache(
                this,
                this._orderbookCache,
                'getMarketSnapshot',
                async (): Promise<Result<MarketSnapshot>> => {
                    try {
                        const data = await this._apiCall<any>('get', ENDPOINTS.STATS_MARKET_SNAPSHOT);
                        // Backend occasionally returns the literal string "" when
                        // empty; treat that as an empty envelope so callers see
                        // a stable shape.
                        if (typeof data === 'string') {
                            return Result.ok({ market_snapshot: [], totals: {}, last24: {} });
                        }
                        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
                            return Result.fail(
                                `Unexpected market snapshot shape: expected object, got ${Array.isArray(data) ? 'array' : typeof data}.`
                            );
                        }
                        const envelope: MarketSnapshot = {
                            market_snapshot: Array.isArray(data.market_snapshot) ? data.market_snapshot : [],
                            totals: data.totals && typeof data.totals === 'object' ? data.totals : {},
                            last24: data.last24 && typeof data.last24 === 'object' ? data.last24 : {},
                        };
                        return Result.ok(envelope);
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, 'fetching market snapshot'));
                    }
                }
            );
            return cachedFn();
        }

        /**
         * Fetch 24h ticker stats for a single CLOB trading pair.
         *
         * Filters the global market snapshot to the requested pair. Reuses
         * the cached snapshot served by `getMarketSnapshot`, so calling this
         * for many pairs in close succession costs at most one network call.
         */
        public async get24hStats(pair: string): Promise<Result<Candle>> {
            const pairResult = validatePairFormat(pair, 'pair');
            if (!pairResult.success) return Result.fail(pairResult.error!);

            const normalizedPair = normalizeTradingPair(pair);

            const snapshotResult = await this.getMarketSnapshot();
            if (!snapshotResult.success || !snapshotResult.data) {
                return Result.fail(snapshotResult.error || 'Failed to fetch market snapshot.');
            }

            // getMarketSnapshot always returns market_snapshot as an array
            // (the envelope constructor coerces non-arrays to []), so no `|| []`
            // fallback is needed here.
            for (const row of snapshotResult.data.market_snapshot) {
                if (row && typeof row === 'object' && row.pair === normalizedPair) {
                    return Result.ok(row);
                }
            }

            return Result.fail(`Pair ${normalizedPair} not found in market snapshot.`);
        }

        /**
         * Place a new order.
         */
        public async addOrder(
            req: OrderRequest,
            waitForReceipt: boolean = true
        ): Promise<Result<{ txHash: string; clientOrderId: string; operation: string }>> {
            if (!this.signer) {
                return Result.fail('Private key/Signer not configured.');
            }

            // Validate order params
            const validationResult = validateOrderParams(
                req.pair, 
                req.amount, 
                req.price || null, 
                req.type || 'LIMIT'
            );
            if (!validationResult.success) {
                return Result.fail(validationResult.error!);
            }
            
            if (!this._ensurePairExists(req.pair)) {
                const pairsResult = await this.getClobPairs();
                if (!pairsResult.success) {
                    return Result.fail(pairsResult.error!);
                }
                if (!this.pairs[req.pair]) {
                    return Result.fail(`Pair ${req.pair} not found.`);
                }
            }

            const pairData = this.pairs[req.pair];
            if (!this._tradePairsDeployment()) {
                return Result.fail('TradePairs contract not initialized.');
            }

            try {
                const norm = this._normalizeOrderAmounts(req.price, req.amount, pairData);
                if (!norm.success) {
                    return Result.fail(norm.error!);
                }
                const { price: normPrice, amount: normAmount } = norm.data!;

                const priceWei = normPrice ? toWei(normPrice, pairData.quote_decimals) : 0n;
                const qtyWei = toWei(normAmount, pairData.base_decimals);

                const clientOrderId = Utils.toBytes32(Math.random().toString(36).substring(7));
                
                const sideEnum = req.side === 'BUY' ? 0 : 1;
                const typeEnum = req.type === 'MARKET' ? 0 : 1;

                const mods = this._resolveOrderModifiers(
                    typeEnum,
                    req.timeInForce,
                    req.stp,
                    !!normPrice
                );
                if (!mods.success) {
                    return Result.fail(mods.error!);
                }

                const address = await this.signer.getAddress();

                const orderStruct = {
                    clientOrderId: clientOrderId,
                    tradePairId: pairData.tradePairId,
                    price: priceWei,
                    quantity: qtyWei,
                    traderaddress: address,
                    side: sideEnum,
                    type1: typeEnum,
                    type2: mods.data!.type2,
                    stp: mods.data!.stp,
                };

                return await this._withL1TradePairsContract(async (contract) => {
                    const gasEst = await contract.addNewOrder.estimateGas(orderStruct);
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                    const tx = await contract.addNewOrder(orderStruct, { gasLimit });
                    
                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({
                            txHash: receipt.hash,
                            clientOrderId: clientOrderId,
                            operation: 'add_order',
                        });
                    }

                    return Result.ok({
                        txHash: tx.hash,
                        clientOrderId: clientOrderId,
                        operation: 'add_order',
                    });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'placing order'));
            }
        }

        /**
         * Cancel a single order.
         */
        public async cancelOrder(
            orderId: string | Uint8Array,
            waitForReceipt: boolean = true
        ): Promise<Result<{ txHash: string; operation: string }>> {
            if (!this.signer) {
                return Result.fail('Signer not configured.');
            }

            const validationResult = validateOrderIdFormat(orderId, 'orderId');
            if (!validationResult.success) {
                return Result.fail(validationResult.error!);
            }

            if (!this._tradePairsDeployment()) {
                return Result.fail('TradePairs contract not initialized.');
            }

            try {
                return await this._withL1TradePairsContract(async (contract) => {
                    const resolved = await this._resolveOrderReference(contract, orderId);
                    if (!resolved.success || !resolved.data) {
                        return Result.fail(resolved.error || 'Could not resolve order ID');
                    }
                    const { idType, orderData } = resolved.data;

                    let gasEst: bigint;
                    let tx: TransactionResponse;
                    if (idType === 'client') {
                        const clientHex = this._slotToBytes32Hex(orderData[1]);
                        gasEst = await contract.cancelOrderByClientId.estimateGas(clientHex);
                        const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                        tx = await contract.cancelOrderByClientId(clientHex, { gasLimit });
                    } else {
                        const internalHex = this._slotToBytes32Hex(orderData[0]);
                        gasEst = await contract.cancelOrder.estimateGas(internalHex);
                        const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                        tx = await contract.cancelOrder(internalHex, { gasLimit });
                    }

                    const operation =
                        idType === 'client' ? 'cancel_order_by_client_id' : 'cancel_order';

                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail('Transaction reverted');
                        }
                        return Result.ok({ txHash: receipt.hash, operation });
                    }

                    return Result.ok({ txHash: tx.hash, operation });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'cancelling order'));
            }
        }

        /**
         * Cancel a single open order by client order ID (on-chain).
         */
        public async cancelOrderByClientId(
            clientOrderId: string | Uint8Array,
            waitForReceipt: boolean = true
        ): Promise<Result<{ txHash: string; cancelledClientOrderId: string; operation: string }>> {
            if (!this.signer) {
                return Result.fail('Private key not configured.');
            }

            const validationResult = validateOrderIdFormat(clientOrderId, 'clientOrderId');
            if (!validationResult.success) {
                return Result.fail(validationResult.error!);
            }

            if (!this._tradePairsDeployment()) {
                return Result.fail('TradePairs contract not initialized.');
            }

            let clientOrderIdBytes: string;
            try {
                clientOrderIdBytes = this._orderIdToBytes32Hex(clientOrderId);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return Result.fail(msg);
            }

            try {
                return await this._withL1TradePairsContract(async (contract) => {
                    const gasEst = await contract.cancelOrderByClientId.estimateGas(clientOrderIdBytes);
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                    const tx = await contract.cancelOrderByClientId(clientOrderIdBytes, { gasLimit });

                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail('Transaction reverted');
                        }
                        return Result.ok({
                            txHash: receipt.hash,
                            cancelledClientOrderId: clientOrderIdBytes,
                            operation: 'cancel_order_by_client_id',
                        });
                    }

                    return Result.ok({
                        txHash: tx.hash,
                        cancelledClientOrderId: clientOrderIdBytes,
                        operation: 'cancel_order_by_client_id',
                    });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'cancelling order by client ID'));
            }
        }

        /**
         * Cancel all open orders.
         */
        public async cancelAllOrders(): Promise<
            Result<{ txHash: string; operation: string; cancelledInternalOrderIds: string[] }>
        > {
            const openOrdersResult = await this.getOpenOrders();
            if (!openOrdersResult.success) {
                return Result.fail(openOrdersResult.error!);
            }
            
            const openOrders = openOrdersResult.data;
            if (!openOrders || openOrders.length === 0) {
                return Result.fail('No open orders to cancel.');
            }
            
            const ids = openOrders.map(o => o.internalOrderId);
            return await this.cancelListOrders(ids);
        }

        public async cancelListOrders(
            orderIds: string[],
            waitForReceipt: boolean = true
        ): Promise<
            Result<{ txHash: string; operation: string; cancelledInternalOrderIds: string[] }>
        > {
            if (!this.signer || !this._tradePairsDeployment()) {
                return Result.fail('Not initialized');
            }

            try {
                return await this._withL1TradePairsContract(async (contract) => {
                    const gasEst = await contract.cancelOrderList.estimateGas(orderIds);
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                    const tx = await contract.cancelOrderList(orderIds, { gasLimit });

                    const payload = {
                        cancelledInternalOrderIds: orderIds.slice(),
                        operation: 'cancel_list_orders' as const,
                    };

                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({ txHash: receipt.hash, ...payload });
                    }

                    return Result.ok({ txHash: tx.hash, ...payload });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'cancelling order list'));
            }
        }

        /**
         * Get Open Orders from REST API.
         */
        /**
         * Transform API order response to match Order interface field names.
         * Maps lowercase/snake_case API fields to camelCase SDK fields.
         */
        private _transformOrderFromAPI(order: any): Order {
            const side = this._enumToName(order.side, SIDE_NAMES);
            const type1 = this._enumToName(order.type1 ?? order.type, ORDER_TYPE_NAMES);
            const type2 = this._enumToName(order.type2, TIME_IN_FORCE_NAMES);
            const status = this._enumToName(order.status, ORDER_STATUS_NAMES);
            const pair = this._resolvePairFromOrder(order) ?? this._findPairInfoByTradePairId(order.tradePairId)?.pair;
            const tradePairId = this._toHexIdentifier(
                order.tradePairId ?? order.tradepairid ?? order.trade_pair_id ?? this._resolveTradePairIdFromPair(pair)
            );
            if (!pair) {
                throw new Error('Could not determine pair from order data.');
            }

            return this._buildCanonicalOrder({
                internalOrderId: this._toHexIdentifier(order.internalOrderId ?? order.id),
                clientOrderId: this._toHexIdentifier(order.clientOrderId ?? order.clientordid ?? order.client_order_id),
                tradePairId,
                pair,
                price: this._coerceOrderNumeric(order.price, 'price'),
                totalAmount: this._coerceOrderNumeric(
                    order.totalAmount ?? order.totalamount ?? order.total_amount,
                    'totalAmount'
                ),
                quantity: this._coerceOrderNumeric(order.quantity, 'quantity'),
                quantityFilled: this._coerceOrderNumeric(
                    order.quantityFilled ?? order.quantityfilled ?? order.filledQuantity ?? order.filled_quantity,
                    'quantityFilled'
                ),
                totalFee: this._coerceOrderNumeric(order.totalFee ?? order.totalfee ?? order.total_fee, 'totalFee'),
                traderAddress: String(order.traderAddress ?? order.traderaddress ?? ''),
                side: String(side),
                type1: String(type1),
                type2: String(type2),
                status: String(status),
                updateBlock: this._coerceOptionalOrderBlock(order.updateBlock ?? order.update_block, 'updateBlock'),
                createBlock: this._coerceOptionalOrderBlock(order.createBlock ?? order.create_block, 'createBlock'),
                createTs: order.createTs ?? order.create_ts ?? order.timestamp ?? order.ts ?? null,
                updateTs: order.updateTs ?? order.update_ts ?? order.updatets ?? null,
                tx: order.tx ?? order.txHash ?? null,
            });
        }

        public async getOpenOrders(pair?: string): Promise<Result<Order[]>> {
            if (!this.signer) {
                return Result.fail('Signer not configured.');
            }

            if (pair) {
                const pairResult = validatePairFormat(pair, 'pair');
                if (!pairResult.success) {
                    return Result.fail(pairResult.error!);
                }
            }
            
            try {
                const headers = await this._getAuthHeaders();
                const params: any = { category: 0 };
                if (pair) params['pair'] = pair;

                const data = await this._apiCall<any>('get', ENDPOINTS.SIGNED_ORDERS, { headers, params });
                
                let orders: any[] = [];
                if (data && data.rows) {
                    orders = data.rows;
                } else if (Array.isArray(data)) {
                    orders = data;
                } else if (data) {
                    orders = [data];
                }

                if (orders.some((order) => {
                    const pair = this._resolvePairFromOrder(order);
                    const tradePairId = order.tradePairId ?? order.tradepairid ?? order.trade_pair_id;
                    return !pair || !tradePairId;
                })) {
                    const pairsResult = await this.getClobPairs();
                    if (!pairsResult.success) {
                        return Result.fail(pairsResult.error!);
                    }
                }

                const transformedOrders = orders.map(order => this._transformOrderFromAPI(order));
                return Result.ok(transformedOrders);
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'fetching open orders'));
            }
        }

        /**
         * Paginated per-account order history (any status: NEW, PARTIAL,
         * FILLED, CANCELED, EXPIRED, KILLED, REJECTED). Returns canonical
         * `Order[]` rows in the same shape as `getOpenOrders` — they pass
         * through the shared `_transformOrderFromAPI` helper so callers can
         * mix the two result sets without re-normalising.
         *
         * Routes through the signed REST endpoint
         * `/api/trading/signed/orders` (distinct from `getOpenOrders`'
         * `/privapi/signed/orders` which only returns currently-open
         * rows). The trade-kit's `clob_get_orders_by_account` tool calls
         * the same endpoint via `signedGet("orders", ...)` and provided
         * the empirical verification for the path + query shape used here.
         *
         * Cached for 10 seconds (balance tier) per `(address, opts)` tuple.
         * The resolved address is either the explicit `account` argument
         * or the connected wallet address; distinct addresses and
         * distinct filter combinations never share a cache slot.
         *
         * When no wallet is configured AND no explicit `account` is
         * passed, returns `Result.fail` — the call has no addressee.
         * When a wallet IS configured, the `x-signature` header is
         * attached via the shared `_getAuthHeaders()` helper; when only
         * an explicit account is supplied (no signer), the auth header
         * is omitted and the backend may reject — this lets read-only
         * callers query by address without forcing a key, mirroring the
         * SDK's general read-only ergonomics.
         *
         * @param account Optional trader address; defaults to the
         *   connected wallet's address. At least one must be available.
         * @param opts Optional filters and pagination
         *   (`pair` / `status` / `limit` / `offset`); defaults to
         *   `{ limit: 100, offset: 0 }` to match the trade-kit's tool wrapper.
         */
        public async getOrderHistory(
            account?: string,
            opts?: {
                pair?: string;
                status?: 'NEW' | 'REJECTED' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'KILLED' | string;
                limit?: number;
                offset?: number;
            }
        ): Promise<Result<Order[]>> {
            let address: string;
            if (account) {
                address = account;
            } else if (this.signer) {
                try {
                    address = await this.signer.getAddress();
                } catch (e) {
                    return Result.fail(this._sanitizeError(e, 'resolving wallet address'));
                }
            } else {
                return Result.fail(
                    'getOrderHistory requires either an account argument or a configured wallet.'
                );
            }

            let pair: string | undefined;
            if (opts?.pair) {
                const pairResult = validatePairFormat(opts.pair, 'pair');
                if (!pairResult.success) {
                    return Result.fail(pairResult.error!);
                }
                // Forward the canonical pair (casing variants and known
                // aliases collapse) so the outgoing params.pair matches the
                // backend's canonical symbol — not the raw caller input.
                pair = this.normalizePair(opts.pair);
            }

            const limit = opts?.limit ?? 100;
            const offset = opts?.offset ?? 0;
            const status = opts?.status;

            const cacheArgs = JSON.stringify({ pair, status, limit, offset });

            const cachedFn = withInstanceCache(
                this,
                this._balanceCache,
                `getOrderHistory|${address}|${cacheArgs}`,
                async (): Promise<Result<Order[]>> => {
                    try {
                        const headers: Record<string, string> = this.signer
                            ? await this._getAuthHeaders()
                            : {};
                        const params: Record<string, string | number> = {
                            traderaddress: address,
                            limit,
                            offset,
                        };
                        if (pair !== undefined) params.pair = pair;
                        if (status !== undefined) params.status = status;

                        const data = await this._apiCall<unknown>(
                            'get',
                            ENDPOINTS.TRADING_SIGNED_ORDERS_HISTORY,
                            { headers, params }
                        );

                        let orders: any[];
                        if (Array.isArray(data)) {
                            orders = data;
                        } else if (
                            data &&
                            typeof data === 'object' &&
                            Array.isArray((data as Record<string, unknown>).rows)
                        ) {
                            orders = (data as Record<string, unknown>).rows as any[];
                        } else if (data && typeof data === 'object') {
                            orders = [data];
                        } else {
                            return Result.fail(
                                `Unexpected order history response shape: expected object or array, got ${typeof data}.`
                            );
                        }

                        if (orders.some((order) => {
                            const orderPair = this._resolvePairFromOrder(order);
                            const tradePairId = order.tradePairId ?? order.tradepairid ?? order.trade_pair_id;
                            return !orderPair || !tradePairId;
                        })) {
                            const pairsResult = await this.getClobPairs();
                            if (!pairsResult.success) {
                                return Result.fail(pairsResult.error!);
                            }
                        }

                        const transformed = orders.map((order) => this._transformOrderFromAPI(order));
                        return Result.ok(transformed);
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, 'fetching order history'));
                    }
                }
            );
            return cachedFn();
        }

        /**
         * Get OrderBook.
         * Cached for 1 second (orderbook data).
         */
        public async getOrderBook(pair: string): Promise<Result<OrderBook>> {
            const cachedFn = withInstanceCache(
                this,
                this._orderbookCache,
                'getOrderBook',
                async (pair: string): Promise<Result<OrderBook>> => {
                    const pairResult = validatePairFormat(pair, 'pair');
                    if (!pairResult.success) {
                        return Result.fail(pairResult.error!);
                    }

                    if (!this.pairs[pair]) {
                        const pairsResult = await this.getClobPairs();
                        if (!pairsResult.success) {
                            return Result.fail(pairsResult.error!);
                        }
                    }
                    
                    const pairData = this.pairs[pair];
                    if (!pairData) {
                        return Result.fail(`Pair ${pair} not found`);
                    }

                    const dep = this._tradePairsDeployment();
                    if (!dep) {
                        return Result.fail('Contract not initialized');
                    }

                    try {
                        const NULL_BYTES = "0x0000000000000000000000000000000000000000000000000000000000000000";
                        const { bids, asks } = await this.withRpcFailover(
                            this._dexalotL1DisplayName(),
                            async (p) => {
                                const contract = this._contractReadOnly(p, dep.address, dep.abi);
                                const bidsData = await contract.getNBook(pairData.tradePairId, 0, 10, 10, 0, NULL_BYTES);
                                const asksData = await contract.getNBook(pairData.tradePairId, 1, 10, 10, 0, NULL_BYTES);
                                return {
                                    bids: this._parseNBook(bidsData, pairData),
                                    asks: this._parseNBook(asksData, pairData),
                                };
                            }
                        );
                        return Result.ok({ pair, bids, asks });
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, 'fetching orderbook'));
                    }
                }
            );
            return cachedFn(pair);
        }

        public _parseNBook(data: any[], pairData: Pair) {
            const prices = data[0];
            const quantities = data[1];
            const result = [];
            
            for(let i=0; i<prices.length; i++) {
                if (prices[i] == 0) continue;
                const p = parseFloat(Utils.unitConversion(prices[i], pairData.quote_decimals, false));
                const q = parseFloat(Utils.unitConversion(quantities[i], pairData.base_decimals, false));
                result.push({ price: p, quantity: q });
            }
            return result;
        }

        public async _getAuthHeaders(): Promise<Record<string, string>> {
            if (!this.signer) throw new Error("No signer");

            if (!this.config.timestampedAuth && this._cachedSignature) {
                return { "x-signature": this._cachedSignature };
            }

            let msg = "dexalot";
            const headers: Record<string, string> = {};
            if (this.config.timestampedAuth) {
                const ts = Date.now();
                msg = `dexalot${ts}`;
                headers["x-timestamp"] = String(ts);
            }

            const signature = await this.signer.signMessage(msg);
            const address = await this.signer.getAddress();
            const fullSig = `${address}:${signature}`;

            if (!this.config.timestampedAuth) {
                this._cachedSignature = fullSig;
            }

            return { ...headers, "x-signature": fullSig };
        }

        public async getOrder(orderId: string | Uint8Array): Promise<Result<Order>> {
            const validationResult = validateOrderIdFormat(orderId, 'orderId');
            if (!validationResult.success) {
                return Result.fail(validationResult.error!);
            }

            if (!this.signer || !this._tradePairsDeployment()) {
                return Result.fail('Signer/Contract not initialized');
            }

            try {
                return await this._withL1TradePairsContract(async (contract) => {
                    const resolved = await this._resolveOrderReference(contract, orderId);
                    if (!resolved.success || !resolved.data) {
                        return Result.fail(resolved.error || 'Order not found');
                    }
                    const orderResult = await this._formatOrderData(resolved.data.orderData);
                    if (!orderResult.success || !orderResult.data) {
                        return Result.fail(orderResult.error || 'Order formatting failed');
                    }
                    return Result.ok(orderResult.data);
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting order'));
            }
        }

        public async getOrderByClientId(clientOrderId: string | Uint8Array): Promise<Result<Order>> {
            const validationResult = validateOrderIdFormat(clientOrderId, 'clientOrderId');
            if (!validationResult.success) {
                return Result.fail(validationResult.error!);
            }

            if (!this.signer || !this._tradePairsDeployment()) {
                return Result.fail('Signer/Contract not initialized');
            }

            let clientOrderIdBytes: string;
            try {
                clientOrderIdBytes = this._orderIdToBytes32Hex(clientOrderId);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return Result.fail(msg);
            }

            try {
                return await this._withL1TradePairsContract(async (contract) => {
                    const orderData = await this._fetchOrderByClientIdPath(
                        contract,
                        clientOrderIdBytes
                    );
                    if (!orderData) {
                        return Result.fail('Order not found (Client ID).');
                    }
                    const orderResult = await this._formatOrderData(orderData);
                    if (!orderResult.success || !orderResult.data) {
                        return Result.fail(orderResult.error || 'Order formatting failed');
                    }
                    return Result.ok(orderResult.data);
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting order by client ID'));
            }
        }

        public async addLimitOrderList(
            orders: OrderRequest[],
            waitForReceipt: boolean = true
        ): Promise<Result<{ txHash: string; clientOrderIds: string[]; operation: string }>> {
            if (!this.signer || !this._tradePairsDeployment()) {
                return Result.fail('Signer/Contract not initialized');
            }
            
            try {
                const orderTuples: any[] = [];
                const clientOrderIds: string[] = [];

                for (const order of orders) {
                    const pair = order.pair;
                    
                    const validationResult = validateOrderParams(pair, order.amount, order.price || null, order.type || 'LIMIT');
                    if (!validationResult.success) {
                        return Result.fail(validationResult.error!);
                    }

                    if (!this._ensurePairExists(pair)) {
                        await this.getClobPairs();
                        if (!this.pairs[pair]) {
                            return Result.fail(`Pair ${pair} not found`);
                        }
                    }
                    
                    const pairData = this.pairs[pair];
                    const sideEnum = (order.side.toUpperCase() === 'BUY') ? 0 : 1;

                    const typeRes = parseOrderType(order.type ?? 'LIMIT');
                    if (!typeRes.success) {
                        return Result.fail(typeRes.error!);
                    }
                    const type1Enum = typeRes.data!;

                    const norm = this._normalizeOrderAmounts(order.price, order.amount, pairData);
                    if (!norm.success) {
                        return Result.fail(norm.error!);
                    }
                    const { price: normPrice, amount: normAmount } = norm.data!;

                    const mods = this._resolveOrderModifiers(
                        type1Enum,
                        order.timeInForce,
                        order.stp,
                        !!normPrice
                    );
                    if (!mods.success) {
                        return Result.fail(mods.error!);
                    }

                    const priceWei = normPrice ? toWei(normPrice, pairData.quote_decimals) : 0n;
                    const qtyWei = toWei(normAmount, pairData.base_decimals);

                    const clientOrderId = ethers.hexlify(ethers.randomBytes(32));
                    clientOrderIds.push(clientOrderId);

                    orderTuples.push([
                        clientOrderId,
                        pairData.tradePairId,
                        priceWei,
                        qtyWei,
                        await this.signer.getAddress(),
                        sideEnum,
                        type1Enum,
                        mods.data!.type2,
                        mods.data!.stp
                    ]);
                }

                return await this._withL1TradePairsContract(async (contract) => {
                    const gasEst = await contract.addOrderList.estimateGas(orderTuples);
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                    
                    const tx = await contract.addOrderList(orderTuples, { gasLimit });
                    
                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({
                            txHash: receipt.hash,
                            clientOrderIds,
                            operation: 'add_order_list',
                        });
                    }

                    return Result.ok({
                        txHash: tx.hash,
                        clientOrderIds,
                        operation: 'add_order_list',
                    });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'placing batch orders'));
            }
        }

        /**
         * Alias for {@link addLimitOrderList}. The batch path accepts mixed
         * order types (per-order `type` / `timeInForce` / `stp`), so this name
         * reads more accurately than the historical `addLimitOrderList`, which
         * is retained for backward compatibility.
         */
        public async addOrderList(
            orders: OrderRequest[],
            waitForReceipt: boolean = true
        ): Promise<Result<{ txHash: string; clientOrderIds: string[]; operation: string }>> {
            return this.addLimitOrderList(orders, waitForReceipt);
        }

        public async replaceOrder(
            orderId: string,
            newPrice: number,
            newAmount: number,
            waitForReceipt: boolean = true
        ): Promise<
            Result<{
                txHash: string;
                operation: string;
                cancelledClientOrderId: string;
                cancelledInternalOrderId: string;
                clientOrderId: string;
            }>
        > {
            const orderIdResult = validateOrderIdFormat(orderId, 'orderId');
            if (!orderIdResult.success) {
                return Result.fail(orderIdResult.error!);
            }

            const priceResult = validatePositiveNumber(newPrice, 'newPrice');
            if (!priceResult.success) {
                return Result.fail(priceResult.error!);
            }

            const amountResult = validatePositiveNumber(newAmount, 'newAmount');
            if (!amountResult.success) {
                return Result.fail(amountResult.error!);
            }

            try {
                const orderResult = await this.getOrder(orderId);
                if (!orderResult.success) {
                    return Result.fail(orderResult.error!);
                }
                
                const order = orderResult.data;
                if (!order) {
                    return Result.fail(orderResult.error || 'Order not found');
                }
                const pair = order.pair;
                const pairData = this.pairs[pair];
                if (!pairData) {
                    return Result.fail('Pair data not found for order');
                }

                const norm = this._normalizeOrderAmounts(newPrice, newAmount, pairData);
                if (!norm.success) {
                    return Result.fail(norm.error!);
                }
                const { price: normPrice, amount: normAmount } = norm.data!;

                // newPrice is gated through validatePositiveNumber above, so the
                // normalized price is non-null here.
                const priceWei = toWei(normPrice!, pairData.quote_decimals);
                const qtyWei = toWei(normAmount, pairData.base_decimals);
                const newClientOrderId = ethers.hexlify(ethers.randomBytes(32));
                const orderIdBytes = this._slotToBytes32Hex(order.internalOrderId);
                const cancelledInternalOrderId = this._slotToBytes32Hex(order.internalOrderId);
                const cancelledClientOrderId = this._slotToBytes32Hex(order.clientOrderId);

                if (!this._tradePairsDeployment()) {
                    return Result.fail('TradePairs contract not initialized.');
                }

                return await this._withL1TradePairsContract(async (contract) => {
                    const gasEst = await contract.cancelReplaceOrder.estimateGas(
                        orderIdBytes,
                        newClientOrderId,
                        priceWei,
                        qtyWei
                    );
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));

                    const tx = await contract.cancelReplaceOrder(
                        orderIdBytes,
                        newClientOrderId,
                        priceWei,
                        qtyWei,
                        { gasLimit }
                    );

                    const payload = {
                        operation: 'replace_order' as const,
                        cancelledClientOrderId,
                        cancelledInternalOrderId,
                        clientOrderId: newClientOrderId,
                    };

                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({ txHash: receipt.hash, ...payload });
                    }

                    return Result.ok({ txHash: tx.hash, ...payload });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'replacing order'));
            }
        }

        public async cancelListOrdersByClientId(
            clientOrderIds: string[],
            waitForReceipt: boolean = true
        ): Promise<
            Result<{ txHash: string; operation: string; cancelledClientOrderIds: string[] }>
        > {
            if (!this.signer || !this._tradePairsDeployment()) {
                return Result.fail('Signer/Contract not initialized');
            }

            try {
                const ids = clientOrderIds.map((id) => (id.startsWith('0x') ? id : Utils.toBytes32(id)));
                const payload = {
                    cancelledClientOrderIds: clientOrderIds.slice(),
                    operation: 'cancel_list_orders_by_client_id' as const,
                };
                return await this._withL1TradePairsContract(async (contract) => {
                    const gasEst = await contract.cancelOrderListByClientIds.estimateGas(ids);
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                    const tx = await contract.cancelOrderListByClientIds(ids, { gasLimit });

                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({ txHash: receipt.hash, ...payload });
                    }

                    return Result.ok({ txHash: tx.hash, ...payload });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'cancelling orders by client ID'));
            }
        }

        public async cancelAddList(
            replacements: any[],
            waitForReceipt: boolean = true
        ): Promise<
            Result<{
                txHash: string;
                operation: string;
                cancelledClientOrderIds: string[];
                cancelledInternalOrderIds: string[];
                clientOrderIds: string[];
            }>
        > {
            if (!this.signer || !this._tradePairsDeployment()) {
                return Result.fail('Signer/Contract not initialized');
            }

            try {
                const orderIds: string[] = [];
                const newOrders: any[] = [];
                const cancelledClientOrderIds: string[] = [];
                const cancelledInternalOrderIds: string[] = [];
                const newClientOrderIds: string[] = [];

                for (const rep of replacements) {
                    const orderId = rep.order_id;
                    const orderResult = await this.getOrder(orderId);
                    if (!orderResult.success) {
                        return Result.fail(orderResult.error!);
                    }
                    const orderDetails = orderResult.data;
                    if (!orderDetails) {
                        return Result.fail(orderResult.error || 'Order not found');
                    }
                    const orderIdBytes = this._slotToBytes32Hex(orderDetails.internalOrderId);
                    orderIds.push(orderIdBytes);
                    cancelledInternalOrderIds.push(this._slotToBytes32Hex(orderDetails.internalOrderId));
                    cancelledClientOrderIds.push(this._slotToBytes32Hex(orderDetails.clientOrderId));

                    let side = rep.side;
                    let pair = rep.pair;
                    if (side == null || !pair) {
                        if (side == null) side = orderDetails.side;
                        if (!pair) pair = orderDetails.pair;
                    }
                    
                    pair = pair || "AVAX/USDC";
                    if (!this._ensurePairExists(pair)) {
                        await this.getClobPairs();
                        if (!this.pairs[pair]) {
                            return Result.fail(`Pair ${pair} not found`);
                        }
                    }
                    const pairData = this.pairs[pair];
                    
                    let sideEnum: number;
                    if (typeof side === 'number') {
                        sideEnum = side;
                    } else {
                        sideEnum = (side.toUpperCase() === 'BUY') ? 0 : 1;
                    }
                    
                    const typeRes = parseOrderType(rep.order_type ?? rep.type ?? 'LIMIT');
                    if (!typeRes.success) {
                        return Result.fail(typeRes.error!);
                    }
                    const type1Enum = typeRes.data!;

                    const norm = this._normalizeOrderAmounts(rep.price, rep.amount, pairData);
                    if (!norm.success) {
                        return Result.fail(norm.error!);
                    }
                    const { price: normPrice, amount: normAmount } = norm.data!;

                    const mods = this._resolveOrderModifiers(
                        type1Enum,
                        rep.timeInForce ?? rep.time_in_force,
                        rep.stp,
                        !!normPrice
                    );
                    if (!mods.success) {
                        return Result.fail(mods.error!);
                    }

                    const priceWei = normPrice ? toWei(normPrice, pairData.quote_decimals) : 0n;
                    const qtyWei = toWei(normAmount, pairData.base_decimals);
                    const newClientOrderId = ethers.hexlify(ethers.randomBytes(32));
                    newClientOrderIds.push(newClientOrderId);

                    newOrders.push([
                        newClientOrderId,
                        pairData.tradePairId,
                        priceWei,
                        qtyWei,
                        await this.signer.getAddress(),
                        sideEnum,
                        type1Enum,
                        mods.data!.type2,
                        mods.data!.stp
                    ]);
                }

                const listPayload = {
                    operation: 'cancel_add_list' as const,
                    cancelledClientOrderIds,
                    cancelledInternalOrderIds,
                    clientOrderIds: newClientOrderIds,
                };

                return await this._withL1TradePairsContract(async (contract) => {
                    const gasEst = await contract.cancelAddList.estimateGas(orderIds, newOrders);
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));

                    const tx = await contract.cancelAddList(orderIds, newOrders, { gasLimit });

                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({ txHash: receipt.hash, ...listPayload });
                    }

                    return Result.ok({ txHash: tx.hash, ...listPayload });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'cancel add list'));
            }
        }

        public async _formatOrderData(orderData: any[]): Promise<Result<Order>> {
            if (!Array.isArray(orderData) || orderData.length < 15) {
                return Result.fail('Order data missing required createBlock/updateBlock fields.');
            }

            try {
                const tradePairId = this._toHexIdentifier(orderData[2]);
                let pairInfo = this._findPairInfoByTradePairId(tradePairId);

                if (!pairInfo) {
                    const pairsResult = await this.getClobPairs();
                    if (!pairsResult.success) {
                        return Result.fail(pairsResult.error!);
                    }
                    pairInfo = this._findPairInfoByTradePairId(tradePairId);
                }

                if (!pairInfo) {
                    return Result.fail('Could not determine pair from order data.');
                }

                const side = this._enumToName(orderData[9], SIDE_NAMES);
                const type1 = this._enumToName(orderData[10], ORDER_TYPE_NAMES);
                const type2 = this._enumToName(orderData[11], TIME_IN_FORCE_NAMES);
                const status = this._enumToName(orderData[12], ORDER_STATUS_NAMES);

                const traderAddress =
                    typeof orderData[8] === 'string' && orderData[8]
                        ? orderData[8]
                        : String(orderData[8] ?? '');

                // Big-based wei → display conversion is precision-exact
                // through every intermediate step; .toNumber() at the
                // boundary fits the public Order shape (price: number).
                // Floating-point rounding only happens once, at the very
                // last step, rather than at each arithmetic operation.
                return Result.ok(
                    this._buildCanonicalOrder({
                        internalOrderId: this._toHexIdentifier(orderData[0]),
                        clientOrderId: this._toHexIdentifier(orderData[1]),
                        tradePairId,
                        pair: pairInfo.pair,
                        price: fromWei(orderData[3], pairInfo.quote_decimals).toNumber(),
                        totalAmount: fromWei(orderData[4], pairInfo.quote_decimals).toNumber(),
                        quantity: fromWei(orderData[5], pairInfo.base_decimals).toNumber(),
                        quantityFilled: fromWei(orderData[6], pairInfo.base_decimals).toNumber(),
                        totalFee: fromWei(orderData[7], pairInfo.quote_decimals).toNumber(),
                        traderAddress,
                        side: String(side),
                        type1: String(type1),
                        type2: String(type2),
                        status: String(status),
                        updateBlock: this._coerceOrderBlock(orderData[13], 'updateBlock'),
                        createBlock: this._coerceOrderBlock(orderData[14], 'createBlock'),
                    })
                );
            } catch (e: unknown) {
                return Result.fail(e instanceof Error ? e.message : String(e));
            }
        }
}

function DataHexString(s: string) { return s.toLowerCase(); }
