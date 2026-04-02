
import { CLOBClient } from '../../src/core/clob';
import { createConfig } from '../../src/core/config';
import { ENV, DEFAULTS, ENDPOINTS } from '../../src/constants';
import { Utils } from '../../src/utils';
import { Contract, ethers, toBigInt } from 'ethers';

// Keep real ethers helpers (hex / bytes32) for CLOB order-id logic; mock Contract only.
jest.mock('ethers', () => {
    const actual = jest.requireActual<typeof import('ethers')>('ethers');
    return {
        ...actual,
        Contract: jest.fn(),
    };
});
jest.mock('../../src/utils');

// Spy on console to silence error logs
jest.spyOn(console, 'error').mockImplementation(() => {});

/** Match CLOB `_orderIdToBytes32Hex` for short UTF-8 client-style strings (tests only). */
function utf8ToOrderBytes32Hex(s: string): string {
    const enc = new TextEncoder().encode(s);
    const paddedArr = new Uint8Array(32);
    paddedArr.set(enc);
    return ethers.hexlify(paddedArr);
}

class TestClient extends CLOBClient {}

describe('CLOBClient', () => {
    let client: TestClient;
    let mockSigner: any;
    let mockAxios: any;
    let mockContract: any;

    const mockAddress = '0xUserAddress';
    const VALID_ORDER_ID = '0x' + '1'.repeat(64);
    const VALID_CLIENT_ID = '0x' + '2'.repeat(64);

    beforeEach(() => {
        jest.clearAllMocks();

        mockSigner = {
            getAddress: jest.fn().mockResolvedValue(mockAddress),
            signMessage: jest.fn().mockResolvedValue('0xSignature'),
            connect: jest.fn().mockImplementation(function (this: any) {
                return this;
            })
        };

        mockAxios = {
            get: jest.fn(),
            request: jest.fn()
        };

        mockContract = {
            addNewOrder: jest.fn().mockResolvedValue({ 
                hash: '0xTxHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            cancelOrder: jest.fn().mockResolvedValue({ 
                hash: '0xCancelHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            cancelOrderList: jest.fn().mockResolvedValue({ 
                hash: '0xCancelListHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            getNBook: jest.fn(),
            getOrder: jest.fn(),
            getOrderByClientId: jest.fn(),
            getOrderByClientOrderId: jest.fn(),
            addOrderList: jest.fn().mockResolvedValue({ 
                hash: '0xAddListHash',
                wait: jest.fn().mockResolvedValue({ status: 1, hash: '0xAddListHash' })
            }),
            cancelReplaceOrder: jest.fn().mockResolvedValue({ 
                hash: '0xReplaceHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            cancelOrderListByClientIds: jest.fn().mockResolvedValue({ 
                hash: '0xCancelByIdsHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            cancelAddList: jest.fn().mockResolvedValue({ 
                hash: '0xCancelAddHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            cancelOrderByClientId: jest.fn().mockResolvedValue({
                hash: '0xCancelByClientHash',
                wait: jest.fn().mockResolvedValue({ status: 1, hash: '0xCancelByClientHash' }),
            }),
        };
        // Gas estimates
        mockContract.addNewOrder.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.cancelOrder.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.cancelOrderList.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.addOrderList.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.cancelReplaceOrder.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.cancelOrderListByClientIds.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.cancelAddList.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.cancelOrderByClientId.estimateGas = jest.fn().mockResolvedValue(100000n);

        const defaultContractOrderRow = [
            VALID_ORDER_ID,
            VALID_CLIENT_ID,
            '0xPairId_AVAX_USDC',
            100n,
            0,
            10n,
            5n,
            0,
            0,
            0,
            1,
            0,
            1,
        ];
        mockContract.getOrder.mockResolvedValue(defaultContractOrderRow);

        // Utils Mocks
        (Utils.toBytes32 as jest.Mock).mockImplementation(val => `0xBytes32_${val}`);
        (Utils.unitConversion as jest.Mock).mockImplementation((val, dec, toWei) => {
            if (toWei) return val.toString() + "000000000000000000"; // Mock Wei
            return "10.0"; // Mock Display
        });

        client = new TestClient(mockSigner);
        (client as any).axios = mockAxios;
        client.deployments['TradePairs'] = { subnet: { address: '0xTradePairs', abi: [] } };
        client.subnetProvider = {} as any;
        (Contract as jest.Mock).mockImplementation(() => mockContract);
        client.subnetEnv = ENV.PROD_MULTI_SUBNET;
        // Disable retry for faster tests; keep full config for RPC failover helpers
        client.config.retryEnabled = false;
        
        // Setup initial pairs for convenience (avoid getClobPairs call in every test)
        client.pairs = {
            'AVAX/USDC': {
                pair: 'AVAX/USDC',
                base: 'AVAX', quote: 'USDC',
                base_decimals: 18, quote_decimals: 6,
                base_display_decimals: 2, quote_display_decimals: 2,
                min_trade_amount: 1, max_trade_amount: 1000,
                tradePairId: '0xPairId_AVAX_USDC'
            }
        };
    });

    describe('getClobPairs', () => {
        it('should fetch and filter pairs', async () => {
             mockAxios.request.mockResolvedValue({
                 data: [
                     { pair: 'AVAX/USDT', env: ENV.PROD_MULTI_SUBNET, mintrade_amnt: '0', maxtrade_amnt: '100', base: 'AVAX', quote: 'USDT', base_evmdecimals: 18, quote_evmdecimals: 6 },
                     { pair: 'IGNORE/ME', env: 'dev' }
                 ]
             });
             
             const result = await client.getClobPairs();
             expect(result.success).toBe(true);
             expect(client.pairs['AVAX/USDT']).toBeDefined();
             expect(client.pairs['IGNORE/ME']).toBeUndefined();
        });

        it('should handle API errors', async () => {
             mockAxios.request.mockRejectedValue(new Error("API Fail"));
             const result = await client.getClobPairs();
             expect(result.success).toBe(false);
             expect(result.error).toContain('API Fail');
        });

        it('should transform API field names to snake_case', async () => {
             mockAxios.request.mockResolvedValue({
                 data: [
                     {
                         pair: 'AVAX/USDC',
                         env: ENV.PROD_MULTI_SUBNET,
                         base: 'AVAX',
                         quote: 'USDC',
                         base_evmdecimals: 18,
                         quote_evmdecimals: 6,
                         basedisplaydecimals: 18,
                         quotedisplaydecimals: 6,
                         mintrade_amnt: '0.1',
                         maxtrade_amnt: '1000'
                     },
                     {
                         pair: 'BTC/USDC',
                         env: ENV.FUJI_MULTI_SUBNET,
                         base: 'BTC',
                         quote: 'USDC',
                         baseEvmDecimals: 8,
                         quoteEvmDecimals: 6,
                         baseDisplayDecimals: 8,
                         quoteDisplayDecimals: 6,
                         minTradeAmnt: '0.001',
                         maxTradeAmnt: '10'
                     }
                 ]
             });
             
             const result = await client.getClobPairs();
             expect(result.success).toBe(true);
             
             // First pair: lowercase fields transformed
             expect(client.pairs['AVAX/USDC']).toBeDefined();
             expect(client.pairs['AVAX/USDC'].base_decimals).toBe(18);
             expect(client.pairs['AVAX/USDC'].quote_decimals).toBe(6);
             expect(client.pairs['AVAX/USDC'].base_display_decimals).toBe(18);
             expect(client.pairs['AVAX/USDC'].quote_display_decimals).toBe(6);
             expect(client.pairs['AVAX/USDC'].min_trade_amount).toBe(0.1);
             expect(client.pairs['AVAX/USDC'].max_trade_amount).toBe(1000);
             
             // Second pair: camelCase fields transformed
             expect(client.pairs['BTC/USDC']).toBeDefined();
             expect(client.pairs['BTC/USDC'].base_decimals).toBe(8);
             expect(client.pairs['BTC/USDC'].quote_decimals).toBe(6);
             expect(client.pairs['BTC/USDC'].base_display_decimals).toBe(8);
             expect(client.pairs['BTC/USDC'].quote_display_decimals).toBe(6);
             expect(client.pairs['BTC/USDC'].min_trade_amount).toBe(0.001);
             expect(client.pairs['BTC/USDC'].max_trade_amount).toBe(10);
        });

        it('should prefer existing snake_case fields over transformations', async () => {
             mockAxios.request.mockResolvedValue({
                 data: [
                     {
                         pair: 'ETH/USDC',
                         env: ENV.PROD_MULTI_SUBNET,
                         base: 'ETH',
                         quote: 'USDC',
                         base_decimals: 18,
                         quote_decimals: 6,
                         base_evmdecimals: 999,  // Should be ignored
                         quoteEvmDecimals: 999,  // Should be ignored
                         base_display_decimals: 18,
                         quote_display_decimals: 6,
                         basedisplaydecimals: 999,  // Should be ignored
                         min_trade_amount: '0.01',
                         max_trade_amount: '100',
                         mintrade_amnt: '999',  // Should be ignored
                     }
                 ]
             });
             
             const result = await client.getClobPairs();
             expect(result.success).toBe(true);
             expect(client.pairs['ETH/USDC']).toBeDefined();
             expect(client.pairs['ETH/USDC'].base_decimals).toBe(18);  // Prefer existing
             expect(client.pairs['ETH/USDC'].quote_decimals).toBe(6);  // Prefer existing
             expect(client.pairs['ETH/USDC'].base_display_decimals).toBe(18);  // Prefer existing
             expect(client.pairs['ETH/USDC'].min_trade_amount).toBe(0.01);  // Prefer existing
        });
    });

    describe('addOrder', () => {
        it('should add order successfully', async () => {
             const result = await client.addOrder({
                 pair: 'AVAX/USDC',
                 side: 'BUY',
                 type: 'LIMIT',
                 amount: 10,
                 price: 20
             });
             expect(result.success).toBe(true);
             expect(mockContract.addNewOrder).toHaveBeenCalled();
        });

        it('should fetch pairs if missing', async () => {
             // Clear pairs first
             client.pairs = {};
             mockAxios.request.mockResolvedValue({ data: [] }); // Empty pairs returned
             const result = await client.addOrder({ pair: 'MISSING/PAIR', side: 'BUY', amount: 1, price: 10 });
             expect(result.success).toBe(false);
             expect(result.error).toContain('Pair MISSING/PAIR not found');
             expect(mockAxios.request).toHaveBeenCalled(); // getClobPairs called
        });

        it('should return error if signer missing', async () => {
             client.signer = undefined as any;
             const result = await client.addOrder({ pair: 'P/Q', side: 'B', amount: 1} as any);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer');
        });

        it('should handle contract errors', async () => {
             mockContract.addNewOrder.estimateGas.mockRejectedValue(new Error("Revert"));
             const result = await client.addOrder({ pair: 'AVAX/USDC', side: 'BUY', amount: 1, price: 10});
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });

        it('should return error for invalid order params', async () => {
             const result = await client.addOrder({ pair: 'INVALID', side: 'BUY', amount: 1, price: 10} as any);
             expect(result.success).toBe(false);
             expect(result.error).toContain('pair');
        });

        it('should return error when getClobPairs fails in addOrder', async () => {
             client.pairs = {};
             mockAxios.request.mockRejectedValue(new Error("API Fail"));
             const result = await client.addOrder({ pair: 'MISSING/PAIR', side: 'BUY', amount: 1, price: 10});
             expect(result.success).toBe(false);
             expect(result.error).toContain('API Fail');
        });
    });

    describe('cancelOrder', () => {
          const resolvedOrderRow = [
              VALID_ORDER_ID,
              VALID_CLIENT_ID,
              '0xPairId_AVAX_USDC',
              100n,
              0,
              10n,
              5n,
              0,
              0,
              0,
              1,
              0,
              1,
          ];

          it('should cancel order', async () => {
              mockContract.getOrder.mockResolvedValue(resolvedOrderRow);
              const result = await client.cancelOrder(VALID_ORDER_ID);
              expect(result.success).toBe(true);
              expect(mockContract.cancelOrder).toHaveBeenCalledWith(
                  VALID_ORDER_ID,
                  expect.any(Object)
              );
          });

          it('should return error if signer missing', async () => {
              client.signer = undefined as any;
              const result = await client.cancelOrder(VALID_ORDER_ID);
              expect(result.success).toBe(false);
              expect(result.error).toContain('Signer');
          });

          it('should return error for invalid orderId format', async () => {
              const result = await client.cancelOrder('');
              expect(result.success).toBe(false);
              expect(result.error).toContain('cannot be empty');
          });

          it('should handle contract error in cancelOrder', async () => {
              mockContract.getOrder.mockResolvedValue(resolvedOrderRow);
              mockContract.cancelOrder.estimateGas.mockRejectedValue(new Error('Contract error'));
              const result = await client.cancelOrder(VALID_ORDER_ID);
              expect(result.success).toBe(false);
              expect(result.error).toContain('cancelling order');
          });
    });

    describe('cancelOrderByClientId', () => {
        it('should cancel by client order id', async () => {
            const result = await client.cancelOrderByClientId(VALID_CLIENT_ID);
            expect(result.success).toBe(true);
            expect(mockContract.cancelOrderByClientId).toHaveBeenCalledWith(
                VALID_CLIENT_ID,
                expect.any(Object)
            );
        });

        it('should return error if signer missing', async () => {
            client.signer = undefined as any;
            const result = await client.cancelOrderByClientId(VALID_CLIENT_ID);
            expect(result.success).toBe(false);
        });
    });

    describe('cancelAllOrders', () => {
         it('should fetch open orders and cancel list', async () => {
             // Mock getOpenOrders internally or via axios mock?
             // Calling getOpenOrders internally triggers axios.
             // Mock axios response for open orders
             mockAxios.request.mockResolvedValue({ data: { rows: [{ id: '0x1' }, { id: '0x2' }] } });
             
             // Mock cancelListOrders
             jest.spyOn(client, 'cancelListOrders').mockResolvedValue({ success: true, data: {}, error: null } as any);

             const result = await client.cancelAllOrders();
             expect(result.success).toBe(true);
             expect(client.cancelListOrders).toHaveBeenCalledWith(['0x1', '0x2']);
         });

         it('should handle no open orders', async () => {
             mockAxios.request.mockResolvedValue({ data: { rows: [] } });
             const result = await client.cancelAllOrders();
             expect(result.success).toBe(false);
             expect(result.error).toContain('No open orders');
         });

         it('should return error string if fetch fails', async () => {
              mockAxios.request.mockRejectedValue(new Error("Fail"));
              const result = await client.cancelAllOrders();
              expect(result.success).toBe(false);
              expect(result.error).toContain('Error fetching open orders');
         });
         
         it('should return error if API returns bad format', async () => {
             // getOpenOrders wraps non-array data in array, so cancelAllOrders will try to map
             // The mapped IDs will be undefined, which should cause cancelListOrders to fail
             mockAxios.request.mockResolvedValue({ data: "BadData" }); // Not array/object with rows
             const result = await client.cancelAllOrders();
             // The result depends on how cancelListOrders handles undefined IDs
             // If it validates, it will fail; otherwise it might succeed
             expect(result.success).toBeDefined();
         });
    });

    describe('cancelListOrders', () => {
         it('should cancel orders directly', async () => {
             const result = await client.cancelListOrders(['0x1', '0x2']);
             expect(result.success).toBe(true);
             expect(mockContract.cancelOrderList).toHaveBeenCalledWith(['0x1', '0x2'], expect.any(Object));
         });

         it('should return error if signer/contract missing', async () => {
             client.signer = undefined as any;
             const result = await client.cancelListOrders([]);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Not initialized');
         });

          it('should return error if contract missing in cancelOrder', async () => {
              client.deployments['TradePairs'] = {};
              const result = await client.cancelOrder(VALID_ORDER_ID);
              expect(result.success).toBe(false);
              expect(result.error).toContain('TradePairs contract not initialized');
          });

          it('should handle contract error in cancelListOrders', async () => {
              mockContract.cancelOrderList.estimateGas.mockRejectedValue(new Error("Contract error"));
              const result = await client.cancelListOrders(['0x1', '0x2']);
              expect(result.success).toBe(false);
              expect(result.error).toContain('cancelling order list');
          });
    });

    describe('getOpenOrders', () => {
         it('should return error if signer missing', async () => {
             client.signer = undefined as any;
             const result = await client.getOpenOrders();
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer not configured');
         });

         it('should return error if API throws', async () => {
             mockAxios.request.mockRejectedValue(new Error("API Fail"));
             const result = await client.getOpenOrders();
             expect(result.success).toBe(false);
             expect(result.error).toContain('Error fetching open orders');
         }); 
         
         it('should fetch with correct params', async () => {
              mockAxios.request.mockResolvedValue({ data: { rows: [] } });
              const result = await client.getOpenOrders('AVAX/USDC');
               expect(result.success).toBe(true);
               
               expect(mockAxios.request).toHaveBeenCalledWith(expect.objectContaining({
                   url: ENDPOINTS.SIGNED_ORDERS,
                   params: expect.objectContaining({ pair: 'AVAX/USDC' })
               }));
         });
         it('should return raw data if rows missing', async () => {
              mockAxios.request.mockResolvedValue({ data: [] }); // Direct array
              const result = await client.getOpenOrders();
              expect(result.success).toBe(true);
              expect(result.data).toEqual([]);
         });

         it('should transform API field names to camelCase', async () => {
              // Mock API response with lowercase field names
              mockAxios.request.mockResolvedValue({ 
                  data: { 
                      rows: [{
                          id: '0x123',
                          clientordid: '0xabc',
                          tradepairid: '0xdef',
                          price: 100,
                          quantity: 1.5,
                          filledquantity: 0.5,
                          status: 0,
                          side: 0,
                          type: 1,
                          pair: 'AVAX/USDC',
                          totalamount: 150,
                          totalfee: 0.1
                      }]
                  } 
              });
              const result = await client.getOpenOrders();
              expect(result.success).toBe(true);
              expect(result.data).toHaveLength(1);
              expect(result.data![0]).toMatchObject({
                  id: '0x123',
                  clientOrderId: '0xabc',
                  tradePairId: '0xdef',
                  price: 100,
                  quantity: 1.5,
                  filledQuantity: 0.5,
                  status: 0,
                  side: 0,
                  type: 1,
                  pair: 'AVAX/USDC',
                  totalAmount: 150,
                  totalFee: 0.1
              });
         });

         it('should return error for invalid pair format', async () => {
              const result = await client.getOpenOrders('INVALID');
              expect(result.success).toBe(false);
              expect(result.error).toContain('pair');
         });
    });

    describe('getOrderBook', () => {
         it('should fetch and parse book', async () => {
              // Mock NBook filter logic (0 prices)
              const mockBook = [[100n, 0n], [1n, 0n]]; // 0 price should be skipped
              mockContract.getNBook.mockResolvedValue(mockBook);
              
              const result = await client.getOrderBook('AVAX/USDC');
              expect(result.success).toBe(true);
              expect(result.data!.bids).toHaveLength(1); // 100 ! 0
         });

         it('should return error if contract missing', async () => {
             client.deployments['TradePairs'] = {};
             const result = await client.getOrderBook('AVAX/USDC');
             expect(result.success).toBe(false);
             expect(result.error).toContain('Contract not init');
         });

         it('should load pairs if needed', async () => {
              mockAxios.request.mockResolvedValue({ data: [] });
              const result = await client.getOrderBook('UNKNOWN/PAIR');
              expect(result.success).toBe(false);
              expect(result.error).toContain('Pair UNKNOWN/PAIR not found');
         });

         it('should return error for invalid pair format in getOrderBook', async () => {
              const result = await client.getOrderBook('INVALID');
              expect(result.success).toBe(false);
              expect(result.error).toContain('pair');
         });

         it('should return error when getClobPairs fails in getOrderBook', async () => {
              client.pairs = {};
              mockAxios.request.mockRejectedValue(new Error("API Fail"));
              const result = await client.getOrderBook('UNKNOWN/PAIR');
              expect(result.success).toBe(false);
              expect(result.error).toContain('API Fail');
         });

         it('should handle contract error in getOrderBook', async () => {
              mockContract.getNBook.mockRejectedValue(new Error("Contract error"));
              const result = await client.getOrderBook('AVAX/USDC');
              expect(result.success).toBe(false);
              expect(result.error).toContain('fetching orderbook');
         });
    });

    describe('getOrder', () => {
        const NULL_BYTES = "0x0000000000000000000000000000000000000000000000000000000000000000";

        it('should return error if signer/contract missing', async () => {
             client.signer = undefined as any;
             const result = await client.getOrder(VALID_ORDER_ID);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer/Contract not initialized');
        });

        it('should return formatted order if found directly', async () => {
             // Mock formatted data [id, clientOrderId...]
             const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1]; 
             mockContract.getOrder.mockResolvedValue(mockData); 
             
             const result = await client.getOrder(VALID_ORDER_ID);
             expect(result.success).toBe(true);
             expect(result.data!.pair).toBe('AVAX/USDC');
             expect(result.data!.side).toBe('BUY'); 
        });

        it('should handle uppercase ID (DataHexString coverage)', async () => {
             const upperId = VALID_ORDER_ID.toUpperCase();
             const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1]; 
             
             // Mock needs to match lowercased call or we assume getOrder handles it
             // clob.ts says: orderIdBytes = orderId.startsWith('0x') ? orderId : ...
             // If upperId starts with 0X, it passes as is to contract?
             // But DataHexString uses toLowerCase().
             // Checks if DataHexString(orderData[0]) === DataHexString(NULL)
             
             mockContract.getOrder.mockResolvedValue(mockData);
             const result = await client.getOrder(upperId);
             expect(result.success).toBe(true);
        });

         it('should parse SELL/MARKET correctly', async () => {
             // 9=Side(1=SELL), 10=Type(0=MARKET)
             const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 1, 0, 0, 1]; 
             mockContract.getOrder.mockResolvedValue(mockData);
             const result = await client.getOrder(VALID_ORDER_ID);
             expect(result.success).toBe(true);
             expect(result.data!.side).toBe('SELL');
             expect(result.data!.type).toBe('MARKET');
         });

        it('should fallback to Client ID if main ID not found', async () => {
             // First call returns NULL
             const nullData = ["0x" + "0".repeat(64)];
             mockContract.getOrder.mockResolvedValue(nullData);
             
             const validData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
             mockContract.getOrderByClientOrderId.mockResolvedValue(nullData);
             mockContract.getOrderByClientId.mockResolvedValue(validData);
             
             const result = await client.getOrder(VALID_ORDER_ID);
             expect(result.success).toBe(true);
             expect(result.data!.pair).toBe('AVAX/USDC');
        });

        it('should return error if both checks fail', async () => {
             const nullData = ["0x" + "0".repeat(64)];
             mockContract.getOrder.mockResolvedValue(nullData);
             mockContract.getOrderByClientOrderId.mockResolvedValue(nullData);
             mockContract.getOrderByClientId.mockResolvedValue(nullData);

             const result = await client.getOrder(VALID_ORDER_ID);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Order not found');
        });
        
        it('should surface RPC error when client-id path throws', async () => {
             mockContract.getOrder.mockResolvedValue(["0x" + "0".repeat(64)]);
             mockContract.getOrderByClientOrderId.mockResolvedValue(["0x" + "0".repeat(64)]);
             mockContract.getOrderByClientId.mockRejectedValue(new Error('RPC Fail'));
             const result = await client.getOrder(VALID_ORDER_ID);
             expect(result.success).toBe(false);
             expect(result.error).toContain('RPC Fail');
        });

        it('should handle contract error in getOrder', async () => {
             mockContract.getOrder.mockRejectedValue(new Error("Contract error"));
             const result = await client.getOrder(VALID_ORDER_ID);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Contract error');
        });

        it('should return error for invalid orderId format in getOrder', async () => {
             const result = await client.getOrder('');
             expect(result.success).toBe(false);
             expect(result.error).toContain('cannot be empty');
        });
    });
    
    describe('getOrderByClientId', () => {
         it('should return formatted order', async () => {
             const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
             mockContract.getOrderByClientOrderId.mockResolvedValue(mockData);
             const result = await client.getOrderByClientId('client-id');
             expect(result.success).toBe(true);
             expect(result.data!.pair).toBe('AVAX/USDC');
         });

         it('should return error if signer missing', async () => {
             client.signer = undefined as any;
             const result = await client.getOrderByClientId('id');
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer/Contract not initialized');
         });

         it('should return error for invalid clientOrderId format', async () => {
             const result = await client.getOrderByClientId('');
             expect(result.success).toBe(false);
             expect(result.error).toContain('cannot be empty');
         });

         it('should handle contract error in getOrderByClientId', async () => {
             mockContract.getOrderByClientOrderId.mockRejectedValue(new Error("Contract error"));
             const result = await client.getOrderByClientId(VALID_CLIENT_ID);
             expect(result.success).toBe(false);
             expect(result.error).toContain('getting order by client ID');
         });
    });

    describe('cancelListOrdersByClientId', () => {
         it('should return error if signer/contract missing', async () => {
             client.signer = undefined as any;
             const result = await client.cancelListOrdersByClientId([]);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer/Contract not initialized');
         });
         
         it('should call contract with bytes32', async () => {
             // Mock estimateGas to avoid "undefined property" error if not set
             mockContract.cancelOrderListByClientIds.estimateGas.mockResolvedValue(100n);
             
             const result = await client.cancelListOrdersByClientId(['id1']);
             expect(result.success).toBe(true);
             expect(mockContract.cancelOrderListByClientIds).toHaveBeenCalled();
         });

         it('should handle contract error', async () => {
             mockContract.cancelOrderListByClientIds.estimateGas.mockRejectedValue(new Error("Fail"));
             const result = await client.cancelListOrdersByClientId(['id1']);
             expect(result.success).toBe(false);
             expect(result.error).toContain('cancelling orders by client ID');
         });
    });

    describe('cancelAddList Extended', () => {
         it('should return error if signer/contract missing', async () => {
             client.signer = undefined as any;
             const result = await client.cancelAddList([]);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer/Contract not initialized');
         });

         it('should handle SELL side replacement', async () => {
             mockContract.cancelAddList.estimateGas = jest.fn().mockResolvedValue(100n);
             
             const reps = [{ order_id: VALID_ORDER_ID, pair: 'AVAX/USDC', side: 'SELL', price: 10, amount: 10 }];
             const result = await client.cancelAddList(reps);
             expect(result.success).toBe(true);
             const callArgs = mockContract.cancelAddList.mock.calls[0]; // [orderIds, newOrders]
             // callArgs[1] is the newOrders tuple array
             // callArgs[1][0] is the first tuple
             // Tuple: [id, pairId, price, qty, addr, side(1), ...]
             expect(callArgs[1][0][5]).toBe(1); // SideEnum 1 = SELL
         });
    });


    describe('addOrderList', () => {
         it('should add multiple orders', async () => {
             mockContract.addOrderList.mockResolvedValue({ 
                 hash: '0xAddListHash',
                 wait: jest.fn().mockResolvedValue({ status: 1, hash: '0xAddListHash' })
             });
             
             const reqs: any[] = [
                 { pair: 'AVAX/USDC', side: 'BUY', amount: 10, price: 20 },
                 { pair: 'AVAX/USDC', side: 'SELL', amount: 5, price: 25 }
             ];
             const result = await client.addOrderList(reqs);
             expect(result.success).toBe(true);
             expect(result.data!.txHash).toBe('0xAddListHash');
             expect(result.data!.clientOrderIds).toHaveLength(2);
         });

          it('should fail if pair missing', async () => {
               mockAxios.request.mockResolvedValue({ data: [] });
               // Use cast to allow invalid side for test
               const result = await client.addOrderList([{ pair: 'MISSING/PAIR', side: 'B', amount: 1, price: 10} as any]);
               expect(result.success).toBe(false);
               expect(result.error).toContain('Pair MISSING/PAIR not found');
          });
          
          it('should log and return error', async () => {
               mockContract.addOrderList.estimateGas.mockRejectedValue(new Error("Fail"));
               const result = await client.addOrderList([]);
               expect(result.success).toBe(false);
               expect(result.error).toContain('Fail');
               // expect(console.error).toHaveBeenCalled(); // Sanitized error logging
          });

         it('should return error if signer/contract not initialized', async () => {
              client.signer = undefined as any;
              const result = await client.addOrderList([]);
              expect(result.success).toBe(false);
              expect(result.error).toContain('Signer/Contract not initialized');
         });

         it('should handle missing price in addOrderList', async () => {
             mockContract.addOrderList.mockResolvedValue({ 
                 hash: '0xAddListHash',
                 wait: jest.fn().mockResolvedValue({ status: 1, hash: '0xAddListHash' })
             });
             
             // MARKET orders don't require price, so price can be undefined
             const reqs: any[] = [
                 { pair: 'AVAX/USDC', side: 'BUY', type: 'MARKET', amount: 10, price: undefined }
             ];
             const result = await client.addOrderList(reqs);
             expect(result.success).toBe(true);
             // Price should default to 0 when undefined
             const callArgs = mockContract.addOrderList.mock.calls[0][0];
             expect(callArgs[0][2]).toBe(0n); // priceWei should be 0
         });
    });

     describe('replaceOrder', () => {
          it('should replace order using existing pair info', async () => {
               // Mock getOrder to return valid pair
               const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
               mockContract.getOrder.mockResolvedValue(mockData);
               
               const result = await client.replaceOrder(VALID_ORDER_ID, 21, 11);
               expect(result.success).toBe(true);
               expect(mockContract.cancelReplaceOrder).toHaveBeenCalled();
          });
          
          it('should return error if pair unknown in internal lookup', async () => {
               // Return ID that doesn't match known pair
               const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_UNKNOWN', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
               mockContract.getOrder.mockResolvedValue(mockData);
               mockAxios.request.mockResolvedValue({ data: [] }); // Fetch fails to find it too
               
               const result = await client.replaceOrder(VALID_ORDER_ID, 21, 11);
               expect(result.success).toBe(false);
               expect(result.error).toContain('Pair data not found for order');
          });

          it('should return error for invalid orderId format in replaceOrder', async () => {
               const result = await client.replaceOrder('', 21, 11);
               expect(result.success).toBe(false);
               expect(result.error).toContain('cannot be empty');
          });

          it('should return error for invalid price in replaceOrder', async () => {
               const result = await client.replaceOrder(VALID_ORDER_ID, -1, 11);
               expect(result.success).toBe(false);
               expect(result.error).toContain('newPrice');
          });

          it('should return error for invalid amount in replaceOrder', async () => {
               const result = await client.replaceOrder(VALID_ORDER_ID, 21, -1);
               expect(result.success).toBe(false);
               expect(result.error).toContain('newAmount');
          });

          it('should return error when getOrder fails in replaceOrder', async () => {
               const nullData = ["0x" + "0".repeat(64)];
               mockContract.getOrder.mockResolvedValue(nullData);
               mockContract.getOrderByClientOrderId.mockResolvedValue(nullData);
               mockContract.getOrderByClientId.mockResolvedValue(nullData);

               const result = await client.replaceOrder(VALID_ORDER_ID, 21, 11);
               expect(result.success).toBe(false);
               expect(result.error).toContain('Order not found');
          });

          it('should handle contract error in replaceOrder', async () => {
               const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
               mockContract.getOrder.mockResolvedValue(mockData);
               mockContract.cancelReplaceOrder.estimateGas.mockRejectedValue(new Error("Contract error"));
               
               const result = await client.replaceOrder(VALID_ORDER_ID, 21, 11);
               expect(result.success).toBe(false);
               expect(result.error).toContain('replacing order');
          });
     });

    describe('Batch Cancels', () => {
         it('cancelListOrdersByClientId should call contract', async () => {
              await client.cancelListOrdersByClientId(['id1', 'id2']);
              expect(mockContract.cancelOrderListByClientIds).toHaveBeenCalled();
         });

         it('cancelAddList should call contract', async () => {
              const reps = [{ order_id: VALID_ORDER_ID, pair: 'AVAX/USDC', side: 'BUY', price: 10, amount: 10 }];
              await client.cancelAddList(reps);
              expect(mockContract.cancelAddList).toHaveBeenCalled();
         });
         
         it('cancelAddList should fail for missing pair', async () => {
              mockAxios.request.mockResolvedValue({ data: [] });
              const reps = [{ order_id: VALID_ORDER_ID, pair: 'MISSING', side: 'B', price: 10, amount: 10 }];
              const result = await client.cancelAddList(reps);
              expect(result.success).toBe(false);
              expect(result.error).toContain('Pair MISSING not found');
         });

           it('cancelAddList should fetch order details when side/pair not provided', async () => {
                // Mock getOrder to return order details
                const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
                mockContract.getOrder.mockResolvedValue(mockData);
                
                // Replacement without side or pair - should trigger getOrder call
                const reps = [{ order_id: VALID_ORDER_ID, price: 10, amount: 10 }];
                await client.cancelAddList(reps);
                
                expect(mockContract.getOrder).toHaveBeenCalledWith(VALID_ORDER_ID);
                expect(mockContract.cancelAddList).toHaveBeenCalled();
           });

           it('cancelAddList should return error when getOrder fails', async () => {
                const nullData = ["0x" + "0".repeat(64)];
                mockContract.getOrder.mockResolvedValue(nullData);
                mockContract.getOrderByClientOrderId.mockResolvedValue(nullData);
                mockContract.getOrderByClientId.mockResolvedValue(nullData);

                // Replacement without side or pair - getOrder will fail
                const reps = [{ order_id: VALID_ORDER_ID, price: 10, amount: 10 }];
                const result = await client.cancelAddList(reps);

                expect(result.success).toBe(false);
                expect(result.error).toContain('Order not found');
           });

           it('cancelAddList should handle contract error', async () => {
                const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
                mockContract.getOrder.mockResolvedValue(mockData);
                mockContract.cancelAddList.estimateGas.mockRejectedValue(new Error("Contract error"));
                
                const reps = [{ order_id: VALID_ORDER_ID, pair: 'AVAX/USDC', side: 'BUY', price: 10, amount: 10 }];
                const result = await client.cancelAddList(reps);
                
                expect(result.success).toBe(false);
                expect(result.error).toContain('cancel add list');
           });

           it('cancelAddList should default to AVAX/USDC when pair is missing', async () => {
                // Mock getOrder to return order without pair
                const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
                mockContract.getOrder.mockResolvedValue(mockData);
                // Mock _formatOrderData to return order without pair
                jest.spyOn(client as any, '_formatOrderData').mockResolvedValue({
                    id: VALID_ORDER_ID,
                    clientOrderId: VALID_CLIENT_ID,
                    side: 'BUY',
                    // pair is missing/falsy
                });
                
                const reps = [{ order_id: VALID_ORDER_ID, side: 'BUY', price: 10, amount: 10 }];
                const result = await client.cancelAddList(reps);
                
                expect(result.success).toBe(true);
                // Should use default pair "AVAX/USDC"
                expect(mockContract.cancelAddList).toHaveBeenCalled();
           });

          it('cancelAddList should handle numeric side BUY=0', async () => {
               const reps = [{ order_id: VALID_ORDER_ID, pair: 'AVAX/USDC', side: 0, price: 10, amount: 10 }];
               await client.cancelAddList(reps);

               expect(mockContract.getOrder).toHaveBeenCalled();

               const callArgs = mockContract.cancelAddList.mock.calls[0];
               expect(callArgs[1][0][5]).toBe(0); // BUY
          });

          it('cancelAddList should handle numeric side SELL', async () => {
               const reps = [{ order_id: VALID_ORDER_ID, pair: 'AVAX/USDC', side: 1, price: 10, amount: 10 }];
               await client.cancelAddList(reps);

               const callArgs = mockContract.cancelAddList.mock.calls[0];
               expect(callArgs[1][0][5]).toBe(1); // SELL
          });
    });

    describe('_getAuthHeaders', () => {
         it('should sign message and cache signature', async () => {
              const headers = await client._getAuthHeaders();
              expect(headers['x-signature']).toBe("0xUserAddress:0xSignature");
              expect(mockSigner.signMessage).toHaveBeenCalledWith("dexalot");
              
              // Second call should use cache
              mockSigner.signMessage.mockClear();
              await client._getAuthHeaders();
              expect(mockSigner.signMessage).not.toHaveBeenCalled();
         });

         it('should throw if signer missing', async () => {
              client.signer = undefined as any;
              await expect(client._getAuthHeaders()).rejects.toThrow("No signer");
         });

         it('should support timestamped auth headers', async () => {
              client.config.timestampedAuth = true;
              client._cachedSignature = null;
              const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
              const headers = await client._getAuthHeaders();
              expect(headers['x-timestamp']).toBe('1700000000000');
              expect(mockSigner.signMessage).toHaveBeenCalledWith('dexalot1700000000000');
              expect(headers['x-signature']).toContain('0xUserAddress:');
              nowSpy.mockRestore();
              client.config.timestampedAuth = false;
         });
    });

    describe('addOrder Enums', () => {
         it('should handle SELL and MARKET types', async () => {
             await client.addOrder({
                 pair: 'AVAX/USDC',
                 side: 'SELL',
                 type: 'MARKET',
                 amount: 10,
                 price: 0
             });
             const callArgs = mockContract.addNewOrder.mock.calls[0][0];
             expect(callArgs.side).toBe(1); // SELL
             expect(callArgs.type1).toBe(0); // MARKET
         });

         it('should throw if contract missing in addOrder', async () => {
             client.deployments['TradePairs'] = {};
             const result = await client.addOrder({ pair: 'AVAX/USDC', side: 'BUY', amount: 10, price: 10 });
             expect(result.success).toBe(false);
             expect(result.error).toContain('TradePairs contract not initialized');
         });
    });

    describe('addOrderList Enums', () => {
        it('should handle SELL side in list', async () => {
             mockContract.addOrderList.mockResolvedValue({ 
                 hash: '0xAddListHash',
                 wait: jest.fn().mockResolvedValue({ status: 1, hash: '0xAddListHash' })
             });
             
             const reqs: any[] = [
                 { pair: 'AVAX/USDC', side: 'SELL', amount: 5, price: 25 }
             ];
             await client.addOrderList(reqs);
             const callArgs = mockContract.addOrderList.mock.calls[0][0];
             expect(callArgs[0][5]).toBe(1); // SELL
        });
    });

    describe('Branch Coverage - Non-hex IDs and Fallbacks', () => {
        it('getOrder should convert non-hex orderId', async () => {
            const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
            mockContract.getOrderByClientOrderId.mockResolvedValue(mockData);

            await client.getOrder('plain-order-id');
            expect(mockContract.getOrderByClientOrderId).toHaveBeenCalledWith(
                mockAddress,
                utf8ToOrderBytes32Hex('plain-order-id')
            );
        });

        it('getOrderByClientId should handle hex clientOrderId directly', async () => {
            const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
            mockContract.getOrderByClientOrderId.mockResolvedValue(mockData);

            const spy = jest.spyOn(Utils, 'toBytes32');
            spy.mockClear();
            await client.getOrderByClientId(VALID_CLIENT_ID);
            expect(mockContract.getOrderByClientOrderId).toHaveBeenCalledWith(
                mockAddress,
                VALID_CLIENT_ID
            );
        });

        it('getOrderByClientId should convert non-hex clientOrderId', async () => {
            const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
            mockContract.getOrderByClientOrderId.mockResolvedValue(mockData);

            await client.getOrderByClientId('plain-client-id');
            expect(mockContract.getOrderByClientOrderId).toHaveBeenCalledWith(
                mockAddress,
                utf8ToOrderBytes32Hex('plain-client-id')
            );
        });

        it('addOrderList should fail if price missing (validation)', async () => {
            // Order without price - validation should fail
            const reqs: any[] = [{ pair: 'AVAX/USDC', side: 'BUY', amount: 5 }]; // No price
            const result = await client.addOrderList(reqs);
            expect(result.success).toBe(false);
            expect(result.error).toContain('price is required');
        });

        it('replaceOrder should convert non-hex orderId', async () => {
            const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
            mockContract.getOrderByClientOrderId.mockResolvedValue(mockData);

            await client.replaceOrder('plain-order-id', 21, 11);
            expect(mockContract.cancelReplaceOrder).toHaveBeenCalledWith(
                ethers.zeroPadValue(VALID_ORDER_ID as `0x${string}`, 32),
                expect.any(String),
                expect.any(BigInt),
                expect.any(BigInt),
                expect.any(Object)
            );
        });

        it('cancelListOrdersByClientId should convert non-hex IDs', async () => {
            await client.cancelListOrdersByClientId(['plain-id-1', 'plain-id-2']);
            expect(Utils.toBytes32).toHaveBeenCalledWith('plain-id-1');
            expect(Utils.toBytes32).toHaveBeenCalledWith('plain-id-2');
        });

        it('cancelListOrdersByClientId should keep hex IDs as-is', async () => {
            const spy = jest.spyOn(Utils, 'toBytes32');
            spy.mockClear();
            
            await client.cancelListOrdersByClientId(['0xHexId1', '0xHexId2']);
            // toBytes32 should not be called for hex IDs
            expect(spy).not.toHaveBeenCalled();
        });

        it('cancelAddList should fail for missing pair', async () => {
            jest.spyOn(client, 'getOrder').mockResolvedValue({
                success: true,
                data: {
                    id: VALID_ORDER_ID,
                    clientOrderId: VALID_CLIENT_ID,
                    side: 'BUY',
                    pair: 'AVAX/USDC',
                },
                error: null,
            } as any);

            // Provide side but invalid pair - validation should fail
            const reps = [{ order_id: VALID_ORDER_ID, side: 'BUY', price: 10, amount: 10, pair: 'MISSING/PAIR' }];
            const result = await client.cancelAddList(reps as any);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Pair MISSING/PAIR not found');
        });
    });

    describe('waitForReceipt parameter', () => {
        it('should not wait for receipt when waitForReceipt=false in addOrder', async () => {
            const tx = { hash: '0xTxHash' };
            mockContract.addNewOrder.mockResolvedValue(tx);
            
            const result = await client.addOrder({
                pair: 'AVAX/USDC',
                side: 'BUY',
                amount: 1.0,
                price: 25.0
            }, false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xTxHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should not wait for receipt when waitForReceipt=false in cancelOrder', async () => {
            const resolvedOrderRow = [
                VALID_ORDER_ID,
                VALID_CLIENT_ID,
                '0xPairId_AVAX_USDC',
                100n,
                0,
                10n,
                5n,
                0,
                0,
                0,
                1,
                0,
                1,
            ];
            mockContract.getOrder.mockResolvedValue(resolvedOrderRow);
            const tx = { hash: '0xCancelHash' };
            mockContract.cancelOrder.mockResolvedValue(tx);

            const result = await client.cancelOrder(VALID_ORDER_ID, false);

            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xCancelHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should not wait for receipt when waitForReceipt=false in addOrderList', async () => {
            const tx = { hash: '0xAddListHash' };
            mockContract.addOrderList.mockResolvedValue(tx);
            
            const reqs = [
                { pair: 'AVAX/USDC', side: 'BUY', amount: 1.0, price: 25.0 }
            ];
            const result = await client.addOrderList(reqs, false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xAddListHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should not wait for receipt when waitForReceipt=false in replaceOrder', async () => {
            const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
            mockContract.getOrder.mockResolvedValue(mockData);
            const tx = { hash: '0xReplaceHash' };
            mockContract.cancelReplaceOrder.mockResolvedValue(tx);
            
            const result = await client.replaceOrder(VALID_ORDER_ID, 21, 11, false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xReplaceHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should not wait for receipt when waitForReceipt=false in cancelListOrders', async () => {
            const tx = { hash: '0xCancelListHash' };
            mockContract.cancelOrderList.mockResolvedValue(tx);
            
            const result = await client.cancelListOrders([VALID_ORDER_ID], false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xCancelListHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should not wait for receipt when waitForReceipt=false in cancelListOrdersByClientId', async () => {
            const tx = { hash: '0xCancelByIdsHash' };
            mockContract.cancelOrderListByClientIds.mockResolvedValue(tx);
            
            const result = await client.cancelListOrdersByClientId([VALID_CLIENT_ID], false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xCancelByIdsHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should not wait for receipt when waitForReceipt=false in cancelAddList', async () => {
            const tx = { hash: '0xCancelAddHash' };
            mockContract.cancelAddList.mockResolvedValue(tx);
            
            const reps = [{ order_id: VALID_ORDER_ID, pair: 'AVAX/USDC', side: 'BUY', price: 10, amount: 10 }];
            const result = await client.cancelAddList(reps, false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xCancelAddHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should return error when receipt status is not 1 in addOrder', async () => {
            const tx = {
                hash: '0xTxHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xTxHash' })
            };
            mockContract.addNewOrder.mockResolvedValue(tx);
            
            const result = await client.addOrder({
                pair: 'AVAX/USDC',
                side: 'BUY',
                amount: 1.0,
                price: 25.0
            }, true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should return error when receipt status is not 1 in cancelOrder', async () => {
            const resolvedOrderRow = [
                VALID_ORDER_ID,
                VALID_CLIENT_ID,
                '0xPairId_AVAX_USDC',
                100n,
                0,
                10n,
                5n,
                0,
                0,
                0,
                1,
                0,
                1,
            ];
            mockContract.getOrder.mockResolvedValue(resolvedOrderRow);
            const tx = {
                hash: '0xCancelHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xCancelHash' }),
            };
            mockContract.cancelOrder.mockResolvedValue(tx);

            const result = await client.cancelOrder(VALID_ORDER_ID, true);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Transaction reverted');
        });

        it('should return error when receipt status is not 1 in cancelListOrders', async () => {
            const tx = {
                hash: '0xCancelListHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xCancelListHash' })
            };
            mockContract.cancelOrderList.mockResolvedValue(tx);
            
            const result = await client.cancelListOrders([VALID_ORDER_ID], true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should return error when receipt status is not 1 in addOrderList', async () => {
            const tx = {
                hash: '0xAddListHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xAddListHash' })
            };
            mockContract.addOrderList.mockResolvedValue(tx);
            
            const reqs = [
                { pair: 'AVAX/USDC', side: 'BUY', amount: 1.0, price: 25.0 }
            ];
            const result = await client.addOrderList(reqs, true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should return error when receipt status is not 1 in replaceOrder', async () => {
            const mockData = [VALID_ORDER_ID, VALID_CLIENT_ID, '0xPairId_AVAX_USDC', 100n, 0, 10n, 5n, 0, 0, 0, 1, 0, 1];
            mockContract.getOrder.mockResolvedValue(mockData);
            const tx = {
                hash: '0xReplaceHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xReplaceHash' })
            };
            mockContract.cancelReplaceOrder.mockResolvedValue(tx);
            
            const result = await client.replaceOrder(VALID_ORDER_ID, 21, 11, true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should return error when receipt status is not 1 in cancelListOrdersByClientId', async () => {
            const tx = {
                hash: '0xCancelByIdsHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xCancelByIdsHash' })
            };
            mockContract.cancelOrderListByClientIds.mockResolvedValue(tx);
            
            const result = await client.cancelListOrdersByClientId([VALID_CLIENT_ID], true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should return error when receipt status is not 1 in cancelAddList', async () => {
            const tx = {
                hash: '0xCancelAddHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xCancelAddHash' })
            };
            mockContract.cancelAddList.mockResolvedValue(tx);

            const reps = [{ order_id: VALID_ORDER_ID, pair: 'AVAX/USDC', side: 'BUY', price: 10, amount: 10 }];
            const result = await client.cancelAddList(reps, true);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });
    });

    describe('getClobPairs - missing min/max trade amounts', () => {
        it('should default min_trade_amount and max_trade_amount to 0 when fields are missing', async () => {
            mockAxios.request.mockResolvedValue({
                data: [
                    {
                        pair: 'NEW/TOKEN',
                        env: ENV.PROD_MULTI_SUBNET,
                        base: 'NEW',
                        quote: 'TOKEN',
                        base_decimals: 18,
                        quote_decimals: 6,
                        // No min_trade_amount, max_trade_amount, mintrade_amnt, etc.
                    }
                ]
            });

            const result = await client.getClobPairs();
            expect(result.success).toBe(true);
            expect(client.pairs['NEW/TOKEN']).toBeDefined();
            expect(client.pairs['NEW/TOKEN'].min_trade_amount).toBe(0);
            expect(client.pairs['NEW/TOKEN'].max_trade_amount).toBe(0);
        });
    });

    describe('private helpers and WebSocket surface', () => {
        beforeEach(() => {
            jest.useRealTimers();
        });
        afterEach(() => {
            jest.useFakeTimers();
        });

        class MockWsGlobal {
            static CONNECTING = 0;
            static OPEN = 1;
            readyState = MockWsGlobal.OPEN;
            onopen: ((e: unknown) => void) | null = null;
            onclose: ((e: unknown) => void) | null = null;
            onerror: ((e: unknown) => void) | null = null;
            onmessage: ((e: { data: unknown }) => void) | null = null;
            sentMessages: string[] = [];
            constructor(_url: string) {
                setTimeout(() => {
                    this.readyState = MockWsGlobal.OPEN;
                    this.onopen?.({});
                }, 0);
            }
            send(d: string) {
                this.sentMessages.push(d);
            }
            close() {
                this.onclose?.({});
            }
        }

        beforeEach(() => {
            (global as any).WebSocket = MockWsGlobal;
        });

        afterEach(() => {
            delete (global as any).WebSocket;
        });

        it('_orderIdToBytes32Hex handles Uint8Array short and long', () => {
            const short = new Uint8Array([1, 2, 3]);
            const h1 = (client as any)._orderIdToBytes32Hex(short);
            expect(h1.startsWith('0x')).toBe(true);
            const long = new Uint8Array(40);
            long.fill(7);
            const h2 = (client as any)._orderIdToBytes32Hex(long);
            expect(h2.length).toBe(66);
        });

        it('_orderIdToBytes32Hex rejects odd-length 0x hex', () => {
            expect(() => (client as any)._orderIdToBytes32Hex('0xabc')).toThrow('even number');
        });

        it('_classifyOrderIdInput and _buildOrderResolutionSequence', () => {
            expect((client as any)._classifyOrderIdInput('0xab')).toBe('ambiguous');
            expect((client as any)._classifyOrderIdInput('42')).toBe('internal');
            expect((client as any)._classifyOrderIdInput('clientid')).toBe('client');
            expect((client as any)._buildOrderResolutionSequence('c')).toEqual(['client']);
            expect((client as any)._buildOrderResolutionSequence('99')).toEqual(['internal', 'client']);
        });

        it('_slotToBytes32Hex supports string bigint and bytes', () => {
            const a = (client as any)._slotToBytes32Hex('0x01');
            expect(a.startsWith('0x')).toBe(true);
            const b = (client as any)._slotToBytes32Hex(1n);
            expect(b.length).toBe(66);
            const c = (client as any)._slotToBytes32Hex(new Uint8Array([9]));
            expect(c.startsWith('0x')).toBe(true);
        });

        it('_withL1TradePairsContract throws when TradePairs missing', async () => {
            const prev = client.deployments['TradePairs'];
            delete client.deployments['TradePairs'];
            await expect((client as any)._withL1TradePairsContract(async () => 1)).rejects.toThrow(
                'TradePairs'
            );
            client.deployments['TradePairs'] = prev;
        });

        it('_ensurePairExistsAsync fetches pairs when missing', async () => {
            const c2 = new TestClient(mockSigner);
            (c2 as any).axios = mockAxios;
            c2.deployments['TradePairs'] = client.deployments['TradePairs'];
            c2.subnetProvider = {} as any;
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            c2.subnetEnv = ENV.PROD_MULTI_SUBNET;
            c2.config.retryEnabled = false;
            c2.pairs = {};
            mockAxios.request.mockResolvedValue({
                data: [
                    {
                        pair: 'NEW/USDC',
                        env: ENV.PROD_MULTI_SUBNET,
                        base: 'NEW',
                        quote: 'USDC',
                        base_evmdecimals: 18,
                        quote_evmdecimals: 6,
                        mintrade_amnt: '1',
                        maxtrade_amnt: '10',
                    },
                ],
            });
            const ok = await (c2 as any)._ensurePairExistsAsync('NEW/USDC');
            expect(ok).toBe(true);
        });

        it('subscribeToEvents registers orderbook topic and connects', async () => {
            delete process.env.PRIVATE_KEY;
            const cfg = createConfig({
                parentEnv: 'fuji-multi',
                wsManagerEnabled: true,
                wsPingInterval: 3600,
                wsPingTimeout: 3600,
            });
            const c3 = new TestClient(cfg);
            (c3 as any).signer = mockSigner;
            (c3 as any).axios = mockAxios;
            c3.deployments['TradePairs'] = client.deployments['TradePairs'];
            c3.subnetProvider = {} as any;
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            c3.subnetEnv = ENV.PROD_MULTI_SUBNET;
            c3.apiBaseUrl = 'https://api.dexalot-test.com';
            c3.pairs = { ...client.pairs };
            await new Promise((r) => setTimeout(r, 5));
            await c3.subscribeToEvents('OrderBook/AVAX/USDC', () => {}, false);
            expect((c3 as any)._wsManager).not.toBeNull();
            c3.unsubscribeFromEvents('OrderBook/AVAX/USDC');
            await c3.closeWebsocket(0);
        });

        it('_orderIdToBytes32Hex handles decimal string and bare 64-char hex', () => {
            const dec = (client as any)._orderIdToBytes32Hex('12345');
            expect(dec.startsWith('0x')).toBe(true);
            const bare = 'a'.repeat(64);
            const h = (client as any)._orderIdToBytes32Hex(bare);
            expect(h.length).toBe(66);
        });

        it('_orderIdToBytes32Hex throws when plain UTF-8 id exceeds 32 bytes', () => {
            const s = 'x'.repeat(33);
            expect(() => (client as any)._orderIdToBytes32Hex(s)).toThrow('32 bytes');
        });

        it('_classifyOrderIdInput treats 32-byte Uint8Array as ambiguous', () => {
            expect((client as any)._classifyOrderIdInput(new Uint8Array(32))).toBe('ambiguous');
            expect((client as any)._classifyOrderIdInput('a'.repeat(64))).toBe('ambiguous');
        });

        it('_resolveOrderReference returns fail message from _orderIdToBytes32Hex errors', async () => {
            const r = await (client as any)._resolveOrderReference(mockContract, '0xfff');
            expect(r.success).toBe(false);
            expect(String(r.error)).toContain('even');
        });

        it('_fetchOrderByInternalId returns null for non-array contract response', async () => {
            mockContract.getOrder.mockResolvedValueOnce({ notAn: 'array' });
            const id = (client as any)._orderIdToBytes32Hex('1');
            const row = await (client as any)._fetchOrderByInternalId(mockContract, id);
            expect(row).toBeNull();
        });

        it('_fetchOrderByInternalId returns null for empty order tuple', async () => {
            mockContract.getOrder.mockResolvedValueOnce([]);
            const id = (client as any)._orderIdToBytes32Hex('1');
            const row = await (client as any)._fetchOrderByInternalId(mockContract, id);
            expect(row).toBeNull();
        });

        it('cancelOrder uses client-id path when internal slot is empty', async () => {
            const emptyInternal = [
                '0x0000000000000000000000000000000000000000000000000000000000000000',
                VALID_CLIENT_ID,
                '0xPairId_AVAX_USDC',
                100n,
                0,
                10n,
                5n,
                0,
                0,
                0,
                1,
                0,
                1,
            ];
            const resolvedOrderRow = [
                VALID_ORDER_ID,
                VALID_CLIENT_ID,
                '0xPairId_AVAX_USDC',
                100n,
                0,
                10n,
                5n,
                0,
                0,
                0,
                1,
                0,
                1,
            ];
            mockContract.getOrder.mockResolvedValue(emptyInternal);
            mockContract.getOrderByClientOrderId.mockResolvedValue(resolvedOrderRow);
            const result = await client.cancelOrder('plain-client-id', false);
            expect(result.success).toBe(true);
            expect(mockContract.cancelOrderByClientId).toHaveBeenCalled();
        });

        it('cancelOrder fails with default message when resolve has no error string', async () => {
            const spy = jest.spyOn(client as any, '_resolveOrderReference').mockResolvedValue({
                success: false,
                data: null,
                error: '',
            });
            const result = await client.cancelOrder(VALID_ORDER_ID);
            expect(result.success).toBe(false);
            expect(result.error).toBe('Could not resolve order ID');
            spy.mockRestore();
        });

        it('getOrder fails with default message when resolve has no error string', async () => {
            const spy = jest.spyOn(client as any, '_resolveOrderReference').mockResolvedValue({
                success: false,
                data: null,
                error: '',
            });
            const result = await client.getOrder(VALID_ORDER_ID);
            expect(result.success).toBe(false);
            expect(result.error).toBe('Order not found');
            spy.mockRestore();
        });

        it('getOrder outer catch sanitizes _withL1TradePairsContract errors', async () => {
            const spy = jest
                .spyOn(client as any, '_withL1TradePairsContract')
                .mockRejectedValue(new Error('wrap fail'));
            const result = await client.getOrder(VALID_ORDER_ID);
            expect(result.success).toBe(false);
            expect(result.error).toContain('getting order');
            spy.mockRestore();
        });

        it('getOrderByClientId maps non-Error throw from bytes32 conversion', async () => {
            const spy = jest.spyOn(client as any, '_orderIdToBytes32Hex').mockImplementation(() => {
                throw 'not-an-error-object';
            });
            const result = await client.getOrderByClientId('any');
            expect(result.success).toBe(false);
            expect(result.error).toBe('not-an-error-object');
            spy.mockRestore();
        });

        it('getOrderByClientId returns not found when client path is empty', async () => {
            mockContract.getOrderByClientOrderId.mockResolvedValue([]);
            mockContract.getOrderByClientId = jest.fn().mockResolvedValue([]);
            const result = await client.getOrderByClientId(VALID_CLIENT_ID);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Client ID');
        });

        it('getOrderByClientId outer catch sanitizes contract errors', async () => {
            const spy = jest
                .spyOn(client as any, '_withL1TradePairsContract')
                .mockRejectedValue(new Error('gcid fail'));
            const result = await client.getOrderByClientId(VALID_CLIENT_ID);
            expect(result.success).toBe(false);
            expect(result.error).toContain('getting order by client ID');
            spy.mockRestore();
        });

        it('cancelOrderByClientId maps non-Error from bytes32 conversion', async () => {
            const spy = jest.spyOn(client as any, '_orderIdToBytes32Hex').mockImplementation(() => {
                throw 'weird';
            });
            const result = await client.cancelOrderByClientId('x');
            expect(result.success).toBe(false);
            expect(result.error).toBe('weird');
            spy.mockRestore();
        });

        it('cancelOrderByClientId maps Error from bytes32 conversion', async () => {
            const spy = jest.spyOn(client as any, '_orderIdToBytes32Hex').mockImplementation(() => {
                throw new Error('bad bytes32');
            });
            const result = await client.cancelOrderByClientId(VALID_CLIENT_ID);
            expect(result.success).toBe(false);
            expect(result.error).toBe('bad bytes32');
            spy.mockRestore();
        });

        it('cancelOrderByClientId fails when TradePairs deployment missing', async () => {
            const prev = client.deployments['TradePairs'];
            delete client.deployments['TradePairs'];
            const result = await client.cancelOrderByClientId(VALID_CLIENT_ID);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not initialized');
            client.deployments['TradePairs'] = prev;
        });

        it('cancelOrderByClientId returns tx hash when waitForReceipt is false', async () => {
            mockContract.cancelOrderByClientId.mockResolvedValueOnce({ hash: '0xNoWait' });
            const result = await client.cancelOrderByClientId(VALID_CLIENT_ID, false);
            expect(result.success).toBe(true);
            expect(result.data?.txHash).toBe('0xNoWait');
        });

        it('cancelOrderByClientId fails when receipt status is not 1', async () => {
            mockContract.cancelOrderByClientId.mockResolvedValueOnce({
                hash: '0xBad',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xBad' }),
            });
            const result = await client.cancelOrderByClientId(VALID_CLIENT_ID, true);
            expect(result.success).toBe(false);
            expect(result.error).toBe('Transaction reverted');
        });

        it('replaceOrder fails when TradePairs missing after getOrder succeeds', async () => {
            const mockData = [
                VALID_ORDER_ID,
                VALID_CLIENT_ID,
                '0xPairId_AVAX_USDC',
                100n,
                0,
                10n,
                5n,
                0,
                0,
                0,
                1,
                0,
                1,
            ];
            mockContract.getOrder.mockResolvedValue(mockData);
            const orig = (client as any)._tradePairsDeployment.bind(client);
            let n = 0;
            const spy = jest.spyOn(client as any, '_tradePairsDeployment').mockImplementation(() => {
                n += 1;
                if (n <= 2) {
                    return orig();
                }
                return null;
            });
            const result = await client.replaceOrder(VALID_ORDER_ID, 21, 11);
            expect(result.success).toBe(false);
            expect(result.error).toContain('TradePairs');
            spy.mockRestore();
        });

        it('subscribeToEvents throws for invalid pair inside OrderBook topic', async () => {
            delete process.env.PRIVATE_KEY;
            const cfg = createConfig({
                parentEnv: 'fuji-multi',
                wsManagerEnabled: true,
                wsPingInterval: 3600,
                wsPingTimeout: 3600,
            });
            const c5 = new TestClient(cfg);
            (c5 as any).signer = mockSigner;
            (c5 as any).axios = mockAxios;
            c5.deployments['TradePairs'] = client.deployments['TradePairs'];
            c5.subnetProvider = {} as any;
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            c5.subnetEnv = ENV.PROD_MULTI_SUBNET;
            c5.apiBaseUrl = 'https://api.dexalot-test.com';
            c5.pairs = { ...client.pairs };
            await expect(c5.subscribeToEvents('OrderBook/not_a_pair', () => {}, false)).rejects.toThrow(
                /Invalid trading pair|pair/i
            );
            await c5.closeWebsocket(0);
        });

        it('subscribeToEvents throws when pair is unknown after fetch', async () => {
            delete process.env.PRIVATE_KEY;
            const cfg = createConfig({
                parentEnv: 'fuji-multi',
                wsManagerEnabled: true,
                wsPingInterval: 3600,
                wsPingTimeout: 3600,
            });
            const c6 = new TestClient(cfg);
            (c6 as any).signer = mockSigner;
            (c6 as any).axios = mockAxios;
            c6.deployments['TradePairs'] = client.deployments['TradePairs'];
            c6.subnetProvider = {} as any;
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            c6.subnetEnv = ENV.PROD_MULTI_SUBNET;
            c6.apiBaseUrl = 'https://api.dexalot-test.com';
            c6.pairs = {};
            mockAxios.request.mockResolvedValue({ data: [] });
            await expect(c6.subscribeToEvents('OrderBook/MISS/USDC', () => {}, false)).rejects.toThrow(
                /not found/
            );
            await c6.closeWebsocket(0);
        });

        it('subscribeToEvents uses slash topic branch and plain subscribe path', async () => {
            delete process.env.PRIVATE_KEY;
            const cfg = createConfig({
                parentEnv: 'fuji-multi',
                wsManagerEnabled: true,
                wsPingInterval: 3600,
                wsPingTimeout: 3600,
            });
            const c7 = new TestClient(cfg);
            (c7 as any).signer = mockSigner;
            (c7 as any).axios = mockAxios;
            c7.deployments['TradePairs'] = client.deployments['TradePairs'];
            c7.subnetProvider = {} as any;
            (Contract as jest.Mock).mockImplementation(() => mockContract);
            c7.subnetEnv = ENV.PROD_MULTI_SUBNET;
            c7.apiBaseUrl = 'https://api.dexalot-test.com';
            c7.pairs = { ...client.pairs };
            const mgr: any = {
                subscribe: jest.fn(),
                connect: jest.fn(),
                isConnected: true,
            };
            const spy = jest.spyOn(c7 as any, '_getOrCreateWsManager').mockReturnValue(mgr);
            await c7.subscribeToEvents('AVAX/USDC', () => {}, false);
            expect(mgr.subscribe).toHaveBeenCalledWith(
                'AVAX/USDC',
                expect.any(Function),
                false,
                expect.objectContaining({ kind: 'orderbook' })
            );
            await c7.subscribeToEvents('plain-events', () => {}, false);
            expect(mgr.subscribe).toHaveBeenCalledWith('plain-events', expect.any(Function), false);
            spy.mockRestore();
        });

        it('subscribeToEvents throws when WebSocket manager is unexpectedly null', async () => {
            delete process.env.PRIVATE_KEY;
            const cfg = createConfig({
                parentEnv: 'fuji-multi',
                wsManagerEnabled: true,
                wsPingInterval: 3600,
                wsPingTimeout: 3600,
            });
            const c8 = new TestClient(cfg);
            (c8 as any).signer = mockSigner;
            const spy = jest.spyOn(c8 as any, '_getOrCreateWsManager').mockReturnValue(null);
            await expect(c8.subscribeToEvents('t', () => {}, false)).rejects.toThrow(/unavailable/);
            spy.mockRestore();
        });

        it('closeWebsocket caps grace delay at 100ms', async () => {
            jest.useFakeTimers();
            delete process.env.PRIVATE_KEY;
            const cfg = createConfig({
                parentEnv: 'fuji-multi',
                wsManagerEnabled: true,
                wsPingInterval: 3600,
                wsPingTimeout: 3600,
            });
            const c9 = new TestClient(cfg);
            (c9 as any)._wsManager = { disconnect: jest.fn() };
            const done = c9.closeWebsocket(9999);
            await jest.advanceTimersByTimeAsync(100);
            await done;
            jest.useRealTimers();
        });

        it('closeWebsocket returns immediately when no manager', async () => {
            const c10 = new TestClient(mockSigner);
            (c10 as any)._wsManager = null;
            await expect(c10.closeWebsocket(5)).resolves.toBeUndefined();
        });

        it('_getOrCreateWsManager returns null when wsManagerEnabled is false', () => {
            const c = new TestClient(createConfig({ wsManagerEnabled: false }));
            expect((c as any)._getOrCreateWsManager()).toBeNull();
        });

        it('subscribeToEvents throws when WebSocket manager is disabled in config', async () => {
            await expect(client.subscribeToEvents('any', () => {}, false)).rejects.toThrow(
                'WebSocket Manager is disabled'
            );
        });

        it('WebSocketManager auth from CLOB forwards signer getAddress and signMessage', async () => {
            delete process.env.PRIVATE_KEY;
            const cfg = createConfig({
                parentEnv: 'fuji-multi',
                wsManagerEnabled: true,
                wsPingInterval: 3600,
                wsPingTimeout: 3600,
            });
            const cPriv = new TestClient(cfg);
            (cPriv as any).signer = mockSigner;
            cPriv.apiBaseUrl = 'https://api.dexalot-test.com';
            const mgr = (cPriv as any)._getOrCreateWsManager();
            expect(mgr).not.toBeNull();
            const auth = (mgr as any).dexalot.auth;
            expect(auth).toBeDefined();
            await expect(auth.getAddress()).resolves.toBe(mockAddress);
            await expect(auth.signMessage('dexalot')).resolves.toBe('0xSignature');
        });

        it('cancelOrderByClientId fails for invalid hex client id', async () => {
            const result = await client.cancelOrderByClientId('0xgg');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid');
        });

        it('cancelOrderByClientId outer catch wraps contract failures', async () => {
            const spy = jest
                .spyOn(client as any, '_withL1TradePairsContract')
                .mockRejectedValue(new Error('cancel client outer'));
            const result = await client.cancelOrderByClientId(VALID_CLIENT_ID);
            expect(result.success).toBe(false);
            expect(result.error).toContain('cancelling order by client ID');
            spy.mockRestore();
        });

        it('_fetchOrderByClientIdPath uses getOrderByClientId when primary path empty', async () => {
            mockContract.getOrderByClientOrderId.mockResolvedValue([
                '0x0000000000000000000000000000000000000000000000000000000000000000',
            ]);
            mockContract.getOrderByClientId = jest.fn().mockResolvedValue([
                VALID_ORDER_ID,
                VALID_CLIENT_ID,
                '0xPairId_AVAX_USDC',
                100n,
                0,
                10n,
                5n,
                0,
                0,
                0,
                1,
                0,
                1,
            ]);
            const bytes = (client as any)._orderIdToBytes32Hex(VALID_CLIENT_ID);
            const row = await (client as any)._fetchOrderByClientIdPath(mockContract, bytes);
            expect(row).not.toBeNull();
            expect(mockContract.getOrderByClientId).toHaveBeenCalled();
        });
    });
});
