import axios, { AxiosInstance } from 'axios';
import { Contract, Signer, Provider, JsonRpcProvider, Wallet } from 'ethers';
import { API_URL, ENDPOINTS, KNOWN_CHAIN_IDS, ENV } from '../constants.js';
import { Pair, TokenInfo, DeploymentInfo, ChainConfig } from '../types/index.js';
import { parseRevertReason } from '../errors.js';
import { DexalotConfig, createConfig, loadConfigFromEnv } from './config.js';
import { Result } from '../utils/result.js';
import { AsyncRateLimiter } from '../utils/rateLimit.js';
import { AsyncNonceManager } from '../utils/nonceManager.js';
import { ProviderManager } from '../utils/providerManager.js';
import { sanitizeErrorMessage } from '../utils/errorSanitizer.js';
import { asyncRetry, RetryOptions } from '../utils/retry.js';
import { MemoryCache, withCache, withInstanceCache } from '../utils/cache.js';
import { getLogger, Logger, configureLogging, LogLevel, trackOperation } from '../utils/observability.js';
import { normalizeTokenSymbol, normalizeTradingPair } from '../utils/tokenNormalization.js';
import { ChainResolver, ResolvedChain } from '../utils/chainResolver.js';

export class BaseClient {
    public signer: Signer | null = null;
    public provider: Provider | null = null;
    public subnetProvider: Provider | null = null;
    public apiBaseUrl: string;
    public axios: AxiosInstance;
    
    // Configuration
    public config: DexalotConfig;
    
    // Utilities (public for mixin access)
    public _apiRateLimiter: AsyncRateLimiter | null = null;
    public _rpcRateLimiter: AsyncRateLimiter | null = null;
    public _nonceManager: AsyncNonceManager | null = null;
    public _providerManager: ProviderManager | null = null;
    public _logger: Logger;
    public _cacheEnabled: boolean;
    
    // Caches
    public _staticCache: MemoryCache;
    public _semiStaticCache: MemoryCache;
    public _balanceCache: MemoryCache;
    public _orderbookCache: MemoryCache;
    
    // State
    public pairs: Record<string, Pair> = {};
    public tokenData: Record<string, Record<string, TokenInfo>> = {};
    public deployments: Record<string, any> = {};
    public chainConfig: Record<string, ChainConfig> = {};
    public environmentsCache: any[] = [];
    
    // Contracts - L1/Subnet
    public tradePairsContract: Contract | null = null;
    public portfolioSubContract: Contract | null = null;
    public portfolioSubContractView: Contract | null = null;
    
    // Contracts - Per-Chain Mainnet (dynamically discovered)
    public portfolioMainContracts: Record<string, Contract> = {};
    public mainnetRfqContracts: Record<string, Contract> = {};
    
    // Legacy single contract accessor (for backward compatibility)
    public get portfolioMainAvaxContract(): Contract | null {
        return this.portfolioMainContracts['Fuji'] || 
               this.portfolioMainContracts['Avalanche'] || 
               Object.values(this.portfolioMainContracts)[0] || null;
    }
    
    // Providers - Per-Chain
    public connectedChainProviders: Record<string, JsonRpcProvider> = {};

    // Environment - discovered dynamically
    public env: string = '';
    public subnetEnv: string = '';
    public chainId: number = 0;
    public subnetChainId: number | null = null;
    public parentEnv: string = '';

    /**
     * Create a new BaseClient.
     * @param configOrSigner - DexalotConfig, Signer, or API URL string
     * @param baseUrl - Optional API base URL (only used if first arg is Signer)
     */
    constructor(configOrSigner?: DexalotConfig | Signer | string, baseUrl?: string) {
        // Determine configuration
        if (configOrSigner && typeof configOrSigner === 'object' && 'parentEnv' in configOrSigner) {
            // DexalotConfig provided
            this.config = configOrSigner;
            this.parentEnv = this.config.parentEnv;
            this.apiBaseUrl = this.config.apiBaseUrl || API_URL.TESTNET;
            
            // Set up signer if private key provided
            if (this.config.privateKey) {
                this.signer = new Wallet(this.config.privateKey);
            }
        } else if (typeof configOrSigner === 'string') {
            // API URL string provided (legacy)
            this.config = createConfig();
            this.parentEnv = this.config.parentEnv;
            this.apiBaseUrl = configOrSigner;
        } else if (configOrSigner) {
            // Signer provided (legacy)
            this.config = createConfig();
            this.signer = configOrSigner;
            this.parentEnv = this.config.parentEnv;
            const network = this.parentEnv.toLowerCase().includes('production') ? 'MAINNET' : 'TESTNET';
            this.apiBaseUrl = baseUrl || API_URL[network];
            if (this.signer.provider) {
                this.provider = this.signer.provider;
            }
        } else {
            // No arguments - load from environment
            this.config = loadConfigFromEnv();
            this.parentEnv = this.config.parentEnv;
            this.apiBaseUrl = this.config.apiBaseUrl || API_URL.TESTNET;
            
            if (this.config.privateKey) {
                this.signer = new Wallet(this.config.privateKey);
            }
        }

        // Initialize logger
        configureLogging(this.config.logLevel as LogLevel, this.config.logFormat as 'console' | 'json');
        this._logger = getLogger('dexalot_sdk.base');

        // Initialize caches
        this._cacheEnabled = this.config.cacheEnabled;
        this._staticCache = new MemoryCache(this.config.cacheTtlStatic * 1000);
        this._semiStaticCache = new MemoryCache(this.config.cacheTtlSemiStatic * 1000);
        this._balanceCache = new MemoryCache(this.config.cacheTtlBalance * 1000);
        this._orderbookCache = new MemoryCache(this.config.cacheTtlOrderbook * 1000);

        // Initialize rate limiters
        if (this.config.rateLimitEnabled) {
            this._apiRateLimiter = new AsyncRateLimiter(this.config.rateLimitRequestsPerSecond);
            this._rpcRateLimiter = new AsyncRateLimiter(this.config.rateLimitRpcPerSecond);
        }

        // Initialize nonce manager
        if (this.config.nonceManagerEnabled) {
            this._nonceManager = new AsyncNonceManager();
        }

        // Initialize provider manager
        if (this.config.providerFailoverEnabled) {
            this._providerManager = new ProviderManager({
                failoverCooldown: this.config.providerFailoverCooldown,
                maxFailures: this.config.providerFailoverMaxFailures,
            });
        }

        // Initialize axios
        this.axios = axios.create({
            baseURL: this.apiBaseUrl,
            timeout: this.config.timeoutRead,
        });
    }

    /**
     * Sanitize error message to prevent information leaks.
     */
    public _sanitizeError(error: Error | unknown, context: string): string {
        const err = error instanceof Error ? error : new Error(String(error));
        return sanitizeErrorMessage(err, context);
    }

    /**
     * Make an API call with rate limiting and retry.
     */
    public async _apiCall<T>(
        method: 'get' | 'post' | 'put' | 'delete',
        url: string,
        options?: { params?: any; data?: any; headers?: any }
    ): Promise<T> {
        // Rate limiting
        if (this._apiRateLimiter) {
            await this._apiRateLimiter.acquire();
        }

        // Build the request function
        const makeRequest = async (): Promise<T> => {
            const response = await this.axios.request({
                method,
                url,
                ...options,
            });
            return response.data;
        };

        // Apply retry if enabled
        if (this.config.retryEnabled) {
            const retryOpts: RetryOptions = {
                maxAttempts: this.config.retryMaxAttempts,
                initialDelay: this.config.retryInitialDelay,
                maxDelay: this.config.retryMaxDelay,
                exponentialBase: this.config.retryExponentialBase,
                retryOnStatus: this.config.retryOnStatus,
            };
            return asyncRetry(makeRequest, retryOpts)();
        }

        return makeRequest();
    }

    public getRevertReason(error: any): string {
        return parseRevertReason(error);
    }

    /**
     * Initialize the client: fetch configuration and contract addresses.
     */
    public async initialize(): Promise<Result<string>> {
        return trackOperation(
            this._logger,
            'initialize',
            async () => {
                // Fetch environments first (sets providers needed for deployments)
                await this._fetchEnvironments();
                
                // Then fetch other data in parallel
                await Promise.all([
                    this._fetchTokens(),
                    this._fetchRfqPairs(),
                    this._fetchDeployments(),
                    this._fetchClobPairs(),
                ]);
                
                return Result.ok('Client initialized with all configurations.');
            },
            { parentEnv: this.parentEnv }
        ).catch((error) => {
            const msg = this._sanitizeError(error, 'initializing client');
            return Result.fail(msg);
        });
    }

    /**
     * Transform API token response to match standardized field names.
     * Maps lowercase/snake_case API fields to camelCase SDK fields.
     * Preserves existing camelCase fields if present, otherwise transforms from alternative formats.
     */
    private _transformTokenFromAPI(token: any): any {
        const transformed: any = { ...token };
        
        // Transform evmDecimals: prefer existing camelCase, fallback to lowercase/snake_case
        if (!transformed.evmDecimals) {
            transformed.evmDecimals = token.evmdecimals || token.evm_decimals || token.decimals;
        }
        
        // Transform chainId: prefer existing camelCase, fallback to lowercase/snake_case
        if (!transformed.chainId) {
            transformed.chainId = token.chainid || token.chain_id;
        }
        
        // Transform network: prefer existing, fallback to chain_display_name
        if (!transformed.network) {
            transformed.network = token.chain_display_name;
        }
        
        return transformed;
    }

    /**
     * Transform API environment response to match standardized field names.
     * Maps lowercase/snake_case API fields to camelCase SDK fields.
     * Preserves existing camelCase fields if present, otherwise transforms from alternative formats.
     */
    private _transformEnvironmentFromAPI(env: any): any {
        const transformed: any = { ...env };
        
        // Transform chainId: prefer existing camelCase, fallback to lowercase/snake_case
        if (!transformed.chainId) {
            transformed.chainId = env.chainid || env.chain_id;
        }
        
        // Transform envType: prefer existing camelCase, fallback to snake_case/lowercase
        if (!transformed.envType) {
            transformed.envType = env.env_type || env.type;
        }
        
        // Transform rpc: prefer existing, fallback to chain_instance
        if (!transformed.rpc) {
            transformed.rpc = env.chain_instance;
        }
        
        // Transform network: prefer existing, fallback to chain_display_name
        if (!transformed.network) {
            transformed.network = env.chain_display_name;
        }
        
        return transformed;
    }

    /**
     * Transform API deployment response to match standardized field names.
     * Maps lowercase/camelCase API fields to lowercase SDK fields.
     * Preserves existing lowercase fields if present, otherwise transforms from alternative formats.
     */
    private _transformDeploymentFromAPI(item: any): any {
        const transformed: any = { ...item };
        
        // Transform env: prefer existing lowercase, fallback to variations
        if (!transformed.env) {
            transformed.env = item.Env || item.environment;
        }
        
        // Transform address: prefer existing lowercase, fallback to variations
        if (!transformed.address) {
            transformed.address = item.Address || item.contractAddress;
        }
        
        // Transform abi: prefer existing lowercase, fallback to variations
        // Note: ABI can be an array or nested object, so we preserve the structure
        if (!transformed.abi) {
            transformed.abi = item.Abi || item.ABI;
        }
        
        return transformed;
    }

    public async _fetchEnvironments(): Promise<void> {
        try {
            const environments = await this._apiCall<any[]>('get', ENDPOINTS.TRADING_ENVIRONMENTS);
            
            // Transform environments and store in cache
            this.environmentsCache = environments.map(env => this._transformEnvironmentFromAPI(env));

            // Use fallback logic for internal processing (backward compatibility)
            for (const env of environments) {
                const chainId = env.chainid || env.chain_id;
                const envType = env.env_type || env.type;
                const envString = env.env;
                const rpc = env.rpc || env.chain_instance;
                const name = env.network || env.chain_display_name;

                // Process subnet environments
                if (envType === 'subnet') {
                    this.subnetChainId = chainId;
                    this.subnetEnv = envString;
                    
                    if (rpc) {
                        this.subnetProvider = new JsonRpcProvider(rpc);
                        if (!this.provider) {
                            this.provider = this.subnetProvider;
                        }
                    }
                    
                    // Ensure Signer is connected to subnet Provider
                    if (this.signer && !this.signer.provider && this.provider) {
                        try {
                            this.signer = this.signer.connect(this.provider);
                        } catch (e) {
                            // Ignore if signer cannot be re-connected
                        }
                    }
                }
                
                // Process mainnet environments
                if (envType === 'mainnet' && name) {
                    const nativeSymbol = env.native_token_symbol || 'ETH';
                    
                    this.chainConfig[name] = {
                        chain_id: chainId,
                        rpc: rpc,
                        explorer: env.explorer,
                        native_symbol: nativeSymbol,
                        env: envString
                    };

                    // Initialize mainnet provider
                    if (rpc) {
                        try {
                            const provider = new JsonRpcProvider(rpc);
                            this.connectedChainProviders[name] = provider;
                            
                            // Register with provider manager for failover
                            if (this._providerManager) {
                                this._providerManager.addProviders(name, [rpc]);
                            }
                        } catch (e) {
                            this._logger.warn(`Failed to init provider for ${name}`, { error: String(e) });
                        }
                    }

                    // Set primary chainId/env
                    if (!this.chainId || chainId === KNOWN_CHAIN_IDS.AVAX_MAINNET || chainId === KNOWN_CHAIN_IDS.AVAX_FUJI) {
                        this.chainId = chainId;
                        this.env = envString;
                    }
                }
            }
        } catch (e) {
            this._logger.error('Error fetching environments', { error: this._sanitizeError(e, 'fetching environments') });
        }
    }

    public async _fetchTokens(): Promise<void> {
        try {
            const tokens = await this._apiCall<any[]>('get', ENDPOINTS.TRADING_TOKENS);
            for (const t of tokens) {
                if (!this.tokenData[t.symbol]) {
                    this.tokenData[t.symbol] = {};
                }
                const decimals = t.evmdecimals !== undefined ? t.evmdecimals : 18;
                
                this.tokenData[t.symbol][t.env] = {
                    address: t.address,
                    symbol: t.symbol,
                    name: t.name,
                    decimals: decimals,
                    chainId: t.chainid || t.chain_id || 0,
                    env: t.env
                };
            }
        } catch (e) {
            this._logger.error('Error fetching tokens', { error: this._sanitizeError(e, 'fetching tokens') });
        }
    }

    /**
     * Fetch RFQ pairs for all configured chains.
     * Stores results in this.rfqPairs[chainId] (from SwapMixin).
     */
    private async _fetchRfqPairs(): Promise<void> {
        try {
            // Initialize rfqPairs if not already present (may be in SwapMixin)
            if (!(this as any).rfqPairs) {
                (this as any).rfqPairs = {};
            }
            
            const fetchTasks: Promise<void>[] = [];
            
            // Fetch RFQ pairs for each chain in parallel
            for (const [chainName, config] of Object.entries(this.chainConfig)) {
                const chainId = config.chain_id;
                if (chainId) {
                    fetchTasks.push(
                        this._fetchRfqPairsForChain(chainId, chainName)
                    );
                }
            }
            
            // Also fetch for Avalanche mainnet if not already in chainConfig
            const avaxMainnetId = KNOWN_CHAIN_IDS.AVAX_MAINNET;
            const hasAvaxMainnet = Object.values(this.chainConfig).some(
                config => config.chain_id === avaxMainnetId
            );
            if (!hasAvaxMainnet) {
                fetchTasks.push(
                    this._fetchRfqPairsForChain(avaxMainnetId, 'Avalanche')
                );
            }
            
            if (fetchTasks.length > 0) {
                await Promise.all(fetchTasks);
            }
        } catch (e) {
            this._logger.warn('Error fetching RFQ pairs', { 
                error: this._sanitizeError(e, 'fetching RFQ pairs') 
            });
        }
    }

    /**
     * Fetch RFQ pairs for a specific chain.
     */
    private async _fetchRfqPairsForChain(chainId: number, chainName: string): Promise<void> {
        try {
            const data = await this._apiCall<any>('get', ENDPOINTS.RFQ_PAIRS, {
                params: { chainid: chainId }
            });
            (this as any).rfqPairs[chainId] = data;
        } catch (e) {
            this._logger.warn('Failed to fetch RFQ pairs for chain', {
                chainId,
                chainName,
                error: this._sanitizeError(e, `fetching RFQ pairs for chain ${chainId}`)
            });
        }
    }

    /**
     * Fetch CLOB pairs if getClobPairs method is available.
     * 
     * This is a wrapper around getClobPairs() to make it consistent
     * with other _fetch_* methods that handle errors internally.
     */
    private async _fetchClobPairs(): Promise<void> {
        try {
            // Check if getClobPairs method exists (from CLOBMixin)
            if (typeof (this as any).getClobPairs === 'function') {
                const result = await (this as any).getClobPairs();
                if (!result.success) {
                    throw new Error(`Failed to fetch CLOB pairs: ${result.error}`);
                }
            } else {
                this._logger.warn('getClobPairs method not available, skipping CLOB pairs fetch');
            }
        } catch (e) {
            this._logger.warn('Error fetching CLOB pairs', {
                error: this._sanitizeError(e, 'fetching CLOB pairs')
            });
            // Don't throw - allow initialization to continue
        }
    }

    public async _fetchDeployments(): Promise<void> {
        await this._fetchContractDeployment('TradePairs');
        await this._fetchContractDeployment('Portfolio');
        await this._fetchContractDeployment('MainnetRFQ');
    }

    public async _fetchContractDeployment(contractType: string): Promise<void> {
        try {
            const items = await this._apiCall<any[]>('get', ENDPOINTS.TRADING_DEPLOYMENT, {
                params: { contracttype: contractType, returnabi: 'true' }
            });

            for (const item of items) {
                // Transform deployment item to standardized field names
                const transformed = this._transformDeploymentFromAPI(item);
                const envString = transformed.env;
                
                // Parse ABI
                let abi: any[] = [];
                if (transformed.abi) {
                    if (Array.isArray(transformed.abi)) abi = transformed.abi;
                    else if (transformed.abi.abi) abi = transformed.abi.abi;
                }
                const address = transformed.address;

                // Store raw deployment
                if (!this.deployments[contractType]) this.deployments[contractType] = {};
                this.deployments[contractType][envString] = { address, abi };

                // Initialize contracts based on type
                const runner = this.signer || this.provider;

                if (contractType === 'TradePairs') {
                    if (envString === this.subnetEnv || envString === ENV.PROD_MULTI_SUBNET || envString === ENV.FUJI_MULTI_SUBNET) {
                        if (runner && address) {
                            this.tradePairsContract = new Contract(address, abi, runner);
                        }
                    }
                } else if (contractType === 'Portfolio') {
                    if (envString === this.subnetEnv || envString === ENV.PROD_MULTI_SUBNET || envString === ENV.FUJI_MULTI_SUBNET) {
                        this.deployments['PortfolioSub'] = { address, abi };
                        if (runner && address) {
                            this.portfolioSubContract = new Contract(address, abi, runner);
                        }
                        if (this.subnetProvider && address) {
                            this.portfolioSubContractView = new Contract(address, abi, this.subnetProvider);
                        }
                    } else {
                        const chainName = this._getChainNameFromEnv(envString);
                        if (chainName && address) {
                            const provider = this.connectedChainProviders[chainName];
                            
                            if (!this.deployments['PortfolioMain']) this.deployments['PortfolioMain'] = {};
                            this.deployments['PortfolioMain'][chainName] = { address, abi };
                            
                            if (provider) {
                                this.portfolioMainContracts[chainName] = new Contract(address, abi, provider);
                            }
                        }
                    }
                } else if (contractType === 'MainnetRFQ') {
                    const chainName = this._getChainNameFromEnv(envString);
                    if (chainName && address) {
                        // deployments['MainnetRFQ'] is always initialized at line 529 above
                        this.deployments['MainnetRFQ'][chainName] = { address, abi };
                        
                        const provider = this.connectedChainProviders[chainName];
                        if (provider) {
                            this.mainnetRfqContracts[chainName] = new Contract(address, abi, provider);
                        }
                    }
                }
            }
        } catch (e) {
            this._logger.error(`Error fetching deployment for ${contractType}`, { 
                error: this._sanitizeError(e, `fetching ${contractType} deployment`) 
            });
        }
    }

    // --- Helper Methods ---

    public _getChainNameFromEnv(envString: string): string | null {
        const envLower = envString.toLowerCase();
        
        for (const [chainName, config] of Object.entries(this.chainConfig)) {
            if (config.env === envString) {
                return chainName;
            }
            if (envLower.includes(chainName.toLowerCase())) {
                return chainName;
            }
        }
        
        if (envLower.includes('fuji')) return 'Fuji';
        if (envLower.includes('avax') || envLower.includes('avalanche')) return 'Avalanche';
        
        return null;
    }

    public _resolveChainId(identifier: string | number): number | null {
        if (typeof identifier === 'number') return identifier;
        
        const config = this.chainConfig[identifier];
        if (config) return config.chain_id;
        
        for (const [name, cfg] of Object.entries(this.chainConfig)) {
            if (name.toLowerCase() === identifier.toLowerCase()) {
                return cfg.chain_id;
            }
        }
        return null;
    }

    public _getChainNameFromId(chainId: number): string | null {
        for (const [name, config] of Object.entries(this.chainConfig)) {
            if (config.chain_id === chainId) {
                return name;
            }
        }
        return null;
    }

    /**
     * Get token decimals for a symbol on a chain.
     */
    public _getTokenDecimals(symbol: string, chainId: number): number | null {
        const tokenEnvs = this.tokenData[symbol];
        if (!tokenEnvs) return null;
        
        for (const info of Object.values(tokenEnvs)) {
            if (info.chainId === chainId) {
                return info.decimals;
            }
        }
        return null;
    }

    /**
     * Fetch and return the list of environments.
     * Cached for 1 hour (static data).
     */
    public async getEnvironments(): Promise<Result<any[]>> {
        const cachedFn = withInstanceCache(
            this,
            this._staticCache,
            'getEnvironments',
            async (): Promise<Result<any[]>> => {
                try {
                    const data = await this._apiCall<any[]>('get', ENDPOINTS.TRADING_ENVIRONMENTS);
                    // Transform environments before storing and returning
                    const transformed = data.map(env => this._transformEnvironmentFromAPI(env));
                    this.environmentsCache = transformed;
                    return Result.ok(transformed);
                } catch (e) {
                    if (this.environmentsCache.length > 0) {
                        // Return cached transformed data
                        return Result.ok(this.environmentsCache);
                    }
                    return Result.fail(this._sanitizeError(e, 'fetching environments'));
                }
            }
        );
        return cachedFn();
    }

    /**
     * Update the signer and reconnect all contracts.
     */
    public async updateSigner(newSigner: Signer): Promise<Result<string>> {
        try {
            this.signer = newSigner;
            if (newSigner.provider) {
                this.provider = newSigner.provider;
            }

            const runner = this.signer;

            // Reconnect subnet contracts
            if (this.tradePairsContract && this.deployments['TradePairs']) {
                const subnetDeploy = Object.values(this.deployments['TradePairs'])[0] as DeploymentInfo;
                if (subnetDeploy) {
                    this.tradePairsContract = new Contract(subnetDeploy.address, subnetDeploy.abi, runner);
                }
            }

            if (this.deployments['PortfolioSub']) {
                const subDeploy = this.deployments['PortfolioSub'] as DeploymentInfo;
                if (subDeploy) {
                    this.portfolioSubContract = new Contract(subDeploy.address, subDeploy.abi, runner);
                }
            }

            // Reconnect mainnet contracts
            if (this.deployments['PortfolioMain']) {
                for (const [chainName, deployment] of Object.entries(this.deployments['PortfolioMain'])) {
                    const deploy = deployment as DeploymentInfo;
                    this.portfolioMainContracts[chainName] = new Contract(deploy.address, deploy.abi, runner);
                }
            }

            if (this.deployments['MainnetRFQ']) {
                for (const [chainName, deployment] of Object.entries(this.deployments['MainnetRFQ'])) {
                    const deploy = deployment as DeploymentInfo;
                    this.mainnetRfqContracts[chainName] = new Contract(deploy.address, deploy.abi, runner);
                }
            }

            this._logger.info('Signer updated and contracts reconnected');
            return Result.ok('Signer updated successfully');
        } catch (error) {
            return Result.fail(this._sanitizeError(error, 'updating signer'));
        }
    }

    /**
     * Get list of available tokens on Dexalot.
     * Cached for 15 minutes (semi-static data).
     */
    public async getTokens(): Promise<Result<any[]>> {
        const cachedFn = withInstanceCache(
            this,
            this._semiStaticCache,
            'getTokens',
            async (): Promise<Result<any[]>> => {
                try {
                    const mainnetChainIds = new Set<number>();
                    for (const config of Object.values(this.chainConfig)) {
                        if (config.chain_id) {
                            mainnetChainIds.add(config.chain_id);
                        }
                    }
                    
                    if (Object.keys(this.tokenData).length > 0) {
                        const uniqueTokens: any[] = [];
                        const seenSymbols = new Set<string>();
                        
                        for (const [symbol, envData] of Object.entries(this.tokenData)) {
                            if (seenSymbols.has(symbol)) continue;
                            
                            for (const [envKey, tokenInfo] of Object.entries(envData)) {
                                const token = tokenInfo as TokenInfo;
                                const chainId = token.chainId || 0;
                                if (chainId && mainnetChainIds.has(chainId)) {
                                    // tokenData already has standardized format (from _fetchTokens)
                                    uniqueTokens.push({
                                        symbol: symbol,
                                        name: token.name || symbol,
                                        decimals: token.decimals || 18,
                                        address: token.address,
                                        chain: this._getChainNameFromId(chainId) || '',
                                        chain_id: chainId,
                                    });
                                    seenSymbols.add(symbol);
                                    break;
                                }
                            }
                        }
                        return Result.ok(uniqueTokens);
                    }
                    
                    const tokens = await this._apiCall<any[]>('get', ENDPOINTS.TRADING_TOKENS);
                    
                    // Transform tokens before processing
                    const transformedTokens = tokens.map(token => this._transformTokenFromAPI(token));
                    
                    const uniqueTokens: any[] = [];
                    const seenSymbols = new Set<string>();
                    for (const token of transformedTokens) {
                        const symbol = token.symbol;
                        const chainId = token.chainId || 0;
                        
                        if (symbol && !seenSymbols.has(symbol) && chainId) {
                            if (mainnetChainIds.has(chainId)) {
                                uniqueTokens.push({
                                    symbol: symbol,
                                    name: token.name || symbol,
                                    decimals: token.evmDecimals || token.decimals || 18,
                                    address: token.address,
                                    chain: token.network || '',
                                    chain_id: chainId,
                                });
                                seenSymbols.add(symbol);
                            }
                        }
                    }
                        return Result.ok(uniqueTokens);
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, 'fetching tokens'));
                    }
                }
            );
        return cachedFn();
    }

    /**
     * Return a dictionary of connected mainnet networks.
     */
    public getMainnets(): Record<number, string> {
        const mainnets: Record<number, string> = {};
        for(const [name, config] of Object.entries(this.chainConfig)) {
            if (config.chain_id) {
                mainnets[config.chain_id] = name;
            }
        }
        return mainnets;
    }

    public getConnectedChains(): string[] {
        return Object.keys(this.chainConfig);
    }

    /**
     * Get deployment configuration.
     * Cached for 1 hour (static data).
     */
    public async getDeployment(): Promise<Result<any>> {
        return withInstanceCache(
            this,
            this._staticCache,
            'getDeployment',
            async () => {
                // Ensure environments are fetched first (needed for providers)
                if (Object.keys(this.chainConfig).length === 0) {
                    const envsResult = await this.getEnvironments();
                    if (!envsResult.success) {
                        return Result.fail(`Failed to fetch environments: ${envsResult.error}`);
                    }
                }
                
                // Always fetch fresh from API (cache wrapper handles TTL)
                await this._fetchDeployments();
                
                return Result.ok(this.deployments);
            }
        )();
    }

    public getSubnetNetworkInfo(): { chainId: number; rpc: string; name: string } | null {
        if (!this.subnetChainId) return null;
        const envData = this.environmentsCache.find((e: any) => e.envType === 'subnet');
        return {
            chainId: this.subnetChainId,
            rpc: envData?.rpc || '',
            name: envData?.network || 'Dexalot Subnet'
        };
    }

    /**
     * Reinitialize all client configuration data.
     * 
     * Refreshes all data loaded during `initialize()`:
     * - Environments (chainConfig, providers, chainId, subnetChainId, env)
     * - Tokens (tokenData)
     * - RFQ pairs (rfqPairs)
     * - Deployments (deployments, contract instances)
     * - CLOB pairs (pairs)
     * 
     * @param forceRefresh - If true, clears relevant caches before reinitializing.
     *                       This ensures fresh data is fetched even if cache TTL hasn't expired.
     * @returns Result with success message on success, or error message on failure
     */
    public async reinitialize(forceRefresh: boolean = false): Promise<Result<string>> {
        return trackOperation(
            this._logger,
            'reinitialize',
            async () => {
                // Clear caches if force_refresh is requested
                if (forceRefresh) {
                    this.invalidateCache('static');
                    this.invalidateCache('semi_static');
                }
                
                // Fetch environments first (sets providers needed for deployments)
                await this._fetchEnvironments();
                
                // Then fetch other data in parallel
                await Promise.all([
                    this._fetchTokens(),
                    this._fetchRfqPairs(),
                    this._fetchDeployments(),
                    this._fetchClobPairs(),
                ]);
                
                return Result.ok('Client reinitialized with all configurations.');
            },
            { parentEnv: this.parentEnv, forceRefresh }
        ).catch((error) => {
            const msg = this._sanitizeError(error, 'reinitializing client');
            return Result.fail(msg);
        });
    }

    /**
     * Invalidate cache entries.
     * 
     * @param level - Cache level to invalidate, or 'all' for all caches
     */
    public invalidateCache(level: 'static' | 'semi_static' | 'balance' | 'orderbook' | 'all' = 'all'): void {
        switch (level) {
            case 'static':
                this._staticCache.clear();
                break;
            case 'semi_static':
                this._semiStaticCache.clear();
                break;
            case 'balance':
                this._balanceCache.clear();
                break;
            case 'orderbook':
                this._orderbookCache.clear();
                break;
            case 'all':
                this._staticCache.clear();
                this._semiStaticCache.clear();
                this._balanceCache.clear();
                this._orderbookCache.clear();
                break;
        }
    }

    // --- Token & Chain Normalization ---

    /**
     * Normalize a user-supplied token symbol (strip, uppercase, apply alias map).
     */
    public normalizeToken(token: string): string {
        return normalizeTokenSymbol(token);
    }

    /**
     * Normalize a user-supplied trading pair (e.g., "eth/usdc" -> "ETH/USDC").
     */
    public normalizePair(pair: string): string {
        return normalizeTradingPair(pair);
    }

    /**
     * Resolve a human-friendly chain alias to the canonical connected chain.
     */
    public resolveChainReference(chainReference: string | number, includeDexalotL1: boolean = false): Result<ResolvedChain> {
        const resolver = new ChainResolver(
            this.chainConfig as any,
            this.chainId || null,
            this.subnetChainId
        );
        return resolver.resolve(chainReference, includeDexalotL1);
    }

    /**
     * Close the client and clean up resources.
     */
    public close(): void {
        // Reset rate limiters
        if (this._apiRateLimiter) {
            this._apiRateLimiter.reset();
        }
        if (this._rpcRateLimiter) {
            this._rpcRateLimiter.reset();
        }
        
        // Clear nonce manager
        if (this._nonceManager) {
            this._nonceManager.clearAll();
        }
        
        this._logger.info('Dexalot client closed');
    }
}
