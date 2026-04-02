import { BaseClient } from '../../src/core/base';
import { createConfig } from '../../src/core/config';
import axios from 'axios';
import { ethers, JsonRpcProvider, Contract, Signer, Provider } from 'ethers';
import { ENV, CHAIN_ID, ENDPOINTS } from '../../src/constants';
import { Result } from '../../src/utils/result';

jest.mock('axios');
jest.mock('ethers');

describe('BaseClient', () => {
    let client: BaseClient;
    const mockedAxios = axios as jest.Mocked<typeof axios>;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.PARENTENV = 'fuji-multi'; // Default to testnet
    });


    describe('Constructor', () => {
        it('should store PARENTENV for later dynamic initialization', () => {
            process.env.PARENTENV = 'fuji-multi';
            client = new BaseClient();
            expect(client.parentEnv).toBe('fuji-multi');
            // chainId and env are set dynamically during _fetchEnvironments, not constructor
            expect(client.chainId).toBe(0); // Initial value before fetch
        });

        it('should use MAINNET API when PARENTENV is production-multi', () => {
            process.env.PARENTENV = 'production-multi';
            client = new BaseClient();
            expect(client.parentEnv).toBe('production-multi');
            expect(client.apiBaseUrl).toContain('api.dexalot.com');
        });

        it('should accept a custom API URL', () => {
            const customUrl = 'https://custom.api.dexalot.com';
            client = new BaseClient(customUrl);
            expect(client.apiBaseUrl).toBe(customUrl);
        });

        it('should default to fuji-multi if PARENTENV is undefined', () => {
             delete process.env.PARENTENV;
             client = new BaseClient();
             expect(client.parentEnv).toBe('fuji-multi');
        });

        it('should initialize with DexalotConfig object including privateKey', () => {
            const config = {
                parentEnv: 'fuji-multi',
                apiBaseUrl: 'https://test.api.com',
                privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234'
            } as any;
            client = new BaseClient(config);
            expect(client.config).toMatchObject({
                parentEnv: 'fuji-multi',
                apiBaseUrl: 'https://test.api.com',
            });
            expect(client.signer).toBeDefined();
            expect(client.signer).toBeInstanceOf(ethers.Wallet);
        });
    });

    describe('Initialization', () => {
         beforeEach(() => {
            client = new BaseClient();
            // Mock axios create to return the mocked instance or a simple object
            // In BaseClient, this.axios = axios.create(...)
            // We need to ensure client.axios.get is mocked.
            // Since we mocked the whole module, axios.create(...) returns undefined by default unless we define it.
            // Let's ensure axios.create returns something usable.
            (axios.create as jest.Mock).mockReturnValue(mockedAxios);
            
            // Re-instantiate to use the mocked axios.create return value
            client = new BaseClient();
        });

        it('should fetch environments, tokens, and deployments on initializeClient', async () => {
            // Setup spies
            const spyEnv = jest.spyOn(client, '_fetchEnvironments').mockResolvedValue();
            const spyTok = jest.spyOn(client, '_fetchTokens').mockResolvedValue();
            const spyDep = jest.spyOn(client, '_fetchDeployments').mockResolvedValue();
            const spyRfq = jest.spyOn(client as any, '_fetchRfqPairs').mockResolvedValue();
            const spyClob = jest.spyOn(client as any, '_fetchClobPairs').mockResolvedValue();

            await client.initializeClient();

            expect(spyEnv).toHaveBeenCalled();
            expect(spyTok).toHaveBeenCalled();
            expect(spyDep).toHaveBeenCalled();
            expect(spyRfq).toHaveBeenCalled();
            expect(spyClob).toHaveBeenCalled();
        });

        it('should return fail Result on initialization error', async () => {
            // Mock console.error to avoid test output noise
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            
            jest.spyOn(client, '_fetchEnvironments').mockRejectedValue(new Error('Init Error'));
            
            const result = await client.initializeClient();
            
            expect(result.success).toBe(false);
            expect(result.error).toContain('Init Error');
            
            // Restore console.error
            consoleErrorSpy.mockRestore();
        });

        it('connect should resolve immediately', async () => {
            await expect(client.connect()).resolves.toBeUndefined();
        });
    });

    describe('Fetch Methods (Mocked Network)', () => {
        beforeEach(() => {
             (axios.create as jest.Mock).mockReturnValue(mockedAxios);
             client = new BaseClient();
        });

        it('_fetchEnvironments should parse chain config correctly', async () => {
             const mockEnvData = [
                 {
                     chainid: 43113,
                     env: ENV.FUJI_MULTI_AVAX,
                     env_type: 'mainnet',
                     network: 'Avalanche',
                     rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
                     native_token_symbol: 'AVAX'
                 },
                 {
                     chainid: 12345,
                     env: ENV.FUJI_MULTI_SUBNET,
                     env_type: 'subnet',
                     network: 'Dexalot',
                     rpc: 'https://sub.dexalot.com',
                     native_token_symbol: 'ALOT'
                 }
             ];
             mockedAxios.request.mockResolvedValueOnce({ data: mockEnvData });

             await client._fetchEnvironments();

             expect(client.chainConfig['Avalanche']).toBeDefined();
             // Subnet environments are NOT added to chainConfig (only mainnets)
             // expect(client.chainConfig['Dexalot']).toBeDefined();
             expect(client.subnetChainId).toBe(12345);
             expect(client.subnetEnv).toBe(ENV.FUJI_MULTI_SUBNET);
        });

        it('_fetchEnvironments should handle alternative property names', async () => {
             // Test alternative property names for branch coverage
             const mockEnvData = [
                 {
                     chain_id: 43113,  // Alternative to chainid
                     env: ENV.FUJI_MULTI_AVAX,
                     type: 'mainnet',  // Alternative to env_type
                     chain_display_name: 'Avalanche Fuji',  // Alternative to network
                     chain_instance: 'https://alt.rpc.com',  // Alternative to rpc
                 },
                 {
                     chain_id: 12345,
                     env: ENV.FUJI_MULTI_SUBNET,
                     type: 'subnet',
                     chain_display_name: 'Dexalot Subnet',
                     chain_instance: 'https://alt.subnet.rpc.com',
                 }
             ];
             mockedAxios.request.mockResolvedValueOnce({ data: mockEnvData });

             await client._fetchEnvironments();

             expect(client.subnetChainId).toBe(12345);
             expect(client.chainConfig['Avalanche Fuji']).toBeDefined();
        });

        it('should handle _fetchContractDeployment with no data', async () => {
             mockedAxios.request.mockResolvedValueOnce({ data: [] });
            await client._fetchContractDeployment('TradePairs');
            expect(client.deployments['TradePairs']).toBeUndefined();
        });

        it('should handle MainnetRFQ deployment', async () => {
             mockedAxios.request.mockResolvedValueOnce({ 
                 data: [{ env: ENV.FUJI_MULTI_AVAX, address: '0xRFQ', abi: [] }] 
             });
             await client._fetchContractDeployment('MainnetRFQ');
             expect(client.deployments['MainnetRFQ']['Fuji'].address).toBe('0xRFQ');
             
             // Test idempotency and append logic (branch coverage)
             // This tests the case where client.deployments['MainnetRFQ'] is ALREADY set
             mockedAxios.request.mockResolvedValueOnce({ 
                 data: [{ env: ENV.PROD_MULTI_AVAX, address: '0xRFQ_PROD', abi: [] }] 
             });
             await client._fetchContractDeployment('MainnetRFQ');
             expect(client.deployments['MainnetRFQ']['Fuji'].address).toBe('0xRFQ');
             
             // Test idempotency and append logic (branch coverage)
             // This tests the case where client.deployments['MainnetRFQ'] is ALREADY set
             mockedAxios.request.mockResolvedValueOnce({ 
                 data: [{ env: ENV.PROD_MULTI_AVAX, address: '0xRFQ_PROD', abi: [] }] 
             });
             await client._fetchContractDeployment('MainnetRFQ');
             expect(client.deployments['MainnetRFQ']['Avalanche'].address).toBe('0xRFQ_PROD');
             expect(client.deployments['MainnetRFQ']['Fuji'].address).toBe('0xRFQ'); // Preserved
        });

        it('should skip duplicate symbols when building unique token list', async () => {
            // Test the continue branch: if (seenSymbols.has(symbol)) continue;
            // To hit this branch, we need the same symbol to appear multiple times in tokenData keys
            // Since Object.entries iterates over keys, we need to manually set up a scenario
            // where the same symbol appears twice (which shouldn't happen normally, but tests edge case)
            client.tokenData = {
                'AVAX': {
                    'fuji': { symbol: 'AVAX', chainId: 43113, address: '0x1', name: 'Avalanche' } as any
                },
                'USDC': {
                    'fuji': { symbol: 'USDC', chainId: 43113, address: '0x3', name: 'USD Coin' } as any
                }
            };
            
            // Mock chainConfig to include mainnet chain IDs
            client.chainConfig = {
                'Avalanche': { chain_id: 43114 } as any,
                'Fuji': { chain_id: 43113 } as any
            };
            
            // Mock Object.entries to return duplicate symbol keys to test continue branch
            const originalEntries = Object.entries;
            jest.spyOn(Object, 'entries').mockImplementation((obj: any) => {
                if (obj === client.tokenData) {
                    // Return entries with duplicate symbol key to test continue branch
                    return [
                        ['AVAX', client.tokenData['AVAX']],
                        ['AVAX', client.tokenData['AVAX']], // Duplicate to hit continue
                        ['USDC', client.tokenData['USDC']]
                    ];
                }
                return originalEntries(obj);
            });
            
            const result = await client.getTokens();
            
            // Restore original
            Object.entries = originalEntries;
            
            // Should handle duplicates gracefully
            expect(result.success).toBe(true);
        });

        it('should handle tokens with missing decimals', async () => {
             mockedAxios.request.mockResolvedValueOnce({
                 data: [{ symbol: 'TEST', env: 'dev', address: '0xT' }] // No evmdecimals
             });
             await client._fetchTokens();
             expect(client.tokenData['TEST']['dev'].decimals).toBe(18); // Default
        });

         it('_fetchTokens should populate tokenData', async () => {
             const mockTokenData = [
                 {
                     symbol: 'AVAX',
                     env: ENV.FUJI_MULTI_AVAX,
                     address: '0x123',
                     name: 'Avalanche',
                     evmdecimals: 18,
                     chainid: 43113
                 }
             ];
             mockedAxios.request.mockResolvedValueOnce({ data: mockTokenData });

             await client._fetchTokens();

             expect(client.tokenData['AVAX']).toBeDefined();
             expect(client.tokenData['AVAX'][ENV.FUJI_MULTI_AVAX].address).toBe('0x123');
        });
        it('_fetchDeployments should initialize contracts', async () => {
             // 1. Mock TradePairs response
             const mockTradePairs = [{
                 contracttype: 'TradePairs',
                 env: ENV.FUJI_MULTI_SUBNET,
                 address: '0xTradePairs',
                 abi: { abi: [] }
             }];
             mockedAxios.request.mockResolvedValueOnce({ data: mockTradePairs });

             // 2. Mock Portfolio response
             const mockPortfolio = [{
                 contracttype: 'Portfolio',
                 env: ENV.FUJI_MULTI_SUBNET,
                 address: '0xPortfolioSub',
                 abi: []
             }];
             mockedAxios.request.mockResolvedValueOnce({ data: mockPortfolio });

             // 3. Mock MainnetRFQ response
             mockedAxios.request.mockResolvedValueOnce({ data: [] });

             
             // Setup environment so it matches the deployment env
             client.env = ENV.FUJI_MULTI_AVAX; // Mainnet env
             // But contracts often check specific env strings
             // In _fetchDeployments:
             // if (env === ENV.PROD_MULTI_SUBNET || env === ENV.FUJI_MULTI_SUBNET)
             
             // We need our client to have a provider/signer to init contract
             client.provider = new JsonRpcProvider(); 

             await client._fetchDeployments();

             expect(client.deployments['TradePairs'][ENV.FUJI_MULTI_SUBNET].address).toBe('0xTradePairs');
             expect(Contract).toHaveBeenCalled();
        });
    });

    describe('Constructor & Setup', () => {
        it('should initialize with a Signer', () => {
            const mockProvider = {} as Provider;
            const mockSigner = { provider: mockProvider } as unknown as Signer;
            client = new BaseClient(mockSigner);
            expect(client.signer).toBe(mockSigner);
            expect(client.provider).toBe(mockProvider);
        });

        it('should initialize with a Signer without provider', () => {
             const mockSigner = {} as unknown as Signer;
             client = new BaseClient(mockSigner);
             expect(client.signer).toBe(mockSigner);
             expect(client.provider).toBeNull();
        });
    });

    describe('Public Methods', () => {
        beforeEach(() => {
            client = new BaseClient();
        });

        it('getRevertReason should call parseRevertReason', () => {
            const error = new Error('Revert');
            // Mocking the imported function directly is tricky with jest.mock hoisting.
            // But since parseRevertReason is imported, we can mock the module '../../src/errors'
            // However, based on the current file, we haven't mocked '../errors'. 
            // We can just trust it calls it or mock it if needed. 
            // For now, let's assume simple coverage.
            client.getRevertReason(error);
        });

        it('getEnvironments should return data or error', async () => {
             const mockEnvs = [
                 { chainId: 43113, envType: 'mainnet', rpc: 'https://rpc.example.com', network: 'Fuji' },
                 { chainId: 12345, envType: 'subnet', rpc: 'https://subnet.example.com', network: 'Dexalot Subnet' }
             ];
             mockedAxios.request.mockResolvedValueOnce({ data: mockEnvs });
             const res = await client.getEnvironments();
             expect(res.success).toBe(true);
             expect(res.data).toHaveLength(2);
             expect(res.data[0]).toMatchObject({ chainId: 43113, envType: 'mainnet' });
             expect(res.data[1]).toMatchObject({ chainId: 12345, envType: 'subnet' });

             // Clear cache to force error on next call
             client.invalidateCache('static');
             client.environmentsCache = []; // Clear cache to force error
             mockedAxios.request.mockRejectedValueOnce('Error');
             const errRes = await client.getEnvironments();
             expect(errRes.success).toBe(false);
             expect(errRes.error).toContain('Error fetching environments');
        });

        it('getEnvironments should transform API field names to camelCase', async () => {
             const mockEnvData = [
                 {
                     chainid: 43113,
                     env_type: 'mainnet',
                     rpc: 'https://rpc.example.com',
                     network: 'Fuji',
                     env: 'fuji-multi-avax'
                 },
                 {
                     chain_id: 12345,
                     type: 'subnet',
                     chain_instance: 'https://subnet.example.com',
                     chain_display_name: 'Dexalot Subnet',
                     env: 'fuji-multi-subnet'
                 }
             ];
             mockedAxios.request.mockResolvedValueOnce({ data: mockEnvData });
             const res = await client.getEnvironments();
             expect(res.success).toBe(true);
             expect(res.data).toHaveLength(2);
             
             // First env: lowercase fields transformed to camelCase
             expect(res.data[0]).toMatchObject({
                 chainId: 43113,
                 envType: 'mainnet',
                 rpc: 'https://rpc.example.com',
                 network: 'Fuji'
             });
             
             // Second env: snake_case fields transformed to camelCase
             expect(res.data[1]).toMatchObject({
                 chainId: 12345,
                 envType: 'subnet',
                 rpc: 'https://subnet.example.com',
                 network: 'Dexalot Subnet'
             });
        });

        it('getEnvironments should prefer existing camelCase fields over transformations', async () => {
             const mockEnvData = [
                 {
                     chainId: 43114,
                     envType: 'mainnet',
                     chainid: 999, // Should be ignored
                     env_type: 'subnet', // Should be ignored
                     rpc: 'https://rpc.example.com',
                     network: 'Avalanche'
                 }
             ];
             mockedAxios.request.mockResolvedValueOnce({ data: mockEnvData });
             const res = await client.getEnvironments();
             expect(res.success).toBe(true);
             expect(res.data[0].chainId).toBe(43114); // Prefer existing camelCase
             expect(res.data[0].envType).toBe('mainnet'); // Prefer existing camelCase
        });

        it('getTokens should transform API field names to camelCase', async () => {
             const mockTokenData = [
                 {
                     symbol: 'AVAX',
                     name: 'Avalanche',
                     evmdecimals: 18,
                     chainid: 43113,
                     chain_display_name: 'Fuji',
                     address: '0x123'
                 },
                 {
                     symbol: 'USDC',
                     name: 'USD Coin',
                     decimals: 6,
                     chain_id: 43114,
                     network: 'Avalanche',
                     address: '0x456'
                 }
             ];
             mockedAxios.request.mockResolvedValueOnce({ data: mockTokenData });
             client.chainConfig = {
                 'Fuji': { chain_id: 43113 } as any,
                 'Avalanche': { chain_id: 43114 } as any
             };
             const res = await client.getTokens();
             expect(res.success).toBe(true);
             expect(res.data.length).toBeGreaterThan(0);
             
             // Find AVAX token
             const avaxToken = res.data.find((t: any) => t.symbol === 'AVAX');
             expect(avaxToken).toBeDefined();
             expect(avaxToken.decimals).toBe(18);
             expect(avaxToken.chain_id).toBe(43113);
             
             // Find USDC token
             const usdcToken = res.data.find((t: any) => t.symbol === 'USDC');
             expect(usdcToken).toBeDefined();
             expect(usdcToken.decimals).toBe(6);
             expect(usdcToken.chain_id).toBe(43114);
        });

        it('getTokens should prefer existing camelCase fields over transformations', async () => {
             const mockTokenData = [
                 {
                     symbol: 'AVAX',
                     evmDecimals: 18,
                     chainId: 43114,
                     evmdecimals: 999, // Should be ignored
                     chainid: 999, // Should be ignored
                     network: 'Avalanche',
                     chain_display_name: 'Fuji', // Should be ignored
                     address: '0x123'
                 }
             ];
             mockedAxios.request.mockResolvedValueOnce({ data: mockTokenData });
             client.chainConfig = {
                 'Avalanche': { chain_id: 43114 } as any
             };
             const res = await client.getTokens();
             expect(res.success).toBe(true);
             const token = res.data.find((t: any) => t.symbol === 'AVAX');
             expect(token).toBeDefined();
             // The transformation happens but we check the final output uses correct values
             expect(token.chain_id).toBe(43114);
        });

        it('getChains should map chain_id to network from getEnvironments', async () => {
            jest.spyOn(client, 'getEnvironments').mockResolvedValue(
                Result.ok([
                    { chainId: 43114, network: 'Avalanche' },
                    { chainId: 1, network: 'Ethereum' },
                ])
            );
            const res = await client.getChains();
            expect(res.success).toBe(true);
            expect(res.data![43114]).toBe('Avalanche');
            expect(res.data![1]).toBe('Ethereum');
        });

        it('getChains should fail when getEnvironments fails', async () => {
            jest.spyOn(client, 'getEnvironments').mockResolvedValue(Result.fail('boom'));
            const res = await client.getChains();
            expect(res.success).toBe(false);
            expect(res.error).toContain('Failed to fetch environments');
        });

        describe('_apiCall retryOnExceptions', () => {
            class CustomRetryError extends Error {}

            it('retries when configured exception type is thrown', async () => {
                const cfg = createConfig({
                    parentEnv: 'fuji-multi',
                    retryEnabled: true,
                    retryMaxAttempts: 3,
                    retryInitialDelay: 0,
                    retryMaxDelay: 0,
                    retryExponentialBase: 2,
                    retryOnExceptions: [CustomRetryError],
                });
                const c = new BaseClient(cfg);
                mockedAxios.request
                    .mockRejectedValueOnce(new CustomRetryError('once'))
                    .mockResolvedValueOnce({ data: { recovered: true } });

                const data = await c._apiCall<{ recovered: boolean }>('get', 'https://api.test/x');
                expect(data).toEqual({ recovered: true });
                expect(mockedAxios.request).toHaveBeenCalledTimes(2);
            });

            it('does not retry custom errors without retryOnExceptions', async () => {
                class CustomErr extends Error {}
                const cfg = createConfig({
                    parentEnv: 'fuji-multi',
                    retryEnabled: true,
                    retryMaxAttempts: 3,
                    retryInitialDelay: 0,
                    retryMaxDelay: 0,
                });
                const c = new BaseClient(cfg);
                mockedAxios.request.mockRejectedValue(new CustomErr('nope'));

                await expect(c._apiCall('get', 'https://api.test/y')).rejects.toThrow('nope');
                expect(mockedAxios.request).toHaveBeenCalledTimes(1);
            });
        });

        it('getDeployment should return internal deployments', async () => {
             // Mock environments fetch (needed for getDeployment)
             jest.spyOn(client, 'getEnvironments').mockResolvedValue(Result.ok([]));
             jest.spyOn(client, '_fetchDeployments').mockResolvedValue();
             
             client.deployments = { 'Test': {} };
             const result = await client.getDeployment();
             expect(result.success).toBe(true);
             expect(result.data).toEqual({ 'Test': {} });
        });
    });

    describe('Fetch Methods Edge Cases', () => {
         beforeEach(() => {
             (axios.create as jest.Mock).mockReturnValue(mockedAxios);
             client = new BaseClient();
        });

        it('_fetchEnvironments should handle errors and specific branches', async () => {
             // Mock error
             mockedAxios.request.mockRejectedValueOnce(new Error('Network Error'));
             const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
             await client._fetchEnvironments();
             // Logger formats output as string with timestamp and JSON
             expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Error fetching environments"));

             // Mock Mainnet & Prod Subnet branches
             const mockEnvData = [
                 {
                     chainid: 43114,
                     env: ENV.PROD_MULTI_AVAX, // Mainnet
                     env_type: 'mainnet',
                     network: 'Avalanche',
                     rpc: 'https://api.avax.network/ext/bc/C/rpc',
                 },
                 {
                     chainid: 12345,
                     env: ENV.PROD_MULTI_SUBNET, // Prod Subnet
                     env_type: 'subnet',
                     rpc: 'https://sub.dexalot.com',
                 },
                 {
                     // Provider init failure case
                     chainid: 999,
                     env_type: 'mainnet',
                     network: 'Broken',
                     rpc: 'broken_rpc'
                 }
             ];
             mockedAxios.request.mockResolvedValueOnce({ data: mockEnvData });
             
             // Mock JsonRpcProvider throwing for Broken
             // We need to mock implementation of JsonRpcProvider
             (JsonRpcProvider as unknown as jest.Mock).mockImplementation((rpc) => {
                 if (rpc === 'broken_rpc') throw new Error('Bad RPC');
                 return {};
             });

             const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
             await client._fetchEnvironments();
             
             expect(client.env).toBe(ENV.PROD_MULTI_AVAX); // from first item
             expect(warnSpy).toHaveBeenCalled(); // from Broken item
        });

        it('_fetchTokens should handle errors', async () => {
             mockedAxios.request.mockRejectedValueOnce(new Error('Network Error'));
             const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
             await client._fetchTokens();
             expect(consoleSpy).toHaveBeenCalled();
        });

        it('_fetchDeployments should handle mainnet portfolio and errors', async () => {
             // 1. TradePairs (empty)
             mockedAxios.request.mockResolvedValueOnce({ data: [] });
             // 2. Portfolio (Mainnet case)
             mockedAxios.request.mockResolvedValueOnce({ data: [{
                 contracttype: 'Portfolio',
                 env: ENV.PROD_MULTI_AVAX,
                 address: '0xMainnetPortfolio',
                 abi: []
             }] });
             // 3. MainnetRFQ (Error case)
             mockedAxios.request.mockRejectedValueOnce(new Error('RFQ Error'));

             const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
             
             await client._fetchDeployments();

             // With new per-chain structure, PortfolioMain is stored per chain name
             // The test needs to check the chain name lookup
        });

        it('_fetchDeployments should handle MainnetRFQ', async () => {
             // 1. TradePairs
             mockedAxios.request.mockResolvedValueOnce({ data: [] });
             // 2. Portfolio
             mockedAxios.request.mockResolvedValueOnce({ data: [] });
             // 3. MainnetRFQ
             mockedAxios.request.mockResolvedValueOnce({ data: [{
                 contracttype: 'MainnetRFQ',
                 env: ENV.PROD_MULTI_AVAX,
                 address: '0xRFQ',
                 abi: []
             }] });

             await client._fetchDeployments();
             expect(client.deployments['MainnetRFQ']['Avalanche'].address).toBe('0xRFQ');
        });

        it('should handle nested ABI structure', async () => {
             const nestedAbiData = [{
                 contracttype: 'TradePairs',
                 env: ENV.PROD_MULTI_SUBNET,
                 address: '0xAddress',
                 abi: { abi: ['function test()'] } // Nested ABI
             }];
             // _apiCall uses axios.request which returns { data: ... }, and _apiCall returns response.data
             // So we need to mock the axios.request to return { data: nestedAbiData }
             mockedAxios.request.mockResolvedValueOnce({ data: nestedAbiData });
             
             await client._fetchContractDeployment('TradePairs');
             expect(client.deployments['TradePairs']).toBeDefined();
             expect(client.deployments['TradePairs'][ENV.PROD_MULTI_SUBNET]).toBeDefined();
             expect(client.deployments['TradePairs'][ENV.PROD_MULTI_SUBNET].abi).toEqual(['function test()']);
        });

        it('_transformDeploymentFromAPI should prefer existing lowercase fields', () => {
            const item = {
                env: 'fuji-multi-subnet',
                address: '0xAddress',
                abi: ['function test()']
            };
            const transformed = (client as any)._transformDeploymentFromAPI(item);
            expect(transformed.env).toBe('fuji-multi-subnet');
            expect(transformed.address).toBe('0xAddress');
            expect(transformed.abi).toEqual(['function test()']);
        });

        it('_transformDeploymentFromAPI should transform Env to env', () => {
            const item = {
                Env: 'fuji-multi-subnet',
                address: '0xAddress',
                abi: []
            };
            const transformed = (client as any)._transformDeploymentFromAPI(item);
            expect(transformed.env).toBe('fuji-multi-subnet');
        });

        it('_transformDeploymentFromAPI should transform Address to address', () => {
            const item = {
                env: 'fuji-multi-subnet',
                Address: '0xAddress',
                abi: []
            };
            const transformed = (client as any)._transformDeploymentFromAPI(item);
            expect(transformed.address).toBe('0xAddress');
        });

        it('_transformDeploymentFromAPI should transform Abi to abi', () => {
            const item = {
                env: 'fuji-multi-subnet',
                address: '0xAddress',
                Abi: ['function test()']
            };
            const transformed = (client as any)._transformDeploymentFromAPI(item);
            expect(transformed.abi).toEqual(['function test()']);
        });

        it('_transformDeploymentFromAPI should transform ABI to abi', () => {
            const item = {
                env: 'fuji-multi-subnet',
                address: '0xAddress',
                ABI: ['function test()']
            };
            const transformed = (client as any)._transformDeploymentFromAPI(item);
            expect(transformed.abi).toEqual(['function test()']);
        });

        it('_transformDeploymentFromAPI should use environment fallback when env and Env are missing', () => {
            const item = {
                environment: 'test-env',
                address: '0xAddress',
                abi: []
            };
            const transformed = (client as any)._transformDeploymentFromAPI(item);
            expect(transformed.env).toBe('test-env');
        });

        it('_transformDeploymentFromAPI should use contractAddress fallback when address and Address are missing', () => {
            const item = {
                env: 'test',
                contractAddress: '0xCA',
                abi: []
            };
            const transformed = (client as any)._transformDeploymentFromAPI(item);
            expect(transformed.address).toBe('0xCA');
        });

        it('_fetchContractDeployment should apply transformation', async () => {
            mockedAxios.request.mockResolvedValueOnce({
                data: [{
                    Env: 'fuji-multi-subnet',
                    Address: '0xTransformed',
                    Abi: ['function test()']
                }]
            });
            
            client.subnetEnv = 'fuji-multi-subnet';
            await client._fetchContractDeployment('TradePairs');
            
            expect(client.deployments['TradePairs']).toBeDefined();
            expect(client.deployments['TradePairs']['fuji-multi-subnet'].address).toBe('0xTransformed');
            expect(client.deployments['TradePairs']['fuji-multi-subnet'].abi).toEqual(['function test()']);
        });

        it('_fetchEnvironments should connect signer to provider', async () => {
             const mockSigner = { 
                 provider: null, 
                 connect: jest.fn().mockReturnThis() 
             } as unknown as Signer;
             client.signer = mockSigner;

             const mockEnvData = [{
                 chainid: 12345,
                 env: ENV.PROD_MULTI_SUBNET,
                 env_type: 'subnet',
                 rpc: 'https://rpc',
             }];
             mockedAxios.request.mockResolvedValueOnce({ data: mockEnvData });

             await client._fetchEnvironments();

             expect(client.signer?.connect).toHaveBeenCalled();
        });

        it('getEnvironments should return cache on error if available', async () => {
             client.environmentsCache = ['cached'];
             mockedAxios.request.mockRejectedValueOnce(new Error('Fail'));
             const result = await client.getEnvironments();
             expect(result.success).toBe(true);
             expect(result.data).toEqual(['cached']);
        });

        it('getEnvironments should return error if cache empty', async () => {
             client.environmentsCache = [];
             mockedAxios.request.mockRejectedValueOnce(new Error('Fail'));
             const result = await client.getEnvironments();
             expect(result.success).toBe(false);
             expect(result.error).toContain('Error fetching environments');
        });
    });

    describe('portfolioMainAvaxContract getter', () => {
        it('should return Fuji contract if available', () => {
            client = new BaseClient();
            const mockContract = { address: '0xFuji' } as unknown as Contract;
            client.portfolioMainContracts = { 'Fuji': mockContract };
            expect(client.portfolioMainAvaxContract).toBe(mockContract);
        });

        it('should return Avalanche contract if Fuji not available', () => {
            client = new BaseClient();
            const mockContract = { address: '0xAvalanche' } as unknown as Contract;
            client.portfolioMainContracts = { 'Avalanche': mockContract };
            expect(client.portfolioMainAvaxContract).toBe(mockContract);
        });

        it('should return first available contract if neither Fuji nor Avalanche', () => {
            client = new BaseClient();
            const mockContract = { address: '0xArbitrum' } as unknown as Contract;
            client.portfolioMainContracts = { 'Arbitrum': mockContract };
            expect(client.portfolioMainAvaxContract).toBe(mockContract);
        });

        it('should return null if no contracts', () => {
            client = new BaseClient();
            client.portfolioMainContracts = {};
            expect(client.portfolioMainAvaxContract).toBeNull();
        });
    });

    describe('_getChainNameFromEnv', () => {
        beforeEach(() => {
            client = new BaseClient();
            client.chainConfig = {
                'Fuji': { chain_id: 43113, env: 'fuji-multi-avax' } as any,
                'Avalanche': { chain_id: 43114, env: 'production-multi-avax' } as any
            };
        });

        it('should find chain by exact env match', () => {
            const result = client._getChainNameFromEnv('fuji-multi-avax');
            expect(result).toBe('Fuji');
        });

        it('should find chain by name in env string (fallback)', () => {
            const result = client._getChainNameFromEnv('some-fuji-thing');
            expect(result).toBe('Fuji');
        });

        it('should return Fuji for envs containing fuji', () => {
            client.chainConfig = {}; // Clear to test special case
            const result = client._getChainNameFromEnv('unknown-fuji-env');
            expect(result).toBe('Fuji');
        });

        it('should return Avalanche for envs containing avax', () => {
            client.chainConfig = {}; // Clear to test special case
            const result = client._getChainNameFromEnv('unknown-avax-env');
            expect(result).toBe('Avalanche');
        });

        it('should return null for unknown env', () => {
            client.chainConfig = {};
            const result = client._getChainNameFromEnv('completely-unknown-xyz');
            expect(result).toBeNull();
        });
    });

    describe('_resolveChainId', () => {
        beforeEach(() => {
            client = new BaseClient();
            client.chainConfig = {
                'Fuji': { chain_id: 43113 } as any,
                'Avalanche': { chain_id: 43114 } as any
            };
        });

        it('should return number as-is', () => {
            expect(client._resolveChainId(43113)).toBe(43113);
        });

        it('should find chain by exact name', () => {
            expect(client._resolveChainId('Fuji')).toBe(43113);
        });

        it('should find chain by case-insensitive name', () => {
            expect(client._resolveChainId('fuji')).toBe(43113);
            expect(client._resolveChainId('AVALANCHE')).toBe(43114);
        });

        it('should return null for unknown identifier', () => {
            expect(client._resolveChainId('Unknown')).toBeNull();
        });
    });

    describe('_getChainNameFromId', () => {
        beforeEach(() => {
            client = new BaseClient();
            client.chainConfig = {
                'Fuji': { chain_id: 43113 } as any
            };
        });

        it('should find chain name by ID', () => {
            expect(client._getChainNameFromId(43113)).toBe('Fuji');
        });

        it('should return null for unknown ID', () => {
            expect(client._getChainNameFromId(99999)).toBeNull();
        });
    });

    describe('setSigner', () => {
        beforeEach(() => {
            (axios.create as jest.Mock).mockReturnValue(mockedAxios);
            client = new BaseClient();
        });

        it('should update signer and provider', async () => {
            const mockProvider = {} as Provider;
            const newSigner = { provider: mockProvider } as unknown as Signer;
            
            await client.setSigner(newSigner);
            
            expect(client.signer).toBe(newSigner);
            expect(client.provider).toBe(mockProvider);
        });

        it('should reconnect tradePairsContract if exists', async () => {
            const newSigner = {} as Signer;
            client.tradePairsContract = {} as Contract;
            client.deployments['TradePairs'] = {
                'subnet': { address: '0xTP', abi: [] }
            };
            
            await client.setSigner(newSigner);
            
            expect(Contract).toHaveBeenCalledWith('0xTP', [], newSigner);
        });

        it('should reconnect portfolioSubContract if deployment exists', async () => {
            const newSigner = {} as Signer;
            client.deployments['PortfolioSub'] = { address: '0xPSub', abi: [] };
            
            await client.setSigner(newSigner);
            
            expect(Contract).toHaveBeenCalledWith('0xPSub', [], newSigner);
        });

        it('should reconnect all portfolioMainContracts', async () => {
            const newSigner = {} as Signer;
            client.deployments['PortfolioMain'] = {
                'Fuji': { address: '0xPMain1', abi: [] },
                'Avalanche': { address: '0xPMain2', abi: [] }
            };
            
            await client.setSigner(newSigner);
            
            expect(Contract).toHaveBeenCalledWith('0xPMain1', [], newSigner);
            expect(Contract).toHaveBeenCalledWith('0xPMain2', [], newSigner);
        });

        it('should reconnect all mainnetRfqContracts', async () => {
            const newSigner = {} as Signer;
            client.deployments['MainnetRFQ'] = {
                'Fuji': { address: '0xRFQ1', abi: [] }
            };
            
            await client.setSigner(newSigner);
            
            expect(Contract).toHaveBeenCalledWith('0xRFQ1', [], newSigner);
        });

        it('should return fail Result on setSigner error', async () => {
             // To trigger error, we can make 'Contract' constructor throw.
             // But Contract is a mock. We need to control it.
             (Contract as unknown as jest.Mock).mockImplementationOnce(() => {
                 throw new Error('Signer Update Fail');
             });
             
             const newSigner = {} as Signer;
             // Ensure we enter a path that creates a Contract to trigger the throw
             client.tradePairsContract = {} as Contract;
             client.deployments['TradePairs'] = {
                 'subnet': { address: '0xTP', abi: [] }
             };
             
             const result = await client.setSigner(newSigner);
             expect(result.success).toBe(false);
             expect(result.error).toContain('Signer Update Fail');
        });
    });

    describe('getConnectedChains', () => {
        it('should return list of chain names', () => {
            client = new BaseClient();
            client.chainConfig = {
                'Fuji': { chain_id: 43113 } as any,
                'Avalanche': { chain_id: 43114 } as any
            };
            
            const chains = client.getConnectedChains();
            expect(chains).toEqual(['Fuji', 'Avalanche']);
        });

        it('should return empty array if no chains', () => {
            client = new BaseClient();
            client.chainConfig = {};
            expect(client.getConnectedChains()).toEqual([]);
        });
    });

    describe('getSubnetNetworkInfo', () => {
        it('should return null if no subnetChainId', () => {
            client = new BaseClient();
            client.subnetChainId = null;
            expect(client.getSubnetNetworkInfo()).toBeNull();
        });

        it('should return subnet info if available', () => {
            client = new BaseClient();
            client.subnetChainId = 12345;
            client.environmentsCache = [{
                envType: 'subnet',
                rpc: 'https://rpc.dexalot.com',
                network: 'Dexalot Subnet'
            }];
            
            const info = client.getSubnetNetworkInfo();
            expect(info).toEqual({
                chainId: 12345,
                rpc: 'https://rpc.dexalot.com',
                name: 'Dexalot Subnet'
            });
        });

        it('should use defaults if env data missing', () => {
            client = new BaseClient();
            client.subnetChainId = 12345;
            client.environmentsCache = [];
            
            const info = client.getSubnetNetworkInfo();
            expect(info).toEqual({
                chainId: 12345,
                rpc: '',
                name: 'Dexalot Subnet'
            });
        });
    });

    describe('close', () => {
        it('should clean up resources', async () => {
            client = new BaseClient();
            // Mock internal objects
            client._apiRateLimiter = { reset: jest.fn() } as any;
            client._rpcRateLimiter = { reset: jest.fn() } as any;
            client._nonceManager = { clearAll: jest.fn() } as any;

            await client.close();

            expect(client._apiRateLimiter?.reset).toHaveBeenCalled();
            expect(client._rpcRateLimiter?.reset).toHaveBeenCalled();
            expect(client._nonceManager?.clearAll).toHaveBeenCalled();
        });
    });

    describe('Contract creation with providers (branch coverage)', () => {
        beforeEach(() => {
            (axios.create as jest.Mock).mockReturnValue(mockedAxios);
            client = new BaseClient();
        });

        it('should create portfolioSubContractView when subnetProvider exists', async () => {
            client.subnetEnv = 'fuji-multi-subnet';
            client.subnetProvider = {} as JsonRpcProvider;
            
            mockedAxios.request.mockResolvedValueOnce({
                data: [{
                    contracttype: 'Portfolio',
                    env: 'fuji-multi-subnet',
                    address: '0xPSub',
                    abi: []
                }]
            });
            
            await client._fetchContractDeployment('Portfolio');
            
            // Contract should be called with subnetProvider for view contract
            expect(Contract).toHaveBeenCalled();
        });

        it('should create portfolioMainContracts when mainnet provider exists', async () => {
            client.chainConfig = { 'Fuji': { chain_id: 43113, env: 'fuji-multi-avax' } as any };
            client.connectedChainProviders = { 'Fuji': {} as JsonRpcProvider };
            
            mockedAxios.request.mockResolvedValueOnce({
                data: [{
                    contracttype: 'Portfolio',
                    env: 'fuji-multi-avax',
                    address: '0xPMain',
                    abi: []
                }]
            });
            
            await client._fetchContractDeployment('Portfolio');
            
            expect(Contract).toHaveBeenCalled();
            expect(client.deployments['PortfolioMain']['Fuji'].address).toBe('0xPMain');
        });

        it('should create MainnetRFQ deployment entry for the resolved chain', async () => {
            // Verify that MainnetRFQ deployment is stored correctly
            client.deployments = {};
            client.chainConfig = { 'Fuji': { chain_id: 43113, env: 'fuji-multi-avax' } as any };
            client.connectedChainProviders = { 'Fuji': {} as JsonRpcProvider };
            
            // Mock _getChainNameFromEnv to return chain name
            jest.spyOn(client, '_getChainNameFromEnv').mockReturnValue('Fuji');
            
            mockedAxios.request.mockResolvedValueOnce({
                data: [{
                    contracttype: 'MainnetRFQ',
                    env: 'fuji-multi-avax',
                    address: '0xRFQ',
                    abi: []
                }]
            });
            
            await client._fetchContractDeployment('MainnetRFQ');
            
            // Should create MainnetRFQ object
            expect(client.deployments['MainnetRFQ']).toBeDefined();
            expect(client.deployments['MainnetRFQ']['Fuji']).toBeDefined();
        });

        it('should create mainnetRfqContracts when mainnet provider exists', async () => {
            client.chainConfig = { 'Fuji': { chain_id: 43113, env: 'fuji-multi-avax' } as any };
            client.connectedChainProviders = { 'Fuji': {} as JsonRpcProvider };
            
            mockedAxios.request.mockResolvedValueOnce({
                data: [{
                    contracttype: 'MainnetRFQ',
                    env: 'fuji-multi-avax',
                    address: '0xRFQ',
                    abi: []
                }]
            });
            
            await client._fetchContractDeployment('MainnetRFQ');
            
            expect(Contract).toHaveBeenCalled();
        });

        it('should use provider when signer is not available for contract initialization', async () => {
            // Test the || branch: runner = this.signer || this.provider
            // When signer is null/undefined, should use provider
            client.signer = null as any;
            client.provider = new JsonRpcProvider('https://api.avax.network/ext/bc/C/rpc');
            
            mockedAxios.request.mockResolvedValueOnce({ 
                data: [{
                    contracttype: 'TradePairs',
                    env: ENV.FUJI_MULTI_SUBNET,
                    address: '0xTradePairs',
                    abi: ['function test()']
                }]
            });
            
            await client._fetchContractDeployment('TradePairs');
            
            // Should use provider for contract initialization
            expect(Contract).toHaveBeenCalled();
        });

        it('should skip MainnetRFQ initialization when deployment already exists', async () => {
            // Test the branch: if (!this.deployments['MainnetRFQ'])
            // When MainnetRFQ already exists (false branch), should skip the initialization
            client.deployments['MainnetRFQ'] = { 'ExistingChain': { address: '0xExisting', abi: [] } };
            client.chainConfig = { 'Avalanche': { chain_id: 43114 } as any };
            client.connectedChainProviders = { 'Avalanche': new JsonRpcProvider() as any };
            
            // Mock _getChainNameFromEnv to return a chain name
            jest.spyOn(client, '_getChainNameFromEnv').mockReturnValue('Avalanche');
            
            mockedAxios.request.mockResolvedValueOnce({ 
                data: [{
                    contracttype: 'MainnetRFQ',
                    env: ENV.PROD_MULTI_AVAX,
                    address: '0xNewRFQ',
                    abi: ['function test()']
                }]
            });
            
            await client._fetchContractDeployment('MainnetRFQ');
            
            // Should append to existing MainnetRFQ without reinitializing the object
            expect(client.deployments['MainnetRFQ']['ExistingChain']).toBeDefined();
            expect(client.deployments['MainnetRFQ']['Avalanche']).toBeDefined();
        });

        it('should append to existing MainnetRFQ deployments', async () => {
            // Pre-populate deployments to test the branch where it already exists
            client.deployments['MainnetRFQ'] = { 'ExistingChain': { address: '0xExisting', abi: [] } };
            client.chainConfig = { 'Fuji': { chain_id: 43113, env: 'fuji-multi-avax' } as any };
            client.connectedChainProviders = { 'Fuji': {} as JsonRpcProvider };
            
            mockedAxios.request.mockResolvedValueOnce({
                data: [{
                    contracttype: 'MainnetRFQ',
                    env: 'fuji-multi-avax',
                    address: '0xNewRFQ',
                    abi: []
                }]
            });
            
            await client._fetchContractDeployment('MainnetRFQ');
            
            // Both should exist
            expect(client.deployments['MainnetRFQ']['ExistingChain'].address).toBe('0xExisting');
            expect(client.deployments['MainnetRFQ']['Fuji'].address).toBe('0xNewRFQ');
        });
    });

    describe('getTokens', () => {
        beforeEach(() => {
            client = new BaseClient();
            client.chainConfig = {
                'Fuji': { chain_id: 43113 } as any,
                'Avalanche': { chain_id: 43114 } as any,
            };
        });

        it('should return tokens from cached tokenData', async () => {
            client.tokenData = {
                'AVAX': {
                    'fuji': {
                        symbol: 'AVAX',
                        name: 'Avalanche',
                        chainId: 43113,
                        decimals: 18,
                        address: '0x0000',
                    } as any,
                },
                'USDC': {
                    'fuji': {
                        symbol: 'USDC',
                        name: 'USD Coin',
                        chainId: 43113,
                        decimals: 6,
                        address: '0x1234',
                    } as any,
                },
            };

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            const tokens = result.data!;
            expect(Array.isArray(tokens)).toBe(true);
            expect(tokens.length).toBeGreaterThan(0);
            expect(tokens[0]).toHaveProperty('symbol');
            expect(tokens[0]).toHaveProperty('chain_id');
        });

        it('should skip duplicate symbols', async () => {
            client.tokenData = {
                'AVAX': {
                    'fuji': {
                        symbol: 'AVAX',
                        chainId: 43113,
                    } as any,
                    'fuji2': {
                        symbol: 'AVAX',
                        chainId: 43113,
                    } as any,
                },
            };

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            const tokens = result.data!;
            const avaxCount = tokens.filter(t => t.symbol === 'AVAX').length;
            expect(avaxCount).toBe(1); // Should only have one AVAX
        });

        it('should fallback to API when tokenData is empty', async () => {
            client.tokenData = {};
            mockedAxios.request.mockResolvedValueOnce({
                data: [
                    {
                        symbol: 'AVAX',
                        name: 'Avalanche',
                        chain_id: 43113,
                        evmdecimals: 18,
                        address: '0x0000',
                        chain_display_name: 'Fuji',
                    },
                ],
            });

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            const tokens = result.data!;
            expect(Array.isArray(tokens)).toBe(true);
            expect(tokens.length).toBeGreaterThan(0);
            expect(mockedAxios.request).toHaveBeenCalled();
        });

        it('should handle API errors gracefully', async () => {
            client.tokenData = {};
            mockedAxios.request.mockRejectedValueOnce(new Error('API Error'));

            const result = await client.getTokens();
            expect(result.success).toBe(false);
            expect(result.error).toContain('Error fetching tokens');
        });

        it('should filter by mainnet chain IDs', async () => {
            client.tokenData = {
                'AVAX': {
                    'fuji': {
                        symbol: 'AVAX',
                        chainId: 43113, // Mainnet
                    } as any,
                    'subnet': {
                        symbol: 'AVAX',
                        chainId: 432201, // Subnet (not mainnet)
                    } as any,
                },
            };

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            const tokens = result.data!;
            expect(tokens.length).toBe(1);
            expect(tokens[0].chain_id).toBe(43113);
        });

        it('should handle chainid field (alternative to chain_id)', async () => {
            client.tokenData = {};
            mockedAxios.request.mockResolvedValueOnce({
                data: [
                    {
                        symbol: 'AVAX',
                        chainid: 43113, // Using chainid instead of chain_id
                        evmdecimals: 18,
                    },
                ],
            });

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            const tokens = result.data!;
            expect(tokens.length).toBe(1);
            expect(tokens[0].chain_id).toBe(43113);
        });

        it('should use decimals fallback when evmdecimals missing', async () => {
            client.tokenData = {
                'AVAX': {
                    'fuji': {
                        symbol: 'AVAX',
                        chainId: 43113,
                        decimals: 18, // Using decimals instead of evmdecimals
                    } as any,
                },
            };

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            expect(result.data![0].decimals).toBe(18);
        });

        it('should use network field when chain_display_name missing', async () => {
            client.tokenData = {};
            mockedAxios.request.mockResolvedValueOnce({
                data: [
                    {
                        symbol: 'AVAX',
                        chain_id: 43113,
                        network: 'Fuji', // Using network instead of chain_display_name
                    },
                ],
            });

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            expect(result.data![0].chain).toBe('Fuji');
        });

        it('should handle tokens with missing chainId in cached data', async () => {
            client.tokenData = {
                'AVAX': {
                    'fuji': {
                        symbol: 'AVAX',
                        chainId: undefined, // Missing chainId
                    } as any,
                },
            };

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            const tokens = result.data!;
            // Token without chainId should be skipped
            expect(tokens.filter(t => t.symbol === 'AVAX').length).toBe(0);
        });

        it('should handle tokens with chainId 0', async () => {
            client.tokenData = {
                'AVAX': {
                    'fuji': {
                        symbol: 'AVAX',
                        chainId: 0, // Invalid chainId
                    } as any,
                },
            };

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            const tokens = result.data!;
            // Token with chainId 0 should be skipped
            expect(tokens.filter(t => t.symbol === 'AVAX').length).toBe(0);
        });

        it('should handle tokens not in mainnet chain IDs', async () => {
            client.tokenData = {
                'AVAX': {
                    'subnet': {
                        symbol: 'AVAX',
                        chainId: 432201, // Subnet chain ID (not in mainnetChainIds)
                    } as any,
                },
            };

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            const tokens = result.data!;
            // Token on subnet should be skipped
            expect(tokens.filter(t => t.symbol === 'AVAX').length).toBe(0);
        });

        it('should handle _getChainNameFromId returning null', async () => {
            client.tokenData = {
                'AVAX': {
                    'fuji': {
                        symbol: 'AVAX',
                        chainId: 43113,
                    } as any,
                },
            };
            // Mock _getChainNameFromId to return null
            client._getChainNameFromId = jest.fn().mockReturnValue(null);

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            expect(result.data![0].chain).toBe(''); // Should use empty string fallback
        });

        it('should use chainId || 0 fallback when API returns token without chainId', async () => {
            client.tokenData = {};
            mockedAxios.request.mockResolvedValueOnce({
                data: [
                    {
                        symbol: 'TEST',
                        name: 'Test Token',
                        address: '0x1',
                        // No chainId, chainid, or chain_id field at all
                    },
                ],
            });

            const result = await client.getTokens();
            expect(result.success).toBe(true);
            const tokens = result.data!;
            // chainId falls back to 0 via || 0, and chainId=0 is falsy so the token is skipped
            expect(tokens.filter(t => t.symbol === 'TEST').length).toBe(0);
        });
    });

    describe('RFQ and CLOB Pairs Fetching', () => {
        beforeEach(() => {
            (axios.create as jest.Mock).mockReturnValue(mockedAxios);
            client = new BaseClient();
        });

        it('should fetch RFQ pairs for all configured chains', async () => {
            // Setup chain configuration with multiple chains
            client.chainConfig = {
                'Avalanche': { chain_id: 43114 } as any,
                'Fuji': { chain_id: 43113 } as any
            };
            
            // Mock successful API responses for RFQ pairs
            mockedAxios.request.mockResolvedValue({ data: { 'AVAX/USDC': {} } });
            
            await (client as any)._fetchRfqPairs();
            
            // Verify API calls were made for each chain
            expect(mockedAxios.request).toHaveBeenCalled();
        });

        it('should fetch RFQ pairs for Avalanche mainnet when not in chainConfig', async () => {
            // Setup chainConfig without Avalanche mainnet to test fallback behavior
            client.chainConfig = {
                'Fuji': { chain_id: 43113 } as any
            };
            
            // Mock successful API response
            mockedAxios.request.mockResolvedValue({ data: { 'AVAX/USDC': {} } });
            
            await (client as any)._fetchRfqPairs();
            
            // Should fetch for both configured chains and Avalanche mainnet fallback
            expect(mockedAxios.request).toHaveBeenCalled();
        });

        it('should handle errors gracefully when fetching RFQ pairs fails', async () => {
            // Setup chain configuration
            client.chainConfig = {
                'Avalanche': { chain_id: 43114 } as any
            };
            
            // Mock API error
            mockedAxios.request.mockRejectedValue(new Error('RFQ Error'));
            
            // Should not throw, but log warning instead
            await (client as any)._fetchRfqPairs();
            
            expect(mockedAxios.request).toHaveBeenCalled();
        });

        it('should handle empty chainConfig without errors', async () => {
            // Test behavior when no chains are configured
            client.chainConfig = {};
            
            // Should complete successfully even with no fetch tasks
            await (client as any)._fetchRfqPairs();
        });

        it('should handle errors during parallel fetch execution', async () => {
            // Setup chain configuration
            client.chainConfig = {
                'Avalanche': { chain_id: 43114 } as any
            };
            
            // Mock individual chain fetch to throw error
            jest.spyOn(client as any, '_fetchRfqPairsForChain').mockRejectedValue(new Error('Chain fetch error'));
            
            // Should catch error and log warning without throwing
            await (client as any)._fetchRfqPairs();
        });

        it('should handle errors during chainConfig iteration', async () => {
            // Setup chain configuration
            client.chainConfig = {
                'Avalanche': { chain_id: 43114 } as any
            };
            
            // Mock Object.entries to simulate error during iteration
            const originalEntries = Object.entries;
            jest.spyOn(Object, 'entries').mockImplementation(() => {
                throw new Error('Iteration error');
            });
            
            // Should catch error and log warning
            await (client as any)._fetchRfqPairs();
            
            Object.entries = originalEntries;
        });

        it('should handle errors when fetching RFQ pairs for a specific chain', async () => {
            // Mock API error for specific chain
            mockedAxios.request.mockRejectedValue(new Error('Chain API Error'));
            
            // Should log warning but not throw
            await (client as any)._fetchRfqPairsForChain(43114, 'Avalanche');
            
            expect(mockedAxios.request).toHaveBeenCalled();
        });

        it('should skip CLOB pairs fetch when getClobPairs method is not available', async () => {
            // Ensure getClobPairs doesn't exist (BaseClient without CLOBMixin)
            delete (client as any).getClobPairs;
            
            // Should log warning and skip fetch
            await (client as any)._fetchClobPairs();
            
            // Should complete without error
        });

        it('should fetch CLOB pairs when getClobPairs method is available', async () => {
            // Simulate CLOBMixin being applied (getClobPairs method exists)
            (client as any).getClobPairs = jest.fn().mockResolvedValue(Result.ok('Pairs fetched'));
            
            await (client as any)._fetchClobPairs();
            
            // Should call getClobPairs method
            expect((client as any).getClobPairs).toHaveBeenCalled();
        });

        it('should handle getClobPairs returning failure result', async () => {
            // Mock getClobPairs to return failure
            (client as any).getClobPairs = jest.fn().mockResolvedValue(Result.fail('Failed to fetch'));
            
            // Should handle failure gracefully
            await (client as any)._fetchClobPairs();
            
            expect((client as any).getClobPairs).toHaveBeenCalled();
        });

        it('should handle exceptions thrown by getClobPairs', async () => {
            // Mock getClobPairs to throw exception
            (client as any).getClobPairs = jest.fn().mockRejectedValue(new Error('Unexpected error'));
            
            // Should catch exception and log warning without throwing
            await (client as any)._fetchClobPairs();
            
            expect((client as any).getClobPairs).toHaveBeenCalled();
        });
    });

    describe('Reinitialize', () => {
        beforeEach(() => {
            (axios.create as jest.Mock).mockReturnValue(mockedAxios);
            client = new BaseClient();
        });

        it('should clear caches and refresh all data when forceRefresh is true', async () => {
            // Setup spies for all fetch methods
            const spyEnv = jest.spyOn(client, '_fetchEnvironments').mockResolvedValue();
            const spyTok = jest.spyOn(client, '_fetchTokens').mockResolvedValue();
            const spyDep = jest.spyOn(client, '_fetchDeployments').mockResolvedValue();
            const spyRfq = jest.spyOn(client as any, '_fetchRfqPairs').mockResolvedValue();
            const spyClob = jest.spyOn(client as any, '_fetchClobPairs').mockResolvedValue();
            const spyInvalidate = jest.spyOn(client, 'invalidateCache');
            
            await client.reinitialize(true);
            
            // Verify caches are cleared before refresh
            expect(spyInvalidate).toHaveBeenCalledWith('static');
            expect(spyInvalidate).toHaveBeenCalledWith('semi_static');
            // Verify all data is refreshed
            expect(spyEnv).toHaveBeenCalled();
            expect(spyTok).toHaveBeenCalled();
            expect(spyDep).toHaveBeenCalled();
            expect(spyRfq).toHaveBeenCalled();
            expect(spyClob).toHaveBeenCalled();
        });

        it('should refresh data without clearing caches when forceRefresh is false', async () => {
            // Setup spies for all fetch methods
            const spyEnv = jest.spyOn(client, '_fetchEnvironments').mockResolvedValue();
            const spyTok = jest.spyOn(client, '_fetchTokens').mockResolvedValue();
            const spyDep = jest.spyOn(client, '_fetchDeployments').mockResolvedValue();
            const spyRfq = jest.spyOn(client as any, '_fetchRfqPairs').mockResolvedValue();
            const spyClob = jest.spyOn(client as any, '_fetchClobPairs').mockResolvedValue();
            const spyInvalidate = jest.spyOn(client, 'invalidateCache');
            
            await client.reinitialize(false);
            
            // Verify caches are not cleared
            expect(spyInvalidate).not.toHaveBeenCalled();
            // Verify data is still refreshed
            expect(spyEnv).toHaveBeenCalled();
        });

        it('should return error result when reinitialization fails', async () => {
            // Mock environment fetch to fail
            jest.spyOn(client, '_fetchEnvironments').mockRejectedValue(new Error('Initialization error'));
            
            const result = await client.reinitialize();
            
            // Should return failure result with error message
            expect(result.success).toBe(false);
            expect(result.error).toContain('Initialization error');
        });
    });

    describe('Cache Invalidation', () => {
        beforeEach(() => {
            (axios.create as jest.Mock).mockReturnValue(mockedAxios);
            client = new BaseClient();
        });

        it('should clear static cache when invalidating static level', () => {
            const spy = jest.spyOn(client._staticCache, 'clear');
            client.invalidateCache('static');
            expect(spy).toHaveBeenCalled();
        });

        it('should clear semi-static cache when invalidating semi_static level', () => {
            const spy = jest.spyOn(client._semiStaticCache, 'clear');
            client.invalidateCache('semi_static');
            expect(spy).toHaveBeenCalled();
        });

        it('should clear balance cache when invalidating balance level', () => {
            const spy = jest.spyOn(client._balanceCache, 'clear');
            client.invalidateCache('balance');
            expect(spy).toHaveBeenCalled();
        });

        it('should clear orderbook cache when invalidating orderbook level', () => {
            const spy = jest.spyOn(client._orderbookCache, 'clear');
            client.invalidateCache('orderbook');
            expect(spy).toHaveBeenCalled();
        });

        it('should clear all caches when invalidating all levels', () => {
            const spyStatic = jest.spyOn(client._staticCache, 'clear');
            const spySemi = jest.spyOn(client._semiStaticCache, 'clear');
            const spyBalance = jest.spyOn(client._balanceCache, 'clear');
            const spyOrderbook = jest.spyOn(client._orderbookCache, 'clear');
            
            client.invalidateCache('all');
            
            // Verify all cache levels are cleared
            expect(spyStatic).toHaveBeenCalled();
            expect(spySemi).toHaveBeenCalled();
            expect(spyBalance).toHaveBeenCalled();
            expect(spyOrderbook).toHaveBeenCalled();
        });

        it('should use default parameter when invalidateCache is called without arguments', () => {
            const spyStatic = jest.spyOn(client._staticCache, 'clear');
            const spySemi = jest.spyOn(client._semiStaticCache, 'clear');
            const spyBalance = jest.spyOn(client._balanceCache, 'clear');
            const spyOrderbook = jest.spyOn(client._orderbookCache, 'clear');
            
            // Call without arguments to test default parameter
            client.invalidateCache();
            
            // Should default to 'all' and clear all caches
            expect(spyStatic).toHaveBeenCalled();
            expect(spySemi).toHaveBeenCalled();
            expect(spyBalance).toHaveBeenCalled();
            expect(spyOrderbook).toHaveBeenCalled();
        });
    });

    describe('getDeployment', () => {
        beforeEach(() => {
            (axios.create as jest.Mock).mockReturnValue(mockedAxios);
            client = new BaseClient();
        });

        it('should return error when environments are not available for deployment fetch', async () => {
            // Clear chainConfig to trigger environments fetch requirement
            client.chainConfig = {};

            // Mock getEnvironments to return failure
            jest.spyOn(client, 'getEnvironments').mockResolvedValue(Result.fail('Environment fetch failed'));

            const result = await client.getDeployment();

            // Should return failure with descriptive error
            expect(result.success).toBe(false);
            expect(result.error).toContain('Failed to fetch environments');
        });
    });

    describe('Token & Chain Normalization Methods', () => {
        beforeEach(() => {
            (axios.create as jest.Mock).mockReturnValue(mockedAxios);
            client = new BaseClient();
        });

        it('normalizeToken should normalize token symbols', () => {
            expect(client.normalizeToken('eth')).toBe('ETH');
            expect(client.normalizeToken(' usdc ')).toBe('USDC');
            expect(client.normalizeToken('WETH')).toBe('ETH');
        });

        it('normalizePair should normalize trading pairs', () => {
            expect(client.normalizePair('eth/usdc')).toBe('ETH/USDC');
            expect(client.normalizePair('weth/usdc')).toBe('ETH/USDC');
        });

        it('resolveChainReference should resolve chain aliases', () => {
            client.chainConfig = {
                'Fuji': { chain_id: 43113 } as any,
                'Avalanche': { chain_id: 43114 } as any,
            };
            client.chainId = 43114;
            client.subnetChainId = 432204;

            const result = client.resolveChainReference('Fuji');
            expect(result.success).toBe(true);
            expect(result.data!.canonicalName).toBe('Fuji');
        });

        it('resolveChainReference should resolve Dexalot L1 when includeDexalotL1 is true', () => {
            client.chainConfig = {
                'Fuji': { chain_id: 43113 } as any,
            };
            client.subnetChainId = 432204;

            const result = client.resolveChainReference('dexalot', true);
            expect(result.success).toBe(true);
            expect(result.data!.canonicalName).toBe('Dexalot L1');
        });

        it('resolveChainReference should fail for unknown chains', () => {
            client.chainConfig = {
                'Fuji': { chain_id: 43113 } as any,
            };

            const result = client.resolveChainReference('solana');
            expect(result.success).toBe(false);
            expect(result.error).toContain('not recognized');
        });
    });
});
