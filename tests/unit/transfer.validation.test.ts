import { TransferClient } from '../../src/core/transfer';
import { ethers, Contract, MaxUint256 } from 'ethers';
import { ENV } from '../../src/constants';

// Mock everything
jest.mock('ethers');
jest.mock('../../src/utils');

// We need a concrete class to test the mixin
class TestClient extends TransferClient {}

describe('TransferClient - Additional Coverage', () => {
    let client: TestClient;
    let mockSigner: any;
    let mockContract: any;

    const mockAddress = '0xUserAddress';
    const mockTokenAddr = '0xAvaxTokenAddr';

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup Signer
        mockSigner = {
            getAddress: jest.fn().mockResolvedValue(mockAddress),
            provider: { getBalance: jest.fn().mockResolvedValue(1000n) },
            connect: jest.fn().mockImplementation(function (this: any) {
                return this;
            })
        };

        // Setup Contract Mock
        mockContract = {
            getAddress: jest.fn().mockResolvedValue('0xContractAddress'),
            getBalance: jest.fn(),
            balanceOf: jest.fn().mockResolvedValue(100n),
            depositNative: jest.fn().mockResolvedValue({ hash: '0xDepositNativeHash' }),
            depositToken: jest.fn().mockResolvedValue({ hash: '0xDepositTokenHash' }),
            withdrawToken: jest.fn().mockResolvedValue({ hash: '0xWithdrawTokenHash' }),
            transferToken: jest.fn().mockResolvedValue({ hash: '0xTransferTokenHash' }),
            withdrawNative: jest.fn().mockResolvedValue({ hash: '0xWithdrawNativeHash' }),
            getBalances: jest.fn(),
            allowance: jest.fn().mockResolvedValue(MaxUint256),
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

        // Setup Contract Constructor Mock
        (Contract as unknown as jest.Mock).mockImplementation(() => mockContract);

        client = new TestClient(mockSigner);
        
        // Manual setup of client properties
        client.portfolioSubContractView = mockContract;
        client.portfolioMainContracts = { 'Avalanche': mockContract };
        client.portfolioSubContract = mockContract;
        client.deployments['PortfolioSub'] = { address: '0xPortfolioSub', abi: [] };
        client.subnetProvider = {} as any;
        client.subnetChainId = 12345;
        client.chainId = 43114;
        client.env = ENV.PROD_MULTI_AVAX;
        client.subnetEnv = ENV.PROD_MULTI_SUBNET;
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

    describe('Input Validation', () => {
        describe('deposit validation', () => {
            it('should return error for invalid token symbol', async () => {
                const result = await client.deposit('invalid', 10, 'Avalanche');
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });

            it('should return error for invalid amount', async () => {
                const result = await client.deposit('AVAX', -5, 'Avalanche');
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });

            it('should return error for zero amount', async () => {
                const result = await client.deposit('AVAX', 0, 'Avalanche');
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });
        });

        describe('withdraw validation', () => {
            it('should return error for invalid token symbol', async () => {
                const result = await client.withdraw('lowercase', 10, 'Destination');
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });

            it('should return error for invalid amount', async () => {
                const result = await client.withdraw('AVAX', -10, 'Destination');
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });
        });

        describe('transferPortfolio validation', () => {
            it('should return error for invalid token symbol', async () => {
                const result = await client.transferPortfolio('bad-token', 10, '0x1234567890123456789012345678901234567890');
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });

            it('should return error for invalid amount', async () => {
                const result = await client.transferPortfolio('AVAX', -5, '0x1234567890123456789012345678901234567890');
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });

            it('should return error for invalid address', async () => {
                const result = await client.transferPortfolio('AVAX', 10, 'not-an-address');
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });
        });

        describe('addGas validation', () => {
            it('should return error for invalid amount', async () => {
                const result = await client.addGas(-10);
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });
        });

        describe('removeGas validation', () => {
            it('should return error for invalid amount', async () => {
                const result = await client.removeGas(0);
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });
        });

        describe('getChainWalletBalance validation', () => {
            it('should return error for invalid token symbol', async () => {
                const result = await client.getChainWalletBalance('Avalanche', '123invalid');
                expect(result.success).toBe(false);
                expect(result.error).toBeDefined();
            });
        });
    });

    describe('Helper Methods Edge Cases', () => {
        describe('_ensureAllowance', () => {
            it('should use signer when runner not provided', async () => {
                mockContract.allowance.mockResolvedValue(0n);
                mockContract.approve.mockResolvedValue({ wait: jest.fn().mockResolvedValue({}) });
                
                await client._ensureAllowance(mockTokenAddr, '0xSpender', 1000n);
                
                expect(mockContract.allowance).toHaveBeenCalled();
                expect(mockContract.approve).toHaveBeenCalledWith('0xSpender', MaxUint256);
            });
        });

        describe('_getTokenDecimals nullish coalescing', () => {
            it('should default to 18 when token decimals not found', async () => {
                mockContract.getBalance.mockResolvedValue([100n, 50n, 50n]);
                client.tokenData = {};
                
                const result = await client.getPortfolioBalance('UNKNOWN');
                expect(result.success).toBe(true);
            });
        });
    });
});
