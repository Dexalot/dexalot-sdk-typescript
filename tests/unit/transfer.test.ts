
import { TransferClient } from '../../src/core/transfer';
import { Utils } from '../../src/utils';
import { DexalotClient } from '../../src/core/client';
import { ethers, Contract, MaxUint256 } from 'ethers';
import { ENV, DEFAULTS } from '../../src/constants';

// Mock everything
jest.mock('ethers');
jest.mock('../../src/utils');

// We need a concrete class to test the class
class TestClient extends TransferClient {}

describe('TransferClient', () => {
    let client: TestClient;
    let mockSigner: any;
    let mockContract: any;
    let mockProvider: any;

    const mockAddress = '0xUserAddress';
    const mockToken = 'AVAX';
    const mockTokenAddr = '0xAvaxTokenAddr';

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup Signer
        mockSigner = {
            getAddress: jest.fn().mockResolvedValue(mockAddress),
            provider: { getBalance: jest.fn().mockResolvedValue(1000n) }
        };

        // Setup Contract Mock
        mockContract = {
            getAddress: jest.fn().mockResolvedValue('0xContractAddress'),
            getBalance: jest.fn(),
            balanceOf: jest.fn().mockResolvedValue(100n), // Add balanceOf
            depositNative: jest.fn().mockResolvedValue({ 
                hash: '0xDepositNativeHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            depositToken: jest.fn().mockResolvedValue({ 
                hash: '0xDepositTokenHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            withdrawToken: jest.fn().mockResolvedValue({ 
                hash: '0xWithdrawTokenHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            transferToken: jest.fn().mockResolvedValue({ 
                hash: '0xTransferTokenHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            withdrawNative: jest.fn().mockResolvedValue({ 
                hash: '0xWithdrawNativeHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            }),
            getBalances: jest.fn(),
            allowance: jest.fn(),
            approve: jest.fn().mockResolvedValue({ wait: jest.fn().mockResolvedValue({}) }),
            portfolioBridge: jest.fn().mockResolvedValue('0xBridgeAddress'),
            runner: mockSigner,
            functions: {}
        };
        // Gas estimation mocks
        mockContract.depositNative.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.depositToken.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.withdrawToken.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.transferToken.estimateGas = jest.fn().mockResolvedValue(100000n);
        mockContract.withdrawNative.estimateGas = jest.fn().mockResolvedValue(100000n);

        // Setup Contract Constructor Mock - return mockContract by default, but handle bridge contract specially
        (Contract as unknown as jest.Mock).mockImplementation((address, abi, runner) => {
            // If it's the bridge contract (has getBridgeFee in ABI)
            if (abi && abi.some((item: any) => item.includes('getBridgeFee'))) {
                return {
                    getBridgeFee: jest.fn().mockResolvedValue(1000n)
                };
            }
            return mockContract;
        });

        // Utils Mocks
        (Utils.toBytes32 as jest.Mock).mockReturnValue('0xBytes32');
        (Utils.fromBytes32 as jest.Mock).mockReturnValue('AVAX');
        (Utils.unitConversion as jest.Mock).mockImplementation((val, dec, toWei) => {
            if (toWei) return val.toString() + '000000000000000000'; // Simply append zeros for mock
            return '10'; // Return '10' for fromWei
        });

        client = new TestClient(mockSigner);
        
        // Manual setup of client properties that usually come from initialize()
        client.portfolioSubContractView = mockContract; 
        client.portfolioMainContracts = { 'Avalanche': mockContract }; // Per-chain contracts
        client.portfolioSubContract = mockContract;
        client.subnetChainId = 12345;
        client.chainId = 43114;
        client.env = ENV.PROD_MULTI_AVAX;
        client.subnetEnv = ENV.PROD_MULTI_SUBNET; // Add subnet env
        client.chainConfig = {
            'Avalanche': { chain_id: 43114, native_symbol: 'AVAX', env: ENV.PROD_MULTI_AVAX } as any,
            'Destination': { chain_id: 999 } as any
        };
        client.tokenData = {
            'AVAX': {
                [ENV.PROD_MULTI_AVAX]: { address: mockTokenAddr, decimals: 18, chainId: 43114, env: ENV.PROD_MULTI_AVAX } as any,
                [ENV.PROD_MULTI_SUBNET]: { address: mockTokenAddr, decimals: 18, chainId: 12345, env: ENV.PROD_MULTI_SUBNET } as any
            },
            'USDT': {
                [ENV.PROD_MULTI_AVAX]: { address: '0xUSDT', decimals: 6, chainId: 43114, env: ENV.PROD_MULTI_AVAX } as any,
                [ENV.PROD_MULTI_SUBNET]: { address: '0xUSDT', decimals: 6, chainId: 12345, env: ENV.PROD_MULTI_SUBNET } as any
            }
        };
        client.connectedChainProviders = {
            'Avalanche': { getBalance: jest.fn().mockResolvedValue(2000n) } as any
        };
    });

    describe('getPortfolioBalance', () => {
        it('should return parsed balance', async () => {
             mockContract.getBalance.mockResolvedValue([100n, 50n, 50n]);
             const result = await client.getPortfolioBalance('AVAX');
             expect(result.success).toBe(true);
             expect(result.data!.total).toBe(10); // Mocked Utils returns '10'
             expect(mockContract.getBalance).toHaveBeenCalled();
        });

        it('should return error if token validation fails', async () => {
             // Use an invalid token symbol (lowercase) to trigger validation failure
             const result = await client.getPortfolioBalance('avax');
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });

        it('should return error if Subnet View not initialized', async () => {
             client.portfolioSubContractView = null;
             const result = await client.getPortfolioBalance('AVAX');
             expect(result.success).toBe(false);
             expect(result.error).toContain('Subnet View Contract not initialized');
        });

         it('should return error if signer missing', async () => {
             client.signer = undefined as any;
             const result = await client.getPortfolioBalance('AVAX');
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer');
        });

        it('should default to 18 decimals if token unknown', async () => {
             mockContract.getBalance.mockResolvedValue([10n, 5n, 5n]);
             client.tokenData = {};
             client.subnetChainId = 12345;
             
             const result = await client.getPortfolioBalance('UNKNOWN');
             expect(result.success).toBe(true);
             expect(result.data!.total).toBe(10); 
        });

        it('should handle getPortfolioBalance errors in catch block', async () => {
             // Force an error during getBalance call
             mockContract.getBalance.mockRejectedValue(new Error('Contract call failed'));
             const result = await client.getPortfolioBalance('AVAX');
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });
    });

    describe('deposit', () => {
        it('should handle Native deposit (AVAX)', async () => {
            const result = await client.deposit('AVAX', 10, 'Avalanche');
            expect(result.success).toBe(true);
            expect(mockContract.depositNative).toHaveBeenCalled();
        });

        it('should handle ERC20 deposit with allowance', async () => {
             mockContract.allowance.mockResolvedValue(0n);
             
             const result = await client.deposit('USDT', 10, 'Avalanche');
             expect(result.success).toBe(true);
             expect(mockContract.approve).toHaveBeenCalledWith(expect.any(String), MaxUint256);
             expect(mockContract.depositToken).toHaveBeenCalled();
        });

        it('should return error if signer missing', async () => {
             client.signer = undefined as any;
             const result = await client.deposit('AVAX', 10, 'Avalanche');
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer');
        });

        it('should return error if PortfolioMain contract missing for chain', async () => {
             client.portfolioMainContracts = {};
             const result = await client.deposit('AVAX', 10, 'Avalanche');
             expect(result.success).toBe(false);
             expect(result.error).toContain("PortfolioMain contract not found");
        });

        it('should return error if chain config missing', async () => {
             delete (client.chainConfig as any)['Avalanche'];
             const result = await client.deposit('AVAX', 10, 'Avalanche');
             expect(result.success).toBe(false);
             expect(result.error).toContain("Chain config not found");
        });

        it('should return error if unknown token', async () => {
             const result = await client.deposit('UNKNOWN', 10, 'Avalanche');
             expect(result.success).toBe(false);
             expect(result.error).toContain("Token address for UNKNOWN not found");
        });

        it('should handle deposit errors in catch block', async () => {
             // Force an error during depositNative call
             mockContract.depositNative.estimateGas.mockRejectedValue(new Error('Transaction failed'));
             const result = await client.deposit('AVAX', 10, 'Avalanche');
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });
    });

    describe('withdraw', () => {
        it('should withdraw token', async () => {
             const result = await client.withdraw('AVAX', 10, 'Destination');
             expect(result.success).toBe(true);
             expect(mockContract.withdrawToken).toHaveBeenCalled();
        });

        it('should check allowance for withdrawal if subnet address exists', async () => {
             mockContract.allowance.mockResolvedValue(0n);
             const result = await client.withdraw('AVAX', 10, 'Destination');
             expect(result.success).toBe(true);
             expect(mockContract.approve).toHaveBeenCalled();
        });

        it('should return error if signer missing', async () => {
             client.signer = undefined as any;
             const result = await client.withdraw('AVAX', 10, 'Dest');
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer');
        });

        it('should return error if destination chain invalid', async () => {
             const result = await client.withdraw('AVAX', 10, 'Invalid');
             expect(result.success).toBe(false);
             expect(result.error).toContain('Destination chain');
        });

         it('should return error if PortfolioSub missing', async () => {
             client.portfolioSubContract = null;
             const result = await client.withdraw('AVAX', 10, 'Destination');
             expect(result.success).toBe(false);
             expect(result.error).toContain('Portfolio Sub contract not available');
        });

        it('should handle withdraw errors in catch block', async () => {
             // Force an error during withdrawToken call
             mockContract.withdrawToken.estimateGas.mockRejectedValue(new Error('Withdrawal failed'));
             const result = await client.withdraw('AVAX', 10, 'Destination');
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });
    });

    describe('transferPortfolio', () => {
        const validAddress = '0x1234567890123456789012345678901234567890';
        
        it('should transfer token if balance sufficient', async () => {
             jest.spyOn(client, 'getPortfolioBalance').mockResolvedValue({ success: true, data: { total: 20, available: 20, locked: 0 } } as any);
             
             const result = await client.transferPortfolio('AVAX', 10, validAddress);
             expect(result.success).toBe(true);
             expect(mockContract.transferToken).toHaveBeenCalled();
        });

        it('should use token decimals when available', async () => {
             jest.spyOn(client, 'getPortfolioBalance').mockResolvedValue({ success: true, data: { total: 20, available: 20, locked: 0 } } as any);
             client.tokenData['AVAX'][ENV.PROD_MULTI_SUBNET].decimals = 8;
             const result = await client.transferPortfolio('AVAX', 1, validAddress);
             expect(result.success).toBe(true);
             expect(mockContract.transferToken).toHaveBeenCalled();
        });

        it('should return error if balance insufficient', async () => {
             jest.spyOn(client, 'getPortfolioBalance').mockResolvedValue({ success: true, data: { total: 5, available: 5, locked: 0 } } as any);
             const result = await client.transferPortfolio('AVAX', 10, validAddress);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Insufficient available balance');
        });

        it('should return error if init missing', async () => {
             client.portfolioSubContract = null;
             const result = await client.transferPortfolio('AVAX', 10, validAddress);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer/Contract not initialized');
        });

        it('should return error if getPortfolioBalance fails', async () => {
             jest.spyOn(client, 'getPortfolioBalance').mockResolvedValue({ success: false, error: 'Balance check failed' } as any);
             const result = await client.transferPortfolio('AVAX', 10, validAddress);
             expect(result.success).toBe(false);
             expect(result.error).toBe('Balance check failed');
        });

        it('should handle transferPortfolio errors in catch block', async () => {
             jest.spyOn(client, 'getPortfolioBalance').mockResolvedValue({ success: true, data: { total: 20, available: 20, locked: 0 } } as any);
             // Force an error during transferToken call
             mockContract.transferToken.estimateGas.mockRejectedValue(new Error('Transfer failed'));
             const result = await client.transferPortfolio('AVAX', 10, validAddress);
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });
    });

    describe('transferToken', () => {
        it('should alias to transferPortfolio', async () => {
             const spy = jest.spyOn(client, 'transferPortfolio').mockResolvedValue({} as any);
             await client.transferToken('AVAX', '0xTo', 10);
             expect(spy).toHaveBeenCalledWith('AVAX', 10, '0xTo');
        });
    });

    describe('addGas & removeGas', () => {
        it('should call withdrawNative for addGas', async () => {
             const result = await client.addGas(10);
             expect(result.success).toBe(true);
             expect(mockContract.withdrawNative).toHaveBeenCalled();
        });

        it('should call depositNative for removeGas', async () => {
             const result = await client.removeGas(10);
             expect(result.success).toBe(true);
             expect(mockContract.depositNative).toHaveBeenCalled();
        });

        it('should return error if init missing', async () => {
             client.portfolioSubContract = null;
             const addResult = await client.addGas(10);
             expect(addResult.success).toBe(false);
             expect(addResult.error).toContain('Signer/Contract not initialized');
             
             const removeResult = await client.removeGas(10);
             expect(removeResult.success).toBe(false);
             expect(removeResult.error).toContain('Signer/Contract not initialized');
        });

        it('should handle addGas errors in catch block', async () => {
             // Force an error during withdrawNative call
             mockContract.withdrawNative.estimateGas.mockRejectedValue(new Error('Add gas failed'));
             const result = await client.addGas(10);
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });

        it('should handle removeGas errors in catch block', async () => {
             // Force an error during depositNative call
             mockContract.depositNative.estimateGas.mockRejectedValue(new Error('Remove gas failed'));
             const result = await client.removeGas(10);
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });
    });

    describe('getAllPortfolioBalances', () => {
        it('should iterate pages and return balances', async () => {
             // Page 0 returns 1 item, Page 1 returns empty (stop)
             mockContract.getBalances.mockResolvedValueOnce([['0xAvax'], [100n], [50n]])
                                     .mockResolvedValueOnce([[], [], []]);

             const result = await client.getAllPortfolioBalances();
             expect(result.success).toBe(true);
             expect(result.data!['AVAX']).toBeDefined();
             expect(mockContract.getBalances).toHaveBeenCalledTimes(2);
        });

        it('should compute locked from totals and availables', async () => {
             // Override unitConversion to pass through numbers for this test
             const original = (Utils.unitConversion as jest.Mock).getMockImplementation();
             (Utils.unitConversion as jest.Mock).mockImplementation((val, dec, toWei) => val.toString());
             mockContract.getBalances.mockResolvedValueOnce([['0xAvax'], [200n], [150n]])
                                     .mockResolvedValueOnce([[], [], []]);
             const result = await client.getAllPortfolioBalances();
             expect(result.success).toBe(true);
             expect(result.data!['AVAX'].locked).toBe(50);
             // restore
             (Utils.unitConversion as jest.Mock).mockImplementation(original as any);
        });

        it('should safety break loop', async () => {
              // Always return data
             mockContract.getBalances.mockResolvedValue([['0xAvax'], [100n], [50n]]);
             const result = await client.getAllPortfolioBalances();
             expect(result.success).toBe(true);
             expect(mockContract.getBalances).toHaveBeenCalled();
             // It breaks at > 10 pages, preventing infinite loop
        });

        it('should return error if init missing', async () => {
             client.portfolioSubContractView = null;
             const result = await client.getAllPortfolioBalances();
             expect(result.success).toBe(false);
             expect(result.error).toContain('Subnet View Contract not initialized');
        });
         it('should return error if signer missing', async () => {
             client.signer = undefined as any;
             const result = await client.getAllPortfolioBalances();
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer');
        });

        it('should handle getAllPortfolioBalances errors in catch block', async () => {
             // Force an error during getAddress call
             mockSigner.getAddress.mockRejectedValueOnce(new Error('Address fetch failed'));
             const result = await client.getAllPortfolioBalances();
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });
    });

    describe('getChainWalletBalance', () => {
        it('should return L1 ALOT balance', async () => {
            const result = await client.getChainWalletBalance('Dexalot L1', 'ALOT');
            expect(result.success).toBe(true);
            expect(result.data!.chain).toBe('Dexalot L1');
            expect(result.data!.symbol).toBe('ALOT');
            expect(result.data!.type).toBe('Native');
        });

        it('should return error for non-ALOT on L1', async () => {
            const result = await client.getChainWalletBalance('Dexalot L1', 'USDC');
            expect(result.success).toBe(false);
            expect(result.error).toContain('not available on Dexalot L1');
        });

        it('should return error for unknown chain', async () => {
            const result = await client.getChainWalletBalance('UnknownChain', 'AVAX');
            expect(result.success).toBe(false);
            expect(result.error).toContain('not connected');
        });

        it('should return error if signer missing', async () => {
            client.signer = undefined as any;
            const result = await client.getChainWalletBalance('Dexalot L1', 'ALOT');
            expect(result.success).toBe(false);
            expect(result.error).toBe('Private key not configured.');
        });

        it('should return mainnet native token balance', async () => {
            client.connectedChainProviders = { 'Avalanche': { getBalance: jest.fn().mockResolvedValue(25n * 10n**18n) } as any };
            client.chainConfig = { 'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any };
            
            const result = await client.getChainWalletBalance('Avalanche', 'AVAX');
            expect(result.success).toBe(true);
            expect(result.data!.chain).toBe('Avalanche');
            expect(result.data!.symbol).toBe('AVAX');
            expect(result.data!.type).toBe('Native');
        });

        it('should return ERC20 token balance', async () => {
            client.connectedChainProviders = { 'Avalanche': { getBalance: jest.fn().mockResolvedValue(0n) } as any };
            client.chainConfig = { 'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any };
            client.tokenData = {
                'USDC': { 'prod': { address: '0xUSDC', chainId: 43114, decimals: 6, env: 'prod' } as any }
            };
            (Contract as unknown as jest.Mock).mockImplementation(() => ({
                balanceOf: jest.fn().mockResolvedValue(1000n * 10n**6n)
            }));

            const result = await client.getChainWalletBalance('Avalanche', 'USDC');
            expect(result.success).toBe(true);
            expect(result.data!.chain).toBe('Avalanche');
            expect(result.data!.symbol).toBe('USDC');
            expect(result.data!.type).toBe('ERC20');
        });

        it('should return error if chain ID not configured', async () => {
            client.connectedChainProviders = { 'Avalanche': {} as any };
            client.chainConfig = { 'Avalanche': { native_symbol: 'AVAX' } as any }; // No chain_id
            
            const result = await client.getChainWalletBalance('Avalanche', 'USDC');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Chain ID not configured');
        });

        it('should return error for token not in tokenData', async () => {
            client.connectedChainProviders = { 'Avalanche': {} as any };
            client.chainConfig = { 'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any };
            client.tokenData = {};

            const result = await client.getChainWalletBalance('Avalanche', 'UNKNOWN');
            expect(result.success).toBe(true);
            expect(result.data!.error).toContain('not found in token data');
        });

        it('should return error for token not on chain', async () => {
            client.connectedChainProviders = { 'Avalanche': {} as any };
            client.chainConfig = { 'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any };
            client.tokenData = {
                'SPECIAL': { 'eth': { address: '0xSPEC', chainId: 1, env: 'eth' } as any } // Different chain
            };

            const result = await client.getChainWalletBalance('Avalanche', 'SPECIAL');
            expect(result.success).toBe(true);
            expect(result.data!.error).toContain('not available on chain');
        });

        it('should return error for token with zero address', async () => {
            client.connectedChainProviders = { 'Avalanche': {} as any };
            client.chainConfig = { 'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any };
            client.tokenData = {
                'ZERO': { 'prod': { address: DEFAULTS.ZERO_ADDRESS, chainId: 43114, env: 'prod' } as any }
            };

            const result = await client.getChainWalletBalance('Avalanche', 'ZERO');
            expect(result.success).toBe(true);
            expect(result.data!.error).toContain('not available on chain');
        });

        it('should handle ERC20 contract errors', async () => {
            client.connectedChainProviders = { 'Avalanche': {} as any };
            client.chainConfig = { 'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any };
            client.tokenData = {
                'ERR': { 'prod': { address: '0xERR', chainId: 43114, decimals: 18, env: 'prod' } as any }
            };
            (Contract as unknown as jest.Mock).mockImplementation(() => ({
                balanceOf: jest.fn().mockRejectedValue(new Error('Contract Error'))
            }));

            const result = await client.getChainWalletBalance('Avalanche', 'ERR');
            expect(result.success).toBe(true);
            expect(result.data!.balance).toContain('Error');
        });

        it('should fallback to env string matching for Fuji', async () => {
            client.connectedChainProviders = { 'Fuji': {} as any };
            client.chainConfig = { 'Fuji': { chain_id: 43113, native_symbol: 'AVAX' } as any };
            client.tokenData = {
                'DAI': { 'env-key': { address: '0xDAI', chainId: 9999, decimals: 18, env: 'fuji-multi' } as any }
            };
            (Contract as unknown as jest.Mock).mockImplementation(() => ({
                balanceOf: jest.fn().mockResolvedValue(100n)
            }));

            const result = await client.getChainWalletBalance('Fuji', 'DAI');
            expect(result.success).toBe(true);
            expect(result.data!.chain).toBe('Fuji');
            expect(result.data!.symbol).toBe('DAI');
        });

        it('should fallback to env string matching for Avalanche/prod', async () => {
            client.connectedChainProviders = { 'Avalanche': {} as any };
            client.chainConfig = { 'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any };
            client.tokenData = {
                'USDT': { 'env-key': { address: '0xUSDT', chainId: 9999, decimals: 6, env: 'prod-multi' } as any }
            };
            (Contract as unknown as jest.Mock).mockImplementation(() => ({
                balanceOf: jest.fn().mockResolvedValue(500n)
            }));

            const result = await client.getChainWalletBalance('Avalanche', 'USDT');
            expect(result.success).toBe(true);
            expect(result.data!.chain).toBe('Avalanche');
            expect(result.data!.symbol).toBe('USDT');
        });

        it('should fallback to empty chainConfig and ETH symbol', async () => {
            client.connectedChainProviders = { 'CustomChain': { getBalance: jest.fn().mockResolvedValue(10n) } as any };
            client.chainConfig = {}; // No config for CustomChain - will fallback to {}
            
            const result = await client.getChainWalletBalance('CustomChain', 'ETH');
            expect(result.success).toBe(true);
            expect(result.data!.chain).toBe('CustomChain');
            expect(result.data!.symbol).toBe('ETH'); // Fallback native symbol
            expect(result.data!.type).toBe('Native');
        });

        it('should fallback to default 18 decimals for ERC20', async () => {
            client.connectedChainProviders = { 'Avalanche': {} as any };
            client.chainConfig = { 'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any };
            client.tokenData = {
                'NODEC': { 'prod': { address: '0xNODEC', chainId: 43114, env: 'prod' } as any } // No decimals field
            };
            (Contract as unknown as jest.Mock).mockImplementation(() => ({
                balanceOf: jest.fn().mockResolvedValue(100n) // Raw value
            }));

            const result = await client.getChainWalletBalance('Avalanche', 'NODEC');
            expect(result.success).toBe(true);
            expect(result.data!.chain).toBe('Avalanche');
            expect(result.data!.symbol).toBe('NODEC');
            // Utils.unitConversion with 18 decimals: 100 / 10^18 = very small number
            expect(result.data!.balance).toBeDefined();
            expect(result.data!.type).toBe('ERC20');
        });

        it('should handle getChainWalletBalance errors in catch block', async () => {
             // Force an error during getAddress call
             mockSigner.getAddress.mockRejectedValueOnce(new Error('Address fetch failed'));
             const result = await client.getChainWalletBalance('Avalanche', 'AVAX');
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });
    });

    describe('getChainWalletBalances', () => {
        it('should return L1 balances', async () => {
            const result = await client.getChainWalletBalances('Dexalot L1');
            expect(result.success).toBe(true);
            expect(result.data!.chain).toBe('Dexalot L1');
            expect(result.data!.address).toBe(mockAddress);
            expect(result.data!.chain_balances.length).toBeGreaterThanOrEqual(1);
            const l1 = result.data!.chain_balances.find((x: any) => x.chain === 'Dexalot L1');
            expect(l1).toBeDefined();
        });

        it('should return error for unknown chain', async () => {
            const result = await client.getChainWalletBalances('UnknownChain');
            expect(result.success).toBe(false);
            expect(result.error).toContain('not connected');
        });

        it('should return error if signer missing', async () => {
            client.signer = undefined as any;
            const result = await client.getChainWalletBalances('Dexalot L1');
            expect(result.success).toBe(false);
            expect(result.error).toBe('Private key not configured.');
        });

        it('should return mainnet chain balances', async () => {
            client.connectedChainProviders = { 
                'Avalanche': { getBalance: jest.fn().mockResolvedValue(15n * 10n**18n) } as any 
            };
            client.chainConfig = { 'Avalanche': { chain_id: 43114, native_symbol: 'AVAX' } as any };
            (Contract as unknown as jest.Mock).mockImplementation(() => ({
                balanceOf: jest.fn().mockResolvedValue(500n)
            }));

            const result = await client.getChainWalletBalances('Avalanche');
            expect(result.success).toBe(true);
            expect(result.data!.chain).toBe('Avalanche');
            expect(result.data!.address).toBe(mockAddress);
            const native = result.data!.chain_balances.find((x: any) => x.type === 'Native');
            expect(native).toBeDefined();
        });

        it('should handle L1 entry with error', async () => {
            const mockL1 = { getBalance: jest.fn().mockRejectedValue(new Error("L1 Error")) };
            client.provider = mockL1 as any;
            (client.signer as any).provider = mockL1;
            
            const result = await client.getChainWalletBalances('Dexalot L1');
            expect(result.success).toBe(true);
            // Should still return but with error in balance
            expect(result.data!.chain).toBe('Dexalot L1');
            const l1 = result.data!.chain_balances.find((x: any) => x.chain === 'Dexalot L1');
            expect(l1?.balance).toContain('Error');
        });

        it('should skip ERC20 balances if no chainId', async () => {
            client.connectedChainProviders = { 'Avalanche': { getBalance: jest.fn().mockResolvedValue(10n) } as any };
            client.chainConfig = { 'Avalanche': { native_symbol: 'AVAX' } as any }; // No chain_id
            
            const result = await client.getChainWalletBalances('Avalanche');
            expect(result.success).toBe(true);
            // Should only have native, no ERC20s
            expect(result.data!.chain_balances.filter((x: any) => x.type === 'ERC20').length).toBe(0);
        });

        it('should fallback to empty chainConfig and ETH symbol', async () => {
            client.connectedChainProviders = { 'CustomChain': { getBalance: jest.fn().mockResolvedValue(10n) } as any };
            client.chainConfig = {}; // No config for CustomChain - will fallback to {}
            
            const result = await client.getChainWalletBalances('CustomChain');
            expect(result.success).toBe(true);
            expect(result.data!.chain).toBe('CustomChain');
            const native = result.data!.chain_balances.find((x: any) => x.type === 'Native');
            expect(native.symbol).toBe('ETH'); // Fallback native symbol
        });

        it('should handle getChainWalletBalances errors in catch block', async () => {
             // Force an error during getAddress call
             mockSigner.getAddress.mockRejectedValueOnce(new Error('Address fetch failed'));
             const result = await client.getChainWalletBalances('Avalanche');
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });
    });

    describe('getAllChainWalletBalances', () => {
        it('should return correct structure', async () => {
             // Mock Contract for ERC20
             (Contract as unknown as jest.Mock).mockImplementation(() => ({
                 balanceOf: jest.fn().mockResolvedValue(500n)
             }));

             const result = await client.getAllChainWalletBalances();
             expect(result.success).toBe(true);
             expect(result.data!.address).toBe(mockAddress);
             const l1 = result.data!.chain_balances.find((x: any) => x.chain === 'Dexalot L1');
             expect(l1.balance).toBeDefined();
             expect(result.data!.chain_balances).toHaveLength(4); // Dexalot L1 + Native AVAX + ERC20 AVAX + ERC20 USDT
        });

        it('should handle signer missing', async () => {
             client.signer = undefined as any;
             const result = await client.getAllChainWalletBalances();
             expect(result.success).toBe(false);
             expect(result.error).toBe('Private key not configured.');
        });

         it('should handle provider errors gracefully', async () => {
             // Mock console.warn to suppress output
             jest.spyOn(console, 'warn').mockImplementation(() => {});
             (client.signer!.provider!.getBalance as jest.Mock).mockRejectedValue(new Error("RPC Error"));
             const result = await client.getAllChainWalletBalances();
             expect(result.success).toBe(true);
             const l1 = result.data!.chain_balances.find((x: any) => x.chain === 'Dexalot L1');
             expect(l1.balance).toContain("Error");
        });

        it('should handle mainnet provider errors', async () => {
             const mockProv = { getBalance: jest.fn().mockRejectedValue(new Error("Mainnet RPC Fail")) };
             client.connectedChainProviders = { 'Avalanche': mockProv as any };
             const result = await client.getAllChainWalletBalances();
             expect(result.success).toBe(true);
             expect(result.data!.chain_balances.find((x: any) => x.chain === 'Avalanche')!.balance).toContain("Error");
        });

        it('should fallback to string matching for ERC20s', async () => {
             // Setup tokenData without matching chainId, but matching env string
             client.tokenData = {
                 'USDC': {
                     'some-env': { address: '0xUSDC', chainId: 9999, env: 'prod-multi-avax' } as any
                 }
             };
             // Call internal method directly to test logic
             const info: any = { chain_balances: [] };
             await client._fetchErc20Balances(info, 1111, 'Avalanche', {} as any, '0xAddr');
             expect(info.chain_balances).toHaveLength(1);
             expect(info.chain_balances[0].symbol).toBe('USDC');
        });

        it('should fallback to string matching for ERC20s (Fuji)', async () => {
             client.tokenData = {
                 'DAI': { 'env-key': { address: '0xDAI', chainId: 9999, env: 'fuji-multi-subnet' } as any }
             };
             const info: any = { chain_balances: [] };
             await client._fetchErc20Balances(info, 1112, 'Fuji', {} as any, '0xAddr');
             expect(info.chain_balances).toHaveLength(1);
             expect(info.chain_balances[0].symbol).toBe('DAI');
        });

         it('should iterate mainnet providers and handle errors', async () => {
             // Setup mainnet provider
             const failingProvider = { getBalance: jest.fn().mockRejectedValue(new Error("RPC Fail")) };
             client.connectedChainProviders['Avalanche'] = failingProvider as any;
             client.chainConfig['Avalanche'] = { chain_id: 43114, native_symbol: 'AVAX' } as any;
             
             // Setup secondary logic to ensure loop happened
             const successProvider = { getBalance: jest.fn().mockResolvedValue(100n) };
             client.connectedChainProviders['Ethereum'] = successProvider as any;
             client.chainConfig['Ethereum'] = { chain_id: 1, native_symbol: 'ETH' } as any;
             
             const result = await client.getAllChainWalletBalances();
             expect(result.success).toBe(true);
             
             const avaxEntry = result.data!.chain_balances.find((x: any) => x.chain === 'Avalanche');
             expect(avaxEntry.balance).toContain("Error: RPC Fail");
             
             const ethEntry = result.data!.chain_balances.find((x: any) => x.chain === 'Ethereum');
             expect(ethEntry.balance).toBe("10"); // Mock returns '10'
        });

         it('should handle L1 provider error', async () => {
             const mockL1 = { getBalance: jest.fn().mockRejectedValue(new Error("L1 Fail")) };
             client.provider = mockL1 as any;
             (client.signer as any).provider = mockL1; // Ensure signer.provider matches
             
             const result = await client.getAllChainWalletBalances();
             expect(result.success).toBe(true);
             const l1 = result.data!.chain_balances.find((x: any) => x.chain === 'Dexalot L1');
             expect(l1.balance).toContain("Error: L1 Fail");
        });

        it('should skip fetching if contract creation fails', async () => {
             // Force contract logic to error
             (Contract as unknown as jest.Mock).mockImplementation(() => {
                 throw new Error("Contract Error");
             });
             const info: any = { chain_balances: [] };
             await client._fetchErc20Balances(info, 1111, 'Avalanche', {} as any, '0xAddr');
             expect(info.chain_balances).toHaveLength(0);
        });

        it('should handle getAllChainWalletBalances errors in catch block', async () => {
             // Force an error during getAddress call
             mockSigner.getAddress.mockRejectedValueOnce(new Error('Address fetch failed'));
             const result = await client.getAllChainWalletBalances();
             expect(result.success).toBe(false);
             expect(result.error).toBeDefined();
        });
    });

    describe('Helpers', () => {
        it('_getBridgeId should return correct ID', () => {
             // 'Avalanche' is in ICM_CHAINS, so it returns ICM (2)
             expect(client._getBridgeId('Avalanche', false)).toBe(2); 
             expect(client._getBridgeId('Other', false)).toBe(0); // LZ
        });

         it('_getBridgeFee should return fee or 0', async () => {
             mockContract.portfolioBridge.mockResolvedValue('0xBridge');
             const mockBridge = { getBridgeFee: jest.fn().mockResolvedValue(123n) };
             // We need to return mockBridge when new Contract is called
             (Contract as unknown as jest.Mock).mockImplementation(() => mockBridge);

             const fee = await client._getBridgeFee(mockContract, 1, '0xSym', 100n);
             expect(fee).toBe(123n);
         });

         it('_getBridgeFee should handle errors', async () => {
              const spyWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
              mockContract.portfolioBridge.mockRejectedValue(new Error("Fail"));
              const fee = await client._getBridgeFee(mockContract, 1, '0xSym', 100n);
              expect(fee).toBe(0n);
              expect(spyWarn).toHaveBeenCalled();
         });

         it('_getBridgeFee should return 0 if bridge address zero/null', async () => {
             // The implementation checks !bridgeAddr, so null/undefined returns 0n
             // Zero address string is truthy, so it would try to create contract
             // For this test, we'll check null case
             mockContract.portfolioBridge.mockResolvedValue(null as any); 
             const fee = await client._getBridgeFee(mockContract, 1, '0xSym', 100n);
             expect(fee).toBe(0n);
         });
    });

    describe('Missing Configs & Fallbacks', () => {
        it('should use signer provider if client provider missing in getAllChainWalletBalances', async () => {
            client.provider = undefined as any;
            client.signer = { 
                getAddress: jest.fn().mockResolvedValue(mockAddress),
                provider: { getBalance: jest.fn().mockResolvedValue(100n) } 
            } as any;
            
            const result = await client.getAllChainWalletBalances();
            expect(result.success).toBe(true);
            const l1 = result.data!.chain_balances.find((x: any) => x.chain === 'Dexalot L1');
            expect(l1.balance).toBeDefined();
        });

        it('should handle missing chainConfig in getAllChainWalletBalances loop', async () => {
            client.connectedChainProviders = { 'UnknownChain': {} as any };
            client.chainConfig = {}; // No config
            
            const result = await client.getAllChainWalletBalances();
            expect(result.success).toBe(true);
            const entry = result.data!.chain_balances.find((x: any) => x.chain === 'UnknownChain');
            expect(entry.chain).toBe('UnknownChain');
            expect(entry.symbol).toBe('ETH'); // Default
        });
         
         it('should default to 18 decimals in deposit if token unknown', async () => {
             // Need address to pass first check, but missing decimals
             client.tokenData = { 
                 'UNKNOWN': { 
                     [ENV.PROD_MULTI_AVAX]: { address: '0xValidAddr', env: ENV.PROD_MULTI_AVAX, chainId: 43114 } as any
                 } 
             };
             // Ensure chainId matches so it finds the entry
             client.chainId = 43114;
             client.env = ENV.PROD_MULTI_AVAX;
             client.chainConfig = {
                 'Avalanche': { chain_id: 43114, native_symbol: 'AVAX', env: ENV.PROD_MULTI_AVAX } as any
             };
             client.portfolioMainContracts = { 'Avalanche': mockContract };

             // Logic: _getTokenDecimals returns 18 because decimals prop is undefined
             
             mockContract.depositNative.estimateGas.mockResolvedValue(100n);
             
             // UNKNOWN token -> ERC20 path.
             // We need to ensure _ensureAllowance doesn't crash? Mocked?
             mockContract.allowance.mockResolvedValue(1000n);
             
             await client.deposit('UNKNOWN', 10, 'Avalanche');
             expect(mockContract.depositToken).toHaveBeenCalled();
         });

         it('should not wait for receipt when waitForReceipt=false in deposit', async () => {
            const tx = { hash: '0xDepositNativeHash' };
            mockContract.depositNative.mockResolvedValue(tx);
            
            const result = await client.deposit('AVAX', 10, 'Avalanche', false, false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xDepositNativeHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should not wait for receipt when waitForReceipt=false in withdraw', async () => {
            const tx = { hash: '0xWithdrawTokenHash' };
            mockContract.withdrawToken.mockResolvedValue(tx);
            
            const result = await client.withdraw('AVAX', 10, 'Avalanche', false, false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xWithdrawTokenHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should not wait for receipt when waitForReceipt=false in transferPortfolio', async () => {
            const validAddress = '0x1234567890123456789012345678901234567890';
            jest.spyOn(client, 'getPortfolioBalance').mockResolvedValue({ success: true, data: { total: 20, available: 20, locked: 0 } } as any);
            const tx = { hash: '0xTransferTokenHash' };
            mockContract.transferToken.mockResolvedValue(tx);
            
            const result = await client.transferPortfolio('AVAX', 10, validAddress, false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xTransferTokenHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should not wait for receipt when waitForReceipt=false in addGas', async () => {
            const tx = { hash: '0xWithdrawNativeHash' };
            mockContract.withdrawNative.mockResolvedValue(tx);
            
            const result = await client.addGas(10, false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xWithdrawNativeHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should not wait for receipt when waitForReceipt=false in removeGas', async () => {
            const tx = { hash: '0xDepositNativeHash' };
            mockContract.depositNative.mockResolvedValue(tx);
            
            const result = await client.removeGas(10, false);
            
            expect(result.success).toBe(true);
            expect(result.data!.txHash).toBe('0xDepositNativeHash');
            // When waitForReceipt=false, tx.wait() is never called
        });

        it('should return error when receipt status is not 1 in deposit', async () => {
            const tx = {
                hash: '0xDepositNativeHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xDepositNativeHash' })
            };
            mockContract.depositNative.mockResolvedValue(tx);
            
            const result = await client.deposit('AVAX', 10, 'Avalanche', false, true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should return error when receipt status is not 1 in withdraw', async () => {
            const tx = {
                hash: '0xWithdrawTokenHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xWithdrawTokenHash' })
            };
            mockContract.withdrawToken.mockResolvedValue(tx);
            
            const result = await client.withdraw('AVAX', 10, 'Avalanche', false, true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should return error when receipt status is not 1 in transferPortfolio', async () => {
            const validAddress = '0x1234567890123456789012345678901234567890';
            jest.spyOn(client, 'getPortfolioBalance').mockResolvedValue({ success: true, data: { total: 20, available: 20, locked: 0 } } as any);
            const tx = {
                hash: '0xTransferTokenHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xTransferTokenHash' })
            };
            mockContract.transferToken.mockResolvedValue(tx);
            
            const result = await client.transferPortfolio('AVAX', 10, validAddress, true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should return error when receipt status is not 1 in addGas', async () => {
            const tx = {
                hash: '0xWithdrawNativeHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xWithdrawNativeHash' })
            };
            mockContract.withdrawNative.mockResolvedValue(tx);
            
            const result = await client.addGas(10, true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should return error when receipt status is not 1 in removeGas', async () => {
            const tx = {
                hash: '0xDepositNativeHash',
                wait: jest.fn().mockResolvedValue({ status: 0, hash: '0xDepositNativeHash' })
            };
            mockContract.depositNative.mockResolvedValue(tx);
            
            const result = await client.removeGas(10, true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe("Transaction reverted");
        });

        it('should default to 18 decimals in transferPortfolio/getAllPortfolioBalances', async () => {
             const validAddress = '0x1234567890123456789012345678901234567890';
             client.tokenData = {}; // Clear token data to force fallback
             // transferPortfolio check
             jest.spyOn(client, 'getPortfolioBalance').mockResolvedValue({ success: true, data: { total: 100, available: 100, locked: 0 } } as any);
             mockContract.transferToken.estimateGas.mockResolvedValue(100n);
             
             client.subnetChainId = 12345;
             
             const result = await client.transferPortfolio('UNKNOWN', 10, validAddress);
             expect(result.success).toBe(true);
             expect(mockContract.transferToken).toHaveBeenCalled();
             
             // getAllPortfolioBalances check
             // Ensure view contract is set
             client.portfolioSubContractView = mockContract;
             mockContract.getBalances.mockResolvedValue([['0xSym'], [100n], [50n]]);
             const bals = await client.getAllPortfolioBalances();
             expect(bals.success).toBe(true);
             expect(bals.data).toBeDefined();
         });
    });

    describe('Branch Coverage - Fallbacks', () => {
        it('deposit should use "ETH" when native_symbol missing (line 56)', async () => {
            // Chain config without native_symbol
            client.chainConfig = {
                'Ethereum': { chain_id: 1, env: ENV.PROD_MULTI_AVAX } as any // No native_symbol
            };
            client.portfolioMainContracts = { 'Ethereum': mockContract };
            client.tokenData = { 
                'ETH': { [ENV.PROD_MULTI_AVAX]: { address: '0x0', decimals: 18, chainId: 1, env: ENV.PROD_MULTI_AVAX } as any }
            };
            
            mockContract.depositNative.estimateGas.mockResolvedValue(100n);
            
            // ETH is the default native symbol
            await client.deposit('ETH', 1, 'Ethereum');
            expect(mockContract.depositNative).toHaveBeenCalled();
        });

        it('deposit should return error when token address not found (chainEnv null - line 75)', async () => {
            client.chainConfig = {
                'Ethereum': { chain_id: 1 } as any // No env property
            };
            client.portfolioMainContracts = { 'Ethereum': mockContract };
            client.tokenData = { 
                'USDC': { 'some-other-env': { address: '0xUSDC', decimals: 6 } as any }
            };
            
            // USDC is not native, so ERC20 path with no chainEnv
            const result = await client.deposit('USDC', 100, 'Ethereum');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Token address for USDC not found on Ethereum');
        });

        it('_getBridgeFee should use signer when portfolioContract.runner missing (line 354)', async () => {
            // Contract without runner but with portfolioBridge
            const contractNoRunner = {
                ...mockContract,
                runner: null, // No runner
                portfolioBridge: jest.fn().mockResolvedValue('0xBridgeAddr')
            };
            
            const mockBridge = { getBridgeFee: jest.fn().mockResolvedValue(100n) };
            (Contract as unknown as jest.Mock).mockImplementation(() => mockBridge);
            
            const fee = await client._getBridgeFee(contractNoRunner as any, 1, '0xSym', 100n);
            expect(fee).toBe(100n);
        });

        it('_getBridgeFee should use provider when signer also missing (line 354)', async () => {
            const contractNoRunner = {
                ...mockContract,
                runner: null,
                portfolioBridge: jest.fn().mockResolvedValue('0xBridgeAddr')
            };
            client.signer = undefined as any;
            client.provider = { getBalance: jest.fn() } as any; // Provider exists
            
            const mockBridge = { getBridgeFee: jest.fn().mockResolvedValue(50n) };
            (Contract as unknown as jest.Mock).mockImplementation(() => mockBridge);
            
            const fee = await client._getBridgeFee(contractNoRunner as any, 1, '0xSym', 100n);
            expect(fee).toBe(50n);
        });

        it('_getBridgeFee should return 0n when signer.getAddress fails (line 356 catch path)', async () => {
            const contractNoRunner = {
                ...mockContract,
                runner: null,
                portfolioBridge: jest.fn().mockResolvedValue('0xBridgeAddr')
            };
            client.signer = {} as any; // Signer without getAddress - will throw
            
            const mockBridge = { getBridgeFee: jest.fn().mockResolvedValue(75n) };
            (Contract as unknown as jest.Mock).mockImplementation(() => mockBridge);
            
            // When signer.getAddress() fails, the catch block returns 0n
            const fee = await client._getBridgeFee(contractNoRunner as any, 1, '0xSym', 100n);
            expect(fee).toBe(0n);
        });

        it('_getBridgeFee should use subnetChainId fallback of 0 (line 360)', async () => {
            client.subnetChainId = undefined as any; // No subnetChainId

            mockContract.portfolioBridge.mockResolvedValue('0xBridgeAddr');
            const mockBridge = { getBridgeFee: jest.fn().mockResolvedValue(25n) };
            (Contract as unknown as jest.Mock).mockImplementation(() => mockBridge);

            const fee = await client._getBridgeFee(mockContract as any, 1, '0xSym', 100n);
            expect(fee).toBe(25n);
            // Check it was called with 0 as subnetChainId
            expect(mockBridge.getBridgeFee).toHaveBeenCalledWith(
                1, 0, '0xSym', 100n, expect.any(String), '0x00'
            );
        });
    });

    describe('decimals fallback from subnetChainId to chainId', () => {
        it('getPortfolioBalance should use chainId decimals when subnetChainId decimals not found (line 50)', async () => {
            mockContract.getBalance.mockResolvedValue([100n, 50n, 50n]);
            // Token only has decimals for chainId (43114), NOT for subnetChainId (12345)
            client.tokenData = {
                'SPECIAL': {
                    'prod': { address: '0xSPEC', decimals: 8, chainId: 43114, env: 'prod' } as any
                }
            };
            client.subnetChainId = 12345;
            client.chainId = 43114;

            const result = await client.getPortfolioBalance('SPECIAL');
            expect(result.success).toBe(true);
            // The fallback path: _getTokenDecimals(SPECIAL, 12345) returns null,
            // then _getTokenDecimals(SPECIAL, 43114) returns 8
        });

        it('getAllPortfolioBalances should use chainId decimals when subnetChainId decimals not found (line 650)', async () => {
            // Return one page with a symbol, then empty page to stop
            mockContract.getBalances
                .mockResolvedValueOnce([['0xSpecial'], [200n], [150n]])
                .mockResolvedValueOnce([[], [], []]);

            // fromBytes32 should return the symbol name
            (Utils.fromBytes32 as jest.Mock).mockReturnValue('SPECIAL');

            // Token only has decimals for chainId (43114), NOT for subnetChainId (12345)
            client.tokenData = {
                'SPECIAL': {
                    'prod': { address: '0xSPEC', decimals: 8, chainId: 43114, env: 'prod' } as any
                }
            };
            client.subnetChainId = 12345;
            client.chainId = 43114;

            const result = await client.getAllPortfolioBalances();
            expect(result.success).toBe(true);
            expect(result.data!['SPECIAL']).toBeDefined();
        });

        it('getPortfolioBalance should fallback to 18 decimals when token unknown on all chains (line 50 ?? 18)', async () => {
            mockContract.getBalance.mockResolvedValue([100n, 50n, 50n]);
            // Empty tokenData so _getTokenDecimals returns null for every chainId
            client.tokenData = {};
            client.subnetChainId = 12345;
            client.chainId = 43114;

            const result = await client.getPortfolioBalance('NOTOKEN');
            expect(result.success).toBe(true);
            // _getTokenDecimals('NOTOKEN', 12345) -> null (enter if block)
            // _getTokenDecimals('NOTOKEN', 43114) -> null, so null ?? 18 = 18
            expect(result.data!.total).toBe(10); // Mocked Utils returns '10'
        });

        it('getAllPortfolioBalances should fallback to 18 decimals when token unknown on all chains (line 650 ?? 18)', async () => {
            mockContract.getBalances
                .mockResolvedValueOnce([['0xNoToken'], [300n], [200n]])
                .mockResolvedValueOnce([[], [], []]);

            (Utils.fromBytes32 as jest.Mock).mockReturnValue('NOTOKEN');

            // Empty tokenData so _getTokenDecimals returns null for every chainId
            client.tokenData = {};
            client.subnetChainId = 12345;
            client.chainId = 43114;

            const result = await client.getAllPortfolioBalances();
            expect(result.success).toBe(true);
            expect(result.data!['NOTOKEN']).toBeDefined();
            // _getTokenDecimals('NOTOKEN', 12345) -> null (enter if block)
            // _getTokenDecimals('NOTOKEN', 43114) -> null, so null ?? 18 = 18
        });
    });

    describe('_resolveTokenDecimals', () => {
        it('should return subnet decimals when available', () => {
            client.subnetChainId = 12345;
            client.chainId = 43114;
            client.tokenData = {
                'AVAX': { 'subnet': { decimals: 8, chainId: 12345 } as any }
            };
            expect((client as any)._resolveTokenDecimals('AVAX')).toBe(8);
        });

        it('should fall back to connected chain decimals', () => {
            client.subnetChainId = 12345;
            client.chainId = 43114;
            client.tokenData = {
                'AVAX': { 'mainnet': { decimals: 6, chainId: 43114 } as any }
            };
            expect((client as any)._resolveTokenDecimals('AVAX')).toBe(6);
        });

        it('should fall back to 18 when no decimals found anywhere', () => {
            client.subnetChainId = 12345;
            client.chainId = 43114;
            client.tokenData = {};
            expect((client as any)._resolveTokenDecimals('UNKNOWN')).toBe(18);
        });
    });

});
