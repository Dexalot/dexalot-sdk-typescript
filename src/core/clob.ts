import { ethers, TransactionResponse, toBigInt } from 'ethers';
import { Utils } from '../utils/index.js';
import { OrderRequest, Pair, OrderBook, Order } from '../types/index.js';
import { ENDPOINTS, ENV, DEFAULTS } from '../constants.js';
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

        /**
         * Place a new order.
         */
        public async addOrder(req: OrderRequest, waitForReceipt: boolean = true): Promise<Result<{txHash: string, clientOrderId: string}>> {
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
            const contract = this.tradePairsContract;

            if (!contract) {
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
                        clientOrderId: clientOrderId
                    });
                }
                
                return Result.ok({
                    txHash: tx.hash,
                    clientOrderId: clientOrderId
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'placing order'));
            }
        }

        /**
         * Cancel a single order.
         */
        public async cancelOrder(orderId: string, waitForReceipt: boolean = true): Promise<Result<{txHash: string}>> {
            if (!this.signer) {
                return Result.fail('Signer not configured.');
            }

            const validationResult = validateOrderIdFormat(orderId, 'orderId');
            if (!validationResult.success) {
                return Result.fail(validationResult.error!);
            }

            const contract = this.tradePairsContract;
            if (!contract) {
                return Result.fail('TradePairs contract not initialized.');
            }

            try {
                const gasEst = await contract.cancelOrder.estimateGas(orderId);
                const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                const tx = await contract.cancelOrder(orderId, { gasLimit });
                
                if (waitForReceipt) {
                    const receipt = await tx.wait();
                    if (!receipt || receipt.status !== 1) {
                        return Result.fail("Transaction reverted");
                    }
                    return Result.ok({ txHash: receipt.hash });
                }
                
                return Result.ok({ txHash: tx.hash });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'cancelling order'));
            }
        }

        /**
         * Cancel all open orders.
         */
        public async cancelAllOrders(): Promise<Result<{txHash: string}>> {
            const openOrdersResult = await this.getOpenOrders();
            if (!openOrdersResult.success) {
                return Result.fail(openOrdersResult.error!);
            }
            
            const openOrders = openOrdersResult.data;
            if (!openOrders || openOrders.length === 0) {
                return Result.fail('No open orders to cancel.');
            }
            
            const ids = openOrders.map(o => o.id);
            return await this.cancelListOrders(ids);
        }

        public async cancelListOrders(orderIds: string[], waitForReceipt: boolean = true): Promise<Result<{txHash: string}>> {
            if (!this.signer || !this.tradePairsContract) {
                return Result.fail('Not initialized');
            }

            try {
                const gasEst = await this.tradePairsContract.cancelOrderList.estimateGas(orderIds);
                const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                const tx = await this.tradePairsContract.cancelOrderList(orderIds, { gasLimit });
                
                if (waitForReceipt) {
                    const receipt = await tx.wait();
                    if (!receipt || receipt.status !== 1) {
                        return Result.fail("Transaction reverted");
                    }
                    return Result.ok({ txHash: receipt.hash });
                }
                
                return Result.ok({ txHash: tx.hash });
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
            return {
                id: order.id,
                clientOrderId: order.clientOrderId || order.clientordid || order.client_order_id,
                tradePairId: order.tradePairId || order.tradepairid || order.trade_pair_id,
                price: order.price,
                quantity: order.quantity,
                filledQuantity: order.filledQuantity || order.filledquantity || order.filled_quantity || 0,
                status: order.status,
                side: order.side,
                type: order.type,
                pair: order.pair,
                txHash: order.txHash || order.txhash || order.tx_hash,
                totalFee: order.totalFee || order.totalfee || order.total_fee,
                totalAmount: order.totalAmount || order.totalamount || order.total_amount,
            } as Order;
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

                // Transform API field names to match Order interface
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

                    const contract = this.tradePairsContract;
                    if (!contract) {
                        return Result.fail('Contract not initialized');
                    }

                    try {
                        const NULL_BYTES = "0x0000000000000000000000000000000000000000000000000000000000000000";
                        
                        const bidsData = await contract.getNBook(pairData.tradePairId, 0, 10, 10, 0, NULL_BYTES);
                        const asksData = await contract.getNBook(pairData.tradePairId, 1, 10, 10, 0, NULL_BYTES);

                        const bids = this._parseNBook(bidsData, pairData);
                        const asks = this._parseNBook(asksData, pairData);

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

        public async _getAuthHeaders(): Promise<any> {
            if (!this.signer) throw new Error("No signer");
            
            if (this._cachedSignature) {
                return { "x-signature": this._cachedSignature };
            }

            const msg = "dexalot";
            const signature = await this.signer.signMessage(msg);
            const address = await this.signer.getAddress();
            
            const fullSig = `${address}:${signature}`;
            this._cachedSignature = fullSig;
            
            return { "x-signature": fullSig };
        }

        public async getOrder(orderId: string): Promise<Result<any>> {
            const validationResult = validateOrderIdFormat(orderId, 'orderId');
            if (!validationResult.success) {
                return Result.fail(validationResult.error!);
            }

            const contract = this.tradePairsContract;
            if (!this.signer || !contract) {
                return Result.fail('Signer/Contract not initialized');
            }
            
            try {
                const orderIdBytes = orderId.startsWith('0x') ? orderId : Utils.toBytes32(orderId);
                const orderData = await contract.getOrder(orderIdBytes);
                
                const NULL_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
                if (DataHexString(orderData[0]) === DataHexString(NULL_BYTES32)) {
                    try {
                        const address = await this.signer.getAddress();
                        const orderData2 = await contract.getOrderByClientId(address, orderIdBytes);
                        if (DataHexString(orderData2[0]) !== DataHexString(NULL_BYTES32)) {
                            return Result.ok(await this._formatOrderData(orderData2));
                        }
                    } catch (e) {
                        // ignore
                    }
                    return Result.fail('Order not found');
                }
                return Result.ok(await this._formatOrderData(orderData));
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting order'));
            }
        }

        public async getOrderByClientId(clientOrderId: string): Promise<Result<any>> {
            const validationResult = validateOrderIdFormat(clientOrderId, 'clientOrderId');
            if (!validationResult.success) {
                return Result.fail(validationResult.error!);
            }

            const contract = this.tradePairsContract;
            if (!this.signer || !contract) {
                return Result.fail('Signer/Contract not initialized');
            }
             
            try {
                const clientOrderIdBytes = clientOrderId.startsWith('0x') ? clientOrderId : Utils.toBytes32(clientOrderId);
                const address = await this.signer.getAddress();
                const orderData = await contract.getOrderByClientOrderId(address, clientOrderIdBytes);
                return Result.ok(await this._formatOrderData(orderData));
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting order by client ID'));
            }
        }

        public async addOrderList(orders: OrderRequest[], waitForReceipt: boolean = true): Promise<Result<{txHash: string, clientOrderIds: string[]}>> {
            const contract = this.tradePairsContract;
            if (!this.signer || !contract) {
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

                const gasEst = await contract.addOrderList.estimateGas(orderTuples);
                const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                
                const tx = await contract.addOrderList(orderTuples, { gasLimit });
                
                if (waitForReceipt) {
                    const receipt = await tx.wait();
                    if (!receipt || receipt.status !== 1) {
                        return Result.fail("Transaction reverted");
                    }
                    return Result.ok({ txHash: receipt.hash, clientOrderIds });
                }
                
                return Result.ok({ txHash: tx.hash, clientOrderIds });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'placing batch orders'));
            }
        }

        public async replaceOrder(orderId: string, newPrice: number, newAmount: number, waitForReceipt: boolean = true): Promise<Result<{txHash: string}>> {
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
                const orderIdBytes = orderId.startsWith('0x') ? orderId : Utils.toBytes32(orderId);

                const gasEst = await this.tradePairsContract!.cancelReplaceOrder.estimateGas(
                    orderIdBytes,
                    newClientOrderId,
                    priceWei,
                    qtyWei
                );
                const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));

                const tx = await this.tradePairsContract!.cancelReplaceOrder(
                    orderIdBytes,
                    newClientOrderId,
                    priceWei,
                    qtyWei,
                    { gasLimit }
                );
                
                if (waitForReceipt) {
                    const receipt = await tx.wait();
                    if (!receipt || receipt.status !== 1) {
                        return Result.fail("Transaction reverted");
                    }
                    return Result.ok({ txHash: receipt.hash });
                }
                
                return Result.ok({ txHash: tx.hash });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'replacing order'));
            }
        }

        public async cancelListOrdersByClientId(clientOrderIds: string[], waitForReceipt: boolean = true): Promise<Result<{txHash: string}>> {
            const contract = this.tradePairsContract;
            if (!this.signer || !contract) {
                return Result.fail('Signer/Contract not initialized');
            }
            
            try {
                const ids = clientOrderIds.map(id => id.startsWith('0x') ? id : Utils.toBytes32(id));
                const gasEst = await contract.cancelOrderListByClientIds.estimateGas(ids);
                const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                const tx = await contract.cancelOrderListByClientIds(ids, { gasLimit });
                
                if (waitForReceipt) {
                    const receipt = await tx.wait();
                    if (!receipt || receipt.status !== 1) {
                        return Result.fail("Transaction reverted");
                    }
                    return Result.ok({ txHash: receipt.hash });
                }
                
                return Result.ok({ txHash: tx.hash });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'cancelling orders by client ID'));
            }
        }

        public async cancelAddList(replacements: any[], waitForReceipt: boolean = true): Promise<Result<{txHash: string}>> {
            const contract = this.tradePairsContract;
            if (!this.signer || !contract) {
                return Result.fail('Signer/Contract not initialized');
            }

            try {
                const orderIds: string[] = [];
                const newOrders: any[] = [];
                 
                for (const rep of replacements) {
                    const orderId = rep.order_id;
                    const orderIdBytes = orderId.startsWith('0x') ? orderId : Utils.toBytes32(orderId);
                    orderIds.push(orderIdBytes);
                    
                    let side = rep.side;
                    let pair = rep.pair;
                    if (side == null || !pair) {
                        const orderResult = await this.getOrder(orderId);
                        if (!orderResult.success) {
                            return Result.fail(orderResult.error!);
                        }
                        const orderDetails = orderResult.data;
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
                 
                const gasEst = await contract.cancelAddList.estimateGas(orderIds, newOrders);
                const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                 
                const tx = await contract.cancelAddList(orderIds, newOrders, { gasLimit });
                
                if (waitForReceipt) {
                    const receipt = await tx.wait();
                    if (!receipt || receipt.status !== 1) {
                        return Result.fail("Transaction reverted");
                    }
                    return Result.ok({ txHash: receipt.hash });
                }
                
                return Result.ok({ txHash: tx.hash });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'cancel add list'));
            }
        }

        public async _formatOrderData(orderData: any[]): Promise<any> {
            const tradePairId = orderData[2];
            let pairInfo = Object.values(this.pairs).find(p => p.tradePairId === tradePairId);
            
            if (!pairInfo) {
                await this.getClobPairs();
                pairInfo = Object.values(this.pairs).find(p => p.tradePairId === tradePairId);
            }

            const res: any = {
                id: orderData[0],
                clientOrderId: orderData[1],
                tradePairId: tradePairId,
                price: orderData[3],
                quantity: orderData[5],
                filledQuantity: orderData[6],
                status: orderData[12],
                side: (orderData[9] == 0) ? 'BUY' : 'SELL',
                type: (orderData[10] == 0) ? 'MARKET' : 'LIMIT',
            };

            if (pairInfo) {
                res.price = parseFloat(Utils.unitConversion(res.price, pairInfo.quote_decimals, false));
                res.quantity = parseFloat(Utils.unitConversion(res.quantity, pairInfo.base_decimals, false));
                res.filledQuantity = parseFloat(Utils.unitConversion(res.filledQuantity, pairInfo.base_decimals, false));
                res.pair = pairInfo.pair;
            }
            return res;
        }
}

function DataHexString(s: string) { return s.toLowerCase(); }
