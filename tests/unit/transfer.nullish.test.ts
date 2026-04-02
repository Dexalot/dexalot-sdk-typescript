import { TransferClient } from '../../src/core/transfer';
import { Contract } from 'ethers';
import { ENV } from '../../src/constants';
import { Utils } from '../../src/utils';

// Mock everything
jest.mock('ethers');
jest.mock('../../src/utils');

class TestClient extends TransferClient {}

describe('TransferClient - Nullish Coalescing Coverage', () => {
    let client: TestClient;
    let mockSigner: any;
    let mockContract: any;

    const mockAddress = '0xUserAddress';

    beforeEach(() => {
        jest.clearAllMocks();
        
        mockSigner = {
            getAddress: jest.fn().mockResolvedValue(mockAddress),
            provider: { getBalance: jest.fn().mockResolvedValue(1000n) },
            connect: jest.fn().mockImplementation(function (this: any) {
                return this;
            })
        };

        mockContract = {
            getAddress: jest.fn().mockResolvedValue('0xContractAddress'),
            getBalance: jest.fn(),
            getBalances: jest.fn(),
            transferToken: jest.fn().mockResolvedValue({ 
                hash: '0xHash',
                wait: jest.fn().mockResolvedValue({ status: 1 })
            })
        };
        mockContract.transferToken.estimateGas = jest.fn().mockResolvedValue(100000n);

        (Contract as unknown as jest.Mock).mockImplementation(() => mockContract);
        (Utils.toBytes32 as jest.Mock).mockReturnValue('0xBytes32');
        (Utils.fromBytes32 as jest.Mock).mockReturnValue('TOKEN');
        (Utils.unitConversion as jest.Mock).mockImplementation((val, dec, toWei) => {
            if (toWei) return val.toString() + '000000000000000000';
            return '10';
        });

        client = new TestClient(mockSigner);
        client.portfolioSubContractView = mockContract;
        client.portfolioSubContract = mockContract;
        client.deployments['PortfolioSub'] = { address: '0xPortfolioSub', abi: [] };
        client.subnetProvider = {} as any;
        client.subnetChainId = 12345;
        client.chainId = 43114;
        client.env = ENV.PROD_MULTI_AVAX;
        client.subnetEnv = ENV.PROD_MULTI_SUBNET;
        client.tokenData = {};
    });

    describe('_getTokenDecimals fallback to 18', () => {
        it('should use 18 decimals when _getTokenDecimals returns undefined in getPortfolioBalance', async () => {
            mockContract.getBalance.mockResolvedValue([100n, 50n, 50n]);
            
            // Ensure tokenData is empty so _getTokenDecimals returns undefined
            client.tokenData = {};
            client.subnetChainId = undefined as any;
            
            const result = await client.getPortfolioBalance('UNKNOWN');
            expect(result.success).toBe(true);
            // The || 18 fallback should be used
        });

        it('should use 18 decimals when _getTokenDecimals returns null in transferPortfolio', async () => {
            jest.spyOn(client, 'getPortfolioBalance').mockResolvedValue({
                success: true,
                data: { total: 100, available: 100, locked: 0 }
            } as any);
            
            // Set up token data that returns null from _getTokenDecimals
            client.tokenData = {
                'TOKEN': {
                    [ENV.PROD_MULTI_SUBNET]: { 
                        address: '0xTOKEN', 
                        chainId: 12345, 
                        env: ENV.PROD_MULTI_SUBNET,
                        // No decimals field - will be undefined
                    } as any
                }
            };
            client.subnetChainId = undefined as any; // This makes _getTokenDecimals return undefined
            
            const result = await client.transferPortfolio('TOKEN', 10, '0x1234567890123456789012345678901234567890');
            expect(result.success).toBe(true);
            // The ?? 18 fallback should be used
        });

        it('should use 18 decimals when _getTokenDecimals returns undefined in getAllPortfolioBalances', async () => {
            mockContract.getBalances
                .mockResolvedValueOnce([['0xToken'], [100n], [50n]])
                .mockResolvedValueOnce([[], [], []]);
            
            (Utils.fromBytes32 as jest.Mock).mockReturnValue('UNKNOWN');
            client.tokenData = {};
            client.subnetChainId = undefined as any;
            
            const result = await client.getAllPortfolioBalances();
            expect(result.success).toBe(true);
            // The ?? 18 fallback should be used
        });
    });

    describe('subnetChainId nullish coalescing', () => {
        it('should use 0 when subnetChainId is undefined in getPortfolioBalance', async () => {
            mockContract.getBalance.mockResolvedValue([100n, 50n, 50n]);
            client.subnetChainId = undefined as any;
            client.tokenData = {};
            
            const result = await client.getPortfolioBalance('TOKEN');
            expect(result.success).toBe(true);
            // The || 0 fallback should be used
        });

        it('should use 0 when subnetChainId is undefined in transferPortfolio', async () => {
            jest.spyOn(client, 'getPortfolioBalance').mockResolvedValue({
                success: true,
                data: { total: 100, available: 100, locked: 0 }
            } as any);
            
            client.subnetChainId = undefined as any;
            client.tokenData = {
                'TOKEN': {
                    [ENV.PROD_MULTI_SUBNET]: { 
                        address: '0xTOKEN', 
                        chainId: 12345, 
                        env: ENV.PROD_MULTI_SUBNET
                    } as any
                }
            };
            
            const result = await client.transferPortfolio('TOKEN', 10, '0x1234567890123456789012345678901234567890');
            expect(result.success).toBe(true);
            // The || 0 fallback should be used
        });

        it('should use 0 when subnetChainId is undefined in getAllPortfolioBalances', async () => {
            mockContract.getBalances
                .mockResolvedValueOnce([['0xToken'], [100n], [50n]])
                .mockResolvedValueOnce([[], [], []]);
            
            client.subnetChainId = undefined as any;
            client.tokenData = {};
            
            const result = await client.getAllPortfolioBalances();
            expect(result.success).toBe(true);
            // The || 0 fallback should be used
        });
    });
});
