import { Contract, ethers, TransactionResponse, toBigInt } from 'ethers';
import { Utils } from '../utils/index.js';
import { OrderRequest, Pair, OrderBook, Order } from '../types/index.js';
import { ENDPOINTS, ENV, DEFAULTS, wsApiUrlForRestBase } from '../constants.js';
import { WebSocketManager } from '../utils/websocketManager.js';
import { BaseClient } from './base.js';
import { Result } from '../utils/result.js';
import { withInstanceCache } from '../utils/cache.js';
import {
    validatePairFormat,
    validateOrderParams,
    validateOrderIdFormat,
    validatePositiveFloat
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

        private _enumToName(value: unknown, mapping: Record<number, string>): unknown {
            if (typeof value === 'bigint') {
                return mapping[Number(value)] ?? Number(value);
            }
            if (typeof value === 'number') {
                return mapping[value] ?? value;
            }
            return value;
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
            updateBlock: number;
            createBlock: number;
            createTs?: string | null;
            updateTs?: string | null;
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
                                const pairData: Pair = {
                                    pair: pairName,
                                    base: item.base,
                                    quote: item.quote,
                                    base_decimals: item.base_decimals,
                                    quote_decimals: item.quote_decimals,
                                    base_display_decimals: item.base_display_decimals || 18,
                                    quote_display_decimals: item.quote_display_decimals || 18,
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
                // Round to display decimals to avoid underflow errors
                let price = req.price || 0;
                let amount = req.amount;
                if (pairData.quote_display_decimals !== undefined && price) {
                    price = parseFloat(price.toFixed(pairData.quote_display_decimals));
                }
                if (pairData.base_display_decimals !== undefined) {
                    amount = parseFloat(amount.toFixed(pairData.base_display_decimals));
                }

                const priceWei = Utils.unitConversion(price, pairData.quote_decimals, true);
                const qtyWei = Utils.unitConversion(amount, pairData.base_decimals, true);
                
                const clientOrderId = Utils.toBytes32(Math.random().toString(36).substring(7)); 
                
                const sideEnum = req.side === 'BUY' ? 0 : 1;
                const typeEnum = req.type === 'MARKET' ? 0 : 1;
                const address = await this.signer.getAddress();

                const orderStruct = {
                    clientOrderId: clientOrderId,
                    tradePairId: pairData.tradePairId,
                    price: priceWei,
                    quantity: qtyWei,
                    traderaddress: address,
                    side: sideEnum,
                    type1: typeEnum,
                    type2: 0,
                    stp: 0
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
            const side = this._enumToName(order.side, { 0: 'BUY', 1: 'SELL' });
            const type1 = this._enumToName(order.type1 ?? order.type, {
                0: 'MARKET',
                1: 'LIMIT',
                2: 'STOP',
                3: 'STOPLIMIT',
            });
            const type2 = this._enumToName(order.type2, { 0: 'GTC', 1: 'FOK', 2: 'IOC', 3: 'PO' });
            const status = this._enumToName(order.status, {
                0: 'NEW',
                1: 'REJECTED',
                2: 'PARTIAL',
                3: 'FILLED',
                4: 'CANCELED',
                5: 'EXPIRED',
                6: 'KILLED',
            });
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
                updateBlock: this._coerceOrderBlock(order.updateBlock ?? order.update_block, 'updateBlock'),
                createBlock: this._coerceOrderBlock(order.createBlock ?? order.create_block, 'createBlock'),
                createTs: order.createTs ?? order.create_ts ?? order.timestamp ?? order.ts ?? null,
                updateTs: order.updateTs ?? order.update_ts ?? order.updatets ?? null,
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

        public async addOrderList(
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
                    
                    let price = order.price || 0;
                    let amount = order.amount;
                    if (pairData.quote_display_decimals !== undefined && price) {
                        price = parseFloat(price.toFixed(pairData.quote_display_decimals));
                    }
                    if (pairData.base_display_decimals !== undefined) {
                        amount = parseFloat(amount.toFixed(pairData.base_display_decimals));
                    }
                    
                    const priceWei = BigInt(Utils.unitConversion(price, pairData.quote_decimals, true));
                    const qtyWei = BigInt(Utils.unitConversion(amount, pairData.base_decimals, true));
                    
                    const clientOrderId = ethers.hexlify(ethers.randomBytes(32));
                    clientOrderIds.push(clientOrderId);

                    orderTuples.push([
                        clientOrderId,
                        pairData.tradePairId,
                        priceWei,
                        qtyWei,
                        await this.signer.getAddress(),
                        sideEnum,
                        1,
                        0,
                        0
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

            const priceResult = validatePositiveFloat(newPrice, 'newPrice');
            if (!priceResult.success) {
                return Result.fail(priceResult.error!);
            }

            const amountResult = validatePositiveFloat(newAmount, 'newAmount');
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

                let price = newPrice;
                let amount = newAmount;
                if (pairData.quote_display_decimals !== undefined) {
                    price = parseFloat(price.toFixed(pairData.quote_display_decimals));
                }
                if (pairData.base_display_decimals !== undefined) {
                    amount = parseFloat(amount.toFixed(pairData.base_display_decimals));
                }

                const priceWei = BigInt(Utils.unitConversion(price, pairData.quote_decimals, true));
                const qtyWei = BigInt(Utils.unitConversion(amount, pairData.base_decimals, true));
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
                    
                    let price = rep.price;
                    let amount = rep.amount;
                    if (pairData.quote_display_decimals !== undefined && price) {
                        price = parseFloat(price.toFixed(pairData.quote_display_decimals));
                    }
                    if (pairData.base_display_decimals !== undefined) {
                        amount = parseFloat(amount.toFixed(pairData.base_display_decimals));
                    }
                    
                    const priceWei = BigInt(Utils.unitConversion(price, pairData.quote_decimals, true));
                    const qtyWei = BigInt(Utils.unitConversion(amount, pairData.base_decimals, true));
                    const newClientOrderId = ethers.hexlify(ethers.randomBytes(32));
                    newClientOrderIds.push(newClientOrderId);

                    newOrders.push([
                        newClientOrderId,
                        pairData.tradePairId,
                        priceWei,
                        qtyWei,
                        await this.signer.getAddress(),
                        sideEnum,
                        1,
                        0,
                        0
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

                const side = this._enumToName(orderData[9], { 0: 'BUY', 1: 'SELL' });
                const type1 = this._enumToName(orderData[10], {
                    0: 'MARKET',
                    1: 'LIMIT',
                    2: 'STOP',
                    3: 'STOPLIMIT',
                });
                const type2 = this._enumToName(orderData[11], { 0: 'GTC', 1: 'FOK', 2: 'IOC', 3: 'PO' });
                const status = this._enumToName(orderData[12], {
                    0: 'NEW',
                    1: 'REJECTED',
                    2: 'PARTIAL',
                    3: 'FILLED',
                    4: 'CANCELED',
                    5: 'EXPIRED',
                    6: 'KILLED',
                });

                const traderAddress =
                    typeof orderData[8] === 'string' && orderData[8]
                        ? orderData[8]
                        : String(orderData[8] ?? '');

                return Result.ok(
                    this._buildCanonicalOrder({
                        internalOrderId: this._toHexIdentifier(orderData[0]),
                        clientOrderId: this._toHexIdentifier(orderData[1]),
                        tradePairId,
                        pair: pairInfo.pair,
                        price: parseFloat(
                            Utils.unitConversion(orderData[3], pairInfo.quote_decimals, false)
                        ),
                        totalAmount: parseFloat(
                            Utils.unitConversion(orderData[4], pairInfo.quote_decimals, false)
                        ),
                        quantity: parseFloat(
                            Utils.unitConversion(orderData[5], pairInfo.base_decimals, false)
                        ),
                        quantityFilled: parseFloat(
                            Utils.unitConversion(orderData[6], pairInfo.base_decimals, false)
                        ),
                        totalFee: parseFloat(
                            Utils.unitConversion(orderData[7], pairInfo.quote_decimals, false)
                        ),
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
