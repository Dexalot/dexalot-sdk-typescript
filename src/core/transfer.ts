import { ethers, Contract, TransactionResponse, MaxUint256, Provider } from 'ethers';
import { TokenBalance, TokenInfo } from '../types/index.js';
import { ACCESS_ID, ICM_CHAINS, DEFAULTS, ENDPOINTS } from '../constants.js';
import { Utils } from '../utils/index.js';
import { SwapClient } from './swap.js';
import { Result } from '../utils/result.js';
import { withInstanceCache } from '../utils/cache.js';
import {
    validateTokenSymbol,
    validatePositiveFloat,
    validateAddress,
    validateChainIdentifier
} from '../utils/inputValidators.js';

const PORTFOLIO_BRIDGE_ABI = [
    "function getBridgeFee(uint8 _bridge, uint32 _dstChainListOrgChainId, bytes32, uint256, address, bytes1) view returns (uint256)",
    "function portfolioBridge() view returns (address)"
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)"
];

export class TransferClient extends SwapClient {

        /**
         * Resolve ERC-20 contract address/decimals for a chain from cached token data (no RPC).
         */
        private _resolveErc20TokenInfo(
            chainName: string,
            chainId: number,
            token: string
        ): { address: string; decimals: number } | null {
            if (!this.tokenData[token]) {
                return null;
            }
            let tokenInfo: any = null;
            for (const [, data] of Object.entries(this.tokenData[token])) {
                if (data.chainId === chainId) {
                    tokenInfo = data;
                    break;
                }
            }
            if (!tokenInfo) {
                for (const [, data] of Object.entries(this.tokenData[token])) {
                    if (chainName.toLowerCase().includes('fuji') && data.env.includes('fuji')) {
                        tokenInfo = data;
                        break;
                    }
                    if (chainName.toLowerCase().includes('avalanche') && data.env.includes('prod')) {
                        tokenInfo = data;
                        break;
                    }
                }
            }
            if (!tokenInfo || !tokenInfo.address || tokenInfo.address === DEFAULTS.ZERO_ADDRESS) {
                return null;
            }
            return { address: tokenInfo.address, decimals: tokenInfo.decimals || 18 };
        }

        private async _resolveQueryAddress(address?: string): Promise<Result<string>> {
            if (address !== undefined && address !== '') {
                const r = validateAddress(address, 'address');
                if (!r.success) return Result.fail(r.error!);
                return Result.ok(address);
            }
            if (!this.signer) {
                return Result.fail('Address required (pass as param or set signer)');
            }
            try {
                return Result.ok(await this.signer.getAddress());
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'resolving wallet address'));
            }
        }

        /**
         * Fetch token metadata keyed by environment (semi-static cache).
         */
        public async getTokenDetails(token: string): Promise<Result<Record<string, unknown>>> {
            const cachedFn = withInstanceCache(
                this,
                this._semiStaticCache,
                'getTokenDetails',
                async (t: string): Promise<Result<Record<string, unknown>>> => {
                    const tokenResult = validateTokenSymbol(t, 'token');
                    if (!tokenResult.success) {
                        return Result.fail(tokenResult.error!);
                    }
                    const sym = this.normalizeToken(t);
                    try {
                        const tokens = await this._apiCall<any[]>('get', ENDPOINTS.TRADING_TOKENS);
                        const tokenData: Record<string, Record<string, TokenInfo>> = {};
                        for (const row of tokens) {
                            if (!tokenData[row.symbol]) {
                                tokenData[row.symbol] = {};
                            }
                            const decimals =
                                row.evmdecimals !== undefined ? row.evmdecimals : row.evmDecimals ?? 18;
                            tokenData[row.symbol][row.env] = {
                                address: row.address,
                                symbol: row.symbol,
                                name: row.name,
                                decimals,
                                chainId: row.chainid || row.chain_id || 0,
                                env: row.env,
                            };
                        }
                        this.tokenData = { ...this.tokenData, ...tokenData };
                        if (sym in tokenData) {
                            return Result.ok(tokenData[sym] as Record<string, unknown>);
                        }
                        return Result.fail(`Token ${sym} not found.`);
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, 'getting token details'));
                    }
                }
            );
            return cachedFn(token);
        }

        /**
         * Get portfolio balance for a specific token.
         */
        public async getPortfolioBalance(
            token: string,
            address?: string
        ): Promise<Result<TokenBalance>> {
            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) {
                return Result.fail(tokenResult.error!);
            }

            const subDep = this._portfolioSubDeployment();
            if (!subDep) {
                return Result.fail('Subnet View Contract not initialized - check environments/proxy.');
            }
            const addrRes = await this._resolveQueryAddress(address);
            if (!addrRes.success) {
                return Result.fail(addrRes.error!);
            }

            try {
                const queryAddress = addrRes.data!;
                const symbolBytes = Utils.toBytes32(token);
                
                const data = await this.withRpcFailover(this._dexalotL1DisplayName(), async (p) => {
                    const c = this._contractReadOnly(p, subDep.address, subDep.abi);
                    return c.getBalance(queryAddress, symbolBytes);
                });
                const dec = this._resolveTokenDecimals(token);

                return Result.ok({
                    total: parseFloat(Utils.unitConversion(data[0].toString(), dec, false)),
                    available: parseFloat(Utils.unitConversion(data[1].toString(), dec, false)),
                    locked: parseFloat(Utils.unitConversion(data[2].toString(), dec, false))
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting portfolio balance'));
            }
        }

        /**
         * Estimate bridge fee for a deposit on the source chain (fee returned as native-token float, wei ÷ 1e18).
         */
        public async getDepositBridgeFee(
            token: string,
            amount: number,
            sourceChain: string
        ): Promise<Result<number>> {
            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) return Result.fail(tokenResult.error!);

            const amountResult = validatePositiveFloat(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            if (!this.signer) {
                return Result.fail('Signer required for deposit bridge fee.');
            }

            const resolved = this.resolveChainReference(sourceChain);
            if (!resolved.success || !resolved.data) {
                return Result.fail(
                    resolved.error || `Could not resolve source chain '${sourceChain}'.`
                );
            }

            const canonicalSourceChain = resolved.data.canonicalName;
            if (!(canonicalSourceChain in this.chainConfig)) {
                return Result.fail(`Source chain '${sourceChain}' not known.`);
            }

            const mainDep = this._portfolioMainDeployment(canonicalSourceChain);
            if (!mainDep) {
                const available = Object.keys(this.deployments['PortfolioMain'] || {}).join(', ');
                return Result.fail(
                    `PortfolioMain contract not found for '${canonicalSourceChain}'. Available: ${available || 'none'}`
                );
            }

            const chainConfig = this.chainConfig[canonicalSourceChain];
            const srcChainId = chainConfig.chain_id;
            if (!srcChainId) {
                return Result.fail(`Chain config for '${canonicalSourceChain}' missing chain_id.`);
            }

            const normalized = this.normalizeToken(token);
            const dec = this._getTokenDecimals(normalized, srcChainId);
            if (dec === null) {
                return Result.fail(
                    `Token ${normalized} not supported on source chain ${canonicalSourceChain} (ID ${srcChainId}).`
                );
            }

            try {
                const bridgeFeeWei = await this.withRpcFailover(
                    canonicalSourceChain,
                    async (provider) => {
                        const contract = this._contractForSigner(
                            provider,
                            mainDep.address,
                            mainDep.abi
                        );
                        const amountWei = BigInt(Utils.unitConversion(amount, dec, true));
                        const symbolBytes = Utils.toBytes32(normalized);
                        const bridgeId = this._getBridgeId(canonicalSourceChain, false);
                        return this._getBridgeFee(contract, bridgeId, symbolBytes, amountWei);
                    }
                );
                return Result.ok(Number(bridgeFeeWei) / 1e18);
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting bridge fee'));
            }
        }

        /**
         * Deposit tokens from a mainnet chain to Dexalot.
         */
        public async deposit(
            token: string, 
            amount: number, 
            sourceChain: string, 
            useLayerZero: boolean = false,
            waitForReceipt: boolean = true
        ): Promise<Result<{ txHash: string; operation: string }>> {
            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) return Result.fail(tokenResult.error!);

            const amountResult = validatePositiveFloat(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            if (!this.signer) {
                return Result.fail('Signer required for deposit.');
            }
            
            const mainDep = this._portfolioMainDeployment(sourceChain);
            if (!mainDep) {
                const availableChains = Object.keys(this.deployments['PortfolioMain'] || {}).join(', ');
                return Result.fail(
                    `PortfolioMain contract not found for '${sourceChain}'. Available: ${availableChains || 'none'}`
                );
            }

            const chainConfig = this.chainConfig[sourceChain];
            if (!chainConfig) {
                return Result.fail(`Chain config not found for '${sourceChain}'`);
            }

            try {
                return await this.withRpcFailover(sourceChain, async (provider) => {
                    const contract = this._contractForSigner(
                        provider,
                        mainDep.address,
                        mainDep.abi
                    );
                    const nativeSymbol = chainConfig.native_symbol || 'ETH';
                    const chainId = chainConfig.chain_id;

                    const dec = this._getTokenDecimals(token, chainId) || 18;
                    const amountWei = BigInt(Utils.unitConversion(amount, dec, true));
                    const symbolBytes = Utils.toBytes32(token);
                    const bridgeId = this._getBridgeId(sourceChain, useLayerZero);

                    const bridgeFee = await this._getBridgeFee(contract, bridgeId, symbolBytes, amountWei);
                    const signerAddress = await this.signer!.getAddress();
                    
                    let tx: TransactionResponse;
                    
                    if (token === nativeSymbol) {
                        const gasEst = await contract.depositNative.estimateGas(signerAddress, bridgeId, { value: amountWei + bridgeFee });
                        const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                        tx = await contract.depositNative(signerAddress, bridgeId, { value: amountWei + bridgeFee, gasLimit });
                    } else {
                        const chainEnv = chainConfig.env;
                        const tokenAddr = chainEnv ? this.tokenData[token]?.[chainEnv]?.address : null;
                        if (!tokenAddr) {
                            throw new Error(`Token address for ${token} not found on ${sourceChain}`);
                        }

                        const mainnetRunner = contract.runner;
                        await this._ensureAllowance(tokenAddr, await contract.getAddress(), amountWei, mainnetRunner);
                        
                        const gasEst = await contract.depositToken.estimateGas(
                            signerAddress,
                            symbolBytes,
                            amountWei,
                            bridgeId,
                            { value: bridgeFee }
                        );
                        const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));

                        tx = await contract.depositToken(
                            signerAddress,
                            symbolBytes,
                            amountWei,
                            bridgeId,
                            { value: bridgeFee, gasLimit }
                        );
                    }
                    
                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({ txHash: receipt.hash, operation: 'deposit' });
                    }

                    return Result.ok({ txHash: tx.hash, operation: 'deposit' });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'depositing tokens'));
            }
        }
        
        /**
         * Withdraw tokens from Dexalot to a mainnet chain.
         */
        public async withdraw(
            token: string, 
            amount: number, 
            destinationChain: string, 
            useLayerZero: boolean = false,
            waitForReceipt: boolean = true
        ): Promise<Result<{ txHash: string; operation: string }>> {
            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) return Result.fail(tokenResult.error!);

            const amountResult = validatePositiveFloat(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            if (!this.signer) {
                return Result.fail('Signer required for withdrawal.');
            }

            const chainConfig = this.chainConfig[destinationChain];
            if (!chainConfig) {
                return Result.fail(`Destination chain '${destinationChain}' not found.`);
            }

            const subDep = this._portfolioSubDeployment();
            if (!subDep) {
                return Result.fail('Portfolio Sub contract not available.');
            }

            try {
                return await this.withRpcFailover(this._dexalotL1DisplayName(), async (provider) => {
                    const contract = this._contractForSigner(provider, subDep.address, subDep.abi);
                    const destChainId = chainConfig.chain_id;
                    const decimals = this._getTokenDecimals(token, destChainId) ?? 18;
                    const amountWei = BigInt(Utils.unitConversion(amount, decimals, true));
                    const bridgeId = this._getBridgeId(destinationChain, useLayerZero);
                    const symbolBytes = Utils.toBytes32(token);
                    const signerAddress = await this.signer!.getAddress();

                    const subnetTokenAddr = this.tokenData[token]?.[this.subnetEnv]?.address; 
                    if (subnetTokenAddr) {
                        const subnetRunner = contract.runner;
                        await this._ensureAllowance(subnetTokenAddr, await contract.getAddress(), amountWei, subnetRunner);
                    }

                    const gasEst = await contract.withdrawToken.estimateGas(
                        signerAddress,
                        symbolBytes,
                        amountWei,
                        bridgeId,
                        destChainId
                    );
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));

                    const tx = await contract.withdrawToken(
                        signerAddress,
                        symbolBytes,
                        amountWei,
                        bridgeId,
                        destChainId,
                        { gasLimit }
                    );
                    
                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({ txHash: receipt.hash, operation: 'withdraw' });
                    }

                    return Result.ok({ txHash: tx.hash, operation: 'withdraw' });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'withdrawing tokens'));
            }
        }

        /**
         * Transfer tokens within portfolio to another address.
         */
        public async transferPortfolio(
            token: string, 
            amount: number, 
            toAddress: string,
            waitForReceipt: boolean = true
        ): Promise<Result<{ txHash: string; operation: string }>> {
            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) return Result.fail(tokenResult.error!);

            const amountResult = validatePositiveFloat(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            const addressResult = validateAddress(toAddress, 'toAddress');
            if (!addressResult.success) return Result.fail(addressResult.error!);

            const subDep = this._portfolioSubDeployment();
            if (!this.signer || !subDep) {
                return Result.fail('Signer/Contract not initialized.');
            }
             
            try {
                const balResult = await this.getPortfolioBalance(token);
                if (!balResult.success) {
                    return Result.fail(balResult.error!);
                }
                if (balResult.data!.available < amount) {
                    return Result.fail(`Insufficient available balance: have ${balResult.data!.available}, need ${amount}`);
                }

                const dec = this._getTokenDecimals(token, this.subnetChainId || 0) ?? 18;
                const amountWei = BigInt(Utils.unitConversion(amount, dec, true));
                const symbolBytes = Utils.toBytes32(token);

                return await this.withRpcFailover(this._dexalotL1DisplayName(), async (provider) => {
                    const contract = this._contractForSigner(provider, subDep.address, subDep.abi);
                    const gasEst = await contract.transferToken.estimateGas(toAddress, symbolBytes, amountWei);
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                    const tx = await contract.transferToken(toAddress, symbolBytes, amountWei, { gasLimit });
                    
                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({ txHash: receipt.hash, operation: 'transfer_portfolio' });
                    }

                    return Result.ok({ txHash: tx.hash, operation: 'transfer_portfolio' });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'transferring tokens'));
            }
        }

        /**
         * Transfer tokens from the signer portfolio to another address on Dexalot L1 (`token`, `toAddress`, `amount`).
         */
        public async transferToken(
            token: string,
            toAddress: string,
            amount: number,
            waitForReceipt: boolean = true
        ): Promise<Result<string>> {
            const r = await this.transferPortfolio(token, amount, toAddress, waitForReceipt);
            if (!r.success || !r.data) {
                return Result.fail(r.error || 'Transfer failed');
            }
            return Result.ok(`Transfer Token transaction sent: ${r.data.txHash}`);
        }

        /**
         * Add gas (withdraw native ALOT to wallet).
         */
        public async addGas(amount: number, waitForReceipt: boolean = true): Promise<Result<{ txHash: string; operation: string }>> {
            const amountResult = validatePositiveFloat(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            const subDep = this._portfolioSubDeployment();
            if (!this.signer || !subDep) {
                return Result.fail('Signer/Contract not initialized.');
            }

            try {
                const amountWei = BigInt(Utils.unitConversion(amount, 18, true));
                const signerAddress = await this.signer.getAddress();
                return await this.withRpcFailover(this._dexalotL1DisplayName(), async (provider) => {
                    const contract = this._contractForSigner(provider, subDep.address, subDep.abi);
                    const gasEst = await contract.withdrawNative.estimateGas(signerAddress, amountWei);
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                    const tx = await contract.withdrawNative(signerAddress, amountWei, { gasLimit });
                    
                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({ txHash: receipt.hash, operation: 'add_gas' });
                    }

                    return Result.ok({ txHash: tx.hash, operation: 'add_gas' });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'adding gas'));
            }
        }

        /**
         * Remove gas (deposit native ALOT from wallet).
         */
        public async removeGas(amount: number, waitForReceipt: boolean = true): Promise<Result<{ txHash: string; operation: string }>> {
            const amountResult = validatePositiveFloat(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            const subDep = this._portfolioSubDeployment();
            if (!this.signer || !subDep) {
                return Result.fail('Signer/Contract not initialized.');
            }

            try {
                const amountWei = BigInt(Utils.unitConversion(amount, 18, true));
                const signerAddress = await this.signer.getAddress();
                return await this.withRpcFailover(this._dexalotL1DisplayName(), async (provider) => {
                    const contract = this._contractForSigner(provider, subDep.address, subDep.abi);
                    const gasEst = await contract.depositNative.estimateGas(signerAddress, 0, { value: amountWei });
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                    const tx = await contract.depositNative(signerAddress, 0, { value: amountWei, gasLimit });
                    
                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            return Result.fail("Transaction reverted");
                        }
                        return Result.ok({ txHash: receipt.hash, operation: 'remove_gas' });
                    }

                    return Result.ok({ txHash: tx.hash, operation: 'remove_gas' });
                });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'removing gas'));
            }
        }

        /**
         * Get wallet balance for a specific token on a specific chain.
         */
        public async getChainWalletBalance(
            chain: string,
            token: string,
            address?: string
        ): Promise<Result<any>> {
            const addrRes = await this._resolveQueryAddress(address);
            if (!addrRes.success) {
                return Result.fail(addrRes.error!);
            }
            const queryAddress = addrRes.data!;

            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) return Result.fail(tokenResult.error!);

            try {
                if (chain === "Dexalot L1") {
                    if (token !== "ALOT") {
                        return Result.fail(`Token ${token} not available on Dexalot L1. Only ALOT (native) exists.`);
                    }
                    return Result.ok(await this._getL1NativeBalance(queryAddress));
                }

                if (!this.isChainRpcAvailable(chain)) {
                    const available = ["Dexalot L1", ...this.getAvailableChainNames()];
                    return Result.fail(`Chain '${chain}' not connected. Available: ${available.join(', ')}`);
                }

                const chainInfo = this.chainConfig[chain] || {};
                const chainId = chainInfo.chain_id;
                const nativeSymbol = chainInfo.native_symbol || 'ETH';

                if (token === nativeSymbol) {
                    const data = await this.withRpcFailover(chain, async (provider) => {
                        const bal = await provider.getBalance(queryAddress);
                        return {
                            chain,
                            symbol: nativeSymbol,
                            type: "Native",
                            balance: Utils.unitConversion(bal.toString(), 18, false),
                        };
                    });
                    return Result.ok(data);
                }

                if (!chainId) {
                    return Result.fail(`Chain ID not configured for ${chain}`);
                }

                if (!this.tokenData[token]) {
                    return Result.fail(`Token ${token} not found in token data.`);
                }

                const meta = this._resolveErc20TokenInfo(chain, chainId, token);
                if (!meta) {
                    return Result.fail(`Token ${token} not available on chain ${chain}.`);
                }

                const data = await this.withRpcFailover(chain, async (provider) => {
                    const contract = new Contract(meta.address, ERC20_ABI, provider);
                    const bal = await contract.balanceOf(queryAddress);
                    return {
                        chain,
                        symbol: token,
                        balance: Utils.unitConversion(bal.toString(), meta.decimals, false),
                        address: meta.address,
                        type: "ERC20",
                    };
                });
                return Result.ok(data);
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting chain wallet balance'));
            }
        }

        /**
         * Get all token balances on a specific chain.
         */
        public async getChainWalletBalances(chain: string, address?: string): Promise<Result<any>> {
            const addrRes = await this._resolveQueryAddress(address);
            if (!addrRes.success) {
                return Result.fail(addrRes.error!);
            }
            const queryAddress = addrRes.data!;

            try {
                const info: any = {
                    address: queryAddress,
                    chain: chain,
                    chain_balances: []
                };

                if (chain === "Dexalot L1") {
                    const l1Entry = await this._getL1NativeBalance(queryAddress);
                    if (!l1Entry.error) {
                        info.chain_balances.push(l1Entry);
                    }
                    return Result.ok(info);
                }

                if (!this.isChainRpcAvailable(chain)) {
                    const available = ["Dexalot L1", ...this.getAvailableChainNames()];
                    return Result.fail(`Chain '${chain}' not connected. Available: ${available.join(', ')}`);
                }

                const chainInfo = this.chainConfig[chain] || {};
                const chainId = chainInfo.chain_id;
                const nativeSymbol = chainInfo.native_symbol || 'ETH';

                await this.withRpcFailover(chain, async (provider) => {
                    const bal = await provider.getBalance(queryAddress);
                    info.chain_balances.push({
                        chain,
                        symbol: nativeSymbol,
                        type: "Native",
                        balance: Utils.unitConversion(bal.toString(), 18, false),
                    });
                    if (chainId) {
                        await this._fetchErc20Balances(info, chainId, chain, provider, queryAddress);
                    }
                });

                return Result.ok(info);
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting chain wallet balances'));
            }
        }

        /**
         * Get all token balances across all connected chains.
         */
        public async getAllChainWalletBalances(address?: string): Promise<Result<any>> {
            const addrRes = await this._resolveQueryAddress(address);
            if (!addrRes.success) {
                return Result.fail(addrRes.error!);
            }
            const queryAddress = addrRes.data!;

            try {
                const info: any = {
                    address: queryAddress,
                    chain_balances: []
                };

                const l1Entry = await this._getL1NativeBalance(queryAddress);
                if (!l1Entry.error) {
                    info.chain_balances.push(l1Entry);
                }

                for (const name of this.getAvailableChainNames()) {
                    const chainInfo = this.chainConfig[name] || {};
                    const chainId = chainInfo.chain_id;
                    const nativeSymbol = chainInfo.native_symbol || 'ETH';

                    try {
                        await this.withRpcFailover(name, async (provider) => {
                            const bal = await provider.getBalance(queryAddress);
                            info.chain_balances.push({
                                chain: name,
                                symbol: nativeSymbol,
                                type: "Native",
                                balance: Utils.unitConversion(bal.toString(), 18, false),
                            });
                            if (chainId) {
                                await this._fetchErc20Balances(info, chainId, name, provider, queryAddress);
                            }
                        });
                    } catch (e: any) {
                        info.chain_balances.push({
                            chain: name,
                            symbol: nativeSymbol,
                            type: "Native",
                            balance: `Error: ${e.message ?? String(e)}`,
                        });
                    }
                }

                return Result.ok(info);
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting all chain wallet balances'));
            }
        }

        public async _getL1NativeBalance(address: string): Promise<any> {
            const entry: any = { chain: "Dexalot L1", symbol: "ALOT", balance: "Not connected", type: "Native" };
            if (this.isChainRpcAvailable("Dexalot L1")) {
                try {
                    const wei = await this.withRpcFailover("Dexalot L1", async (p) => p.getBalance(address));
                    entry.balance = Utils.unitConversion(wei.toString(), 18, false);
                } catch (e: any) {
                    entry.balance = `Error: ${e.message ?? String(e)}`;
                }
                return entry;
            }
            const l1Fallback = this.subnetProvider || this.provider || this.signer?.provider;
            if (l1Fallback) {
                try {
                    const l1Bal = await l1Fallback.getBalance(address);
                    entry.balance = Utils.unitConversion(l1Bal.toString(), 18, false);
                } catch (e: any) {
                    entry.balance = `Error: ${e.message}`;
                }
            }
            return entry;
        }

        public async _getNativeBalance(chainName: string, provider: Provider, address: string, nativeSymbol: string): Promise<any> {
            const entry = {
                chain: chainName,
                symbol: nativeSymbol,
                balance: "Error",
                type: "Native"
            };
            try {
                const bal = await provider.getBalance(address);
                entry.balance = Utils.unitConversion(bal.toString(), 18, false);
            } catch (e: any) {
                entry.balance = `Error: ${e.message}`;
            }
            return entry;
        }

        public async _getErc20Balance(chainName: string, chainId: number, provider: Provider, address: string, token: string): Promise<any> {
            if (!this.tokenData[token]) {
                return { error: `Token ${token} not found in token data.` };
            }

            let tokenInfo: any = null;
            for (const [_envKey, data] of Object.entries(this.tokenData[token])) {
                if (data.chainId === chainId) {
                    tokenInfo = data;
                    break;
                }
            }

            if (!tokenInfo) {
                for (const [_envKey, data] of Object.entries(this.tokenData[token])) {
                    if (chainName.toLowerCase().includes('fuji') && data.env.includes('fuji')) {
                        tokenInfo = data;
                        break;
                    }
                    if (chainName.toLowerCase().includes('avalanche') && data.env.includes('prod')) {
                        tokenInfo = data;
                        break;
                    }
                }
            }

            if (!tokenInfo || !tokenInfo.address || tokenInfo.address === DEFAULTS.ZERO_ADDRESS) {
                return { error: `Token ${token} not available on chain ${chainName}.` };
            }

            const entry = {
                chain: chainName,
                symbol: token,
                balance: "Error",
                address: tokenInfo.address,
                type: "ERC20"
            };

            try {
                const contract = new Contract(tokenInfo.address, ERC20_ABI, provider);
                const bal = await contract.balanceOf(address);
                const dec = tokenInfo.decimals || 18;
                entry.balance = Utils.unitConversion(bal.toString(), dec, false);
            } catch (e: any) {
                entry.balance = `Error: ${e.message}`;
            }

            return entry;
        }

        public async _fetchErc20Balances(info: any, chainId: number, chainName: string, provider: Provider, address: string) {
            const entries = Object.entries(this.tokenData);
            const concurrency = Math.max(1, this.config.erc20BalanceConcurrency);
            let nextIndex = 0;

            const worker = async () => {
                while (nextIndex < entries.length) {
                    const current = nextIndex++;
                    const [symbol, envData] = entries[current] as [string, Record<string, any>];

                    let tokenInfo: any = null;
                    for (const [_envKey, data] of Object.entries(envData)) {
                        if (data.chainId === chainId) {
                            tokenInfo = data;
                            break;
                        }
                    }

                    if (!tokenInfo) {
                        for (const [_envKey, data] of Object.entries(envData)) {
                            if (chainName.toLowerCase().includes('fuji') && data.env.includes('fuji')) {
                                tokenInfo = data;
                                break;
                            }
                            if (chainName.toLowerCase().includes('avalanche') && data.env.includes('prod')) {
                                tokenInfo = data;
                                break;
                            }
                        }
                    }

                    if (!tokenInfo || !tokenInfo.address || tokenInfo.address === DEFAULTS.ZERO_ADDRESS) {
                        continue;
                    }

                    const tokenEntry = {
                        chain: chainName,
                        symbol,
                        balance: 'Error',
                        address: tokenInfo.address,
                        type: 'ERC20',
                    };

                    try {
                        const contract = new Contract(tokenInfo.address, ERC20_ABI, provider);
                        const bal = await contract.balanceOf(address);
                        const dec = tokenInfo.decimals || 18;
                        tokenEntry.balance = Utils.unitConversion(bal.toString(), dec, false);
                        info.chain_balances.push(tokenEntry);
                    } catch {
                        continue;
                    }
                }
            };

            await Promise.all(Array.from({ length: concurrency }, () => worker()));
        }
        
        /**
         * Get all portfolio balances.
         */
        public async getAllPortfolioBalances(address?: string): Promise<Result<Record<string, TokenBalance>>> {
            const subDep = this._portfolioSubDeployment();
            if (!subDep) {
                return Result.fail('Subnet View Contract not initialized.');
            }
            const addrRes = await this._resolveQueryAddress(address);
            if (!addrRes.success) {
                return Result.fail(addrRes.error!);
            }
            const queryAddress = addrRes.data!;

            try {
                const balances = await this.withRpcFailover(this._dexalotL1DisplayName(), async (p) => {
                    const c = this._contractReadOnly(p, subDep.address, subDep.abi);
                    const out: Record<string, TokenBalance> = {};
                    let page = 0;
                    
                    while (true) {
                        const data = await c.getBalances(queryAddress, page);
                        const symbolsBytes = data[0];
                        const totals = data[1];
                        const availables = data[2];
                        
                        if (symbolsBytes.length === 0) break;

                        for (let i = 0; i < symbolsBytes.length; i++) {
                            const symbol = Utils.fromBytes32(symbolsBytes[i]);
                            const dec = this._resolveTokenDecimals(symbol);
                         
                            const total = parseFloat(Utils.unitConversion(totals[i].toString(), dec, false));
                            const available = parseFloat(Utils.unitConversion(availables[i].toString(), dec, false));
                         
                            out[symbol] = {
                                total,
                                available,
                                locked: total - available
                            };
                        }
                        page++;
                        if (page > 10) break;
                    }
                    return out;
                });
                
                return Result.ok(balances);
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting all portfolio balances'));
            }
        }

        // --- Helper Methods ---

        /**
         * Resolve token decimals: try subnet chain, then connected chain, default 18.
         */
        public _resolveTokenDecimals(token: string): number {
            return this._getTokenDecimals(token, this.subnetChainId ?? 0)
                ?? this._getTokenDecimals(token, this.chainId)
                ?? 18;
        }

        public _getBridgeId(chainName: string, useLayerZero: boolean): number {
            const isIcm = ICM_CHAINS.some(c => chainName.toLowerCase().includes(c.toLowerCase()));
            if (isIcm && !useLayerZero) return ACCESS_ID.ICM;
            return ACCESS_ID.LZ;
        }

        public async _getBridgeFee(portfolioContract: Contract, bridgeId: number, symbolBytes: string, amount: bigint): Promise<bigint> {
            try {
                const bridgeAddr = await portfolioContract.portfolioBridge();
                if (!bridgeAddr) return 0n;

                const runner = portfolioContract.runner || this.signer || this.provider;
                const bridge = new Contract(bridgeAddr, PORTFOLIO_BRIDGE_ABI, runner);
                const address = await this.signer?.getAddress() || DEFAULTS.ZERO_ADDRESS;
                
                return await bridge.getBridgeFee(
                    bridgeId,
                    this.subnetChainId || 0,
                    symbolBytes,
                    amount,
                    address,
                    "0x00"
                );
            } catch (e) {
                this._logger.warn('Failed to get bridge fee, defaulting to 0', { error: String(e) });
                return 0n;
            }
        }

        public async _ensureAllowance(token: string, spender: string, amount: bigint, runner?: any) {
            const signerToUse = runner || this.signer;
            const contract = new Contract(token, ERC20_ABI, signerToUse);
            const address = await this.signer!.getAddress();
            const allowance = await contract.allowance(address, spender);
            if (allowance < amount) {
                const tx = await contract.approve(spender, MaxUint256);
                await tx.wait();
            }
        }
}
