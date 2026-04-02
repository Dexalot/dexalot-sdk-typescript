import { ethers, Contract, TransactionResponse, MaxUint256, Provider } from 'ethers';
import { TokenBalance } from '../types/index.js';
import { ACCESS_ID, ICM_CHAINS, DEFAULTS } from '../constants.js';
import { Utils } from '../utils/index.js';
import { SwapClient } from './swap.js';
import { Result } from '../utils/result.js';
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
         * Get portfolio balance for a specific token.
         */
        public async getPortfolioBalance(token: string): Promise<Result<TokenBalance>> {
            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) {
                return Result.fail(tokenResult.error!);
            }

            if (!this.portfolioSubContractView) {
                return Result.fail('Subnet View Contract not initialized - check environments/proxy.');
            }
            if (!this.signer) {
                return Result.fail('Signer not configured.');
            }

            try {
                const address = await this.signer.getAddress();
                const symbolBytes = Utils.toBytes32(token);
                
                const data = await this.portfolioSubContractView.getBalance(address, symbolBytes);
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
         * Deposit tokens from a mainnet chain to Dexalot.
         */
        public async deposit(
            token: string, 
            amount: number, 
            sourceChain: string, 
            useLayerZero: boolean = false,
            waitForReceipt: boolean = true
        ): Promise<Result<{txHash: string}>> {
            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) return Result.fail(tokenResult.error!);

            const amountResult = validatePositiveFloat(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            if (!this.signer) {
                return Result.fail('Signer required for deposit.');
            }
            
            const contract = this.portfolioMainContracts[sourceChain];
            if (!contract) {
                const availableChains = Object.keys(this.portfolioMainContracts).join(', ');
                return Result.fail(`PortfolioMain contract not found for '${sourceChain}'. Available: ${availableChains || 'none'}`);
            }

            const chainConfig = this.chainConfig[sourceChain];
            if (!chainConfig) {
                return Result.fail(`Chain config not found for '${sourceChain}'`);
            }

            try {
                const nativeSymbol = chainConfig.native_symbol || 'ETH';
                const chainId = chainConfig.chain_id;

                const dec = this._getTokenDecimals(token, chainId) || 18;
                const amountWei = BigInt(Utils.unitConversion(amount, dec, true));
                const symbolBytes = Utils.toBytes32(token);
                const bridgeId = this._getBridgeId(sourceChain, useLayerZero);

                const bridgeFee = await this._getBridgeFee(contract, bridgeId, symbolBytes, amountWei);
                const signerAddress = await this.signer.getAddress();
                
                let tx: TransactionResponse;
                
                if (token === nativeSymbol) {
                    const gasEst = await contract.depositNative.estimateGas(signerAddress, bridgeId, { value: amountWei + bridgeFee });
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                    tx = await contract.depositNative(signerAddress, bridgeId, { value: amountWei + bridgeFee, gasLimit });
                } else {
                    const chainEnv = chainConfig.env;
                    const tokenAddr = chainEnv ? this.tokenData[token]?.[chainEnv]?.address : null;
                    if (!tokenAddr) {
                        return Result.fail(`Token address for ${token} not found on ${sourceChain}`);
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
                    return Result.ok({ txHash: receipt.hash });
                }
                
                return Result.ok({ txHash: tx.hash });
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
        ): Promise<Result<{txHash: string}>> {
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

            const contract = this.portfolioSubContract;
            if (!contract) {
                return Result.fail('Portfolio Sub contract not available.');
            }

            try {
                const destChainId = chainConfig.chain_id;
                const decimals = this._getTokenDecimals(token, destChainId) ?? 18;
                const amountWei = BigInt(Utils.unitConversion(amount, decimals, true));
                const bridgeId = this._getBridgeId(destinationChain, useLayerZero);
                const symbolBytes = Utils.toBytes32(token);
                const signerAddress = await this.signer.getAddress();

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
                    return Result.ok({ txHash: receipt.hash });
                }
                
                return Result.ok({ txHash: tx.hash });
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
        ): Promise<Result<{txHash: string}>> {
            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) return Result.fail(tokenResult.error!);

            const amountResult = validatePositiveFloat(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            const addressResult = validateAddress(toAddress, 'toAddress');
            if (!addressResult.success) return Result.fail(addressResult.error!);

            const contract = this.portfolioSubContract;
            if (!this.signer || !contract) {
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

                const gasEst = await contract.transferToken.estimateGas(toAddress, symbolBytes, amountWei);
                const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                const tx = await contract.transferToken(toAddress, symbolBytes, amountWei, { gasLimit });
                
                if (waitForReceipt) {
                    const receipt = await tx.wait();
                    if (!receipt || receipt.status !== 1) {
                        return Result.fail("Transaction reverted");
                    }
                    return Result.ok({ txHash: receipt.hash });
                }
                
                return Result.ok({ txHash: tx.hash });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'transferring tokens'));
            }
        }

        /**
         * Transfer tokens (alias for transferPortfolio).
         */
        public async transferToken(
            token: string, 
            toAddress: string, 
            amount: number
        ): Promise<Result<{txHash: string}>> {
            return this.transferPortfolio(token, amount, toAddress);
        }

        /**
         * Add gas (withdraw native ALOT to wallet).
         */
        public async addGas(amount: number, waitForReceipt: boolean = true): Promise<Result<{txHash: string}>> {
            const amountResult = validatePositiveFloat(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            const contract = this.portfolioSubContract;
            if (!this.signer || !contract) {
                return Result.fail('Signer/Contract not initialized.');
            }

            try {
                const amountWei = BigInt(Utils.unitConversion(amount, 18, true));
                const signerAddress = await this.signer.getAddress();
                const gasEst = await contract.withdrawNative.estimateGas(signerAddress, amountWei);
                const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                const tx = await contract.withdrawNative(signerAddress, amountWei, { gasLimit });
                
                if (waitForReceipt) {
                    const receipt = await tx.wait();
                    if (!receipt || receipt.status !== 1) {
                        return Result.fail("Transaction reverted");
                    }
                    return Result.ok({ txHash: receipt.hash });
                }
                
                return Result.ok({ txHash: tx.hash });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'adding gas'));
            }
        }

        /**
         * Remove gas (deposit native ALOT from wallet).
         */
        public async removeGas(amount: number, waitForReceipt: boolean = true): Promise<Result<{txHash: string}>> {
            const amountResult = validatePositiveFloat(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            const contract = this.portfolioSubContract;
            if (!this.signer || !contract) {
                return Result.fail('Signer/Contract not initialized.');
            }

            try {
                const amountWei = BigInt(Utils.unitConversion(amount, 18, true));
                const signerAddress = await this.signer.getAddress();
                const gasEst = await contract.depositNative.estimateGas(signerAddress, 0, { value: amountWei });
                const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));
                const tx = await contract.depositNative(signerAddress, 0, { value: amountWei, gasLimit });
                
                if (waitForReceipt) {
                    const receipt = await tx.wait();
                    if (!receipt || receipt.status !== 1) {
                        return Result.fail("Transaction reverted");
                    }
                    return Result.ok({ txHash: receipt.hash });
                }
                
                return Result.ok({ txHash: tx.hash });
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'removing gas'));
            }
        }

        /**
         * Get wallet balance for a specific token on a specific chain.
         */
        public async getChainWalletBalance(chain: string, token: string): Promise<Result<any>> {
            if (!this.signer) {
                return Result.fail('Private key not configured.');
            }

            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) return Result.fail(tokenResult.error!);
            
            try {
                const address = await this.signer.getAddress();

                if (chain === "Dexalot L1") {
                    if (token !== "ALOT") {
                        return Result.fail(`Token ${token} not available on Dexalot L1. Only ALOT (native) exists.`);
                    }
                    return Result.ok(await this._getL1NativeBalance(address));
                }

                if (!this.connectedChainProviders[chain]) {
                    const available = ["Dexalot L1", ...Object.keys(this.connectedChainProviders)];
                    return Result.fail(`Chain '${chain}' not connected. Available: ${available.join(', ')}`);
                }

                const provider = this.connectedChainProviders[chain];
                const chainInfo = this.chainConfig[chain] || {};
                const chainId = chainInfo.chain_id;
                const nativeSymbol = chainInfo.native_symbol || 'ETH';

                if (token === nativeSymbol) {
                    return Result.ok(await this._getNativeBalance(chain, provider, address, nativeSymbol));
                }

                if (!chainId) {
                    return Result.fail(`Chain ID not configured for ${chain}`);
                }

                return Result.ok(await this._getErc20Balance(chain, chainId, provider, address, token));
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting chain wallet balance'));
            }
        }

        /**
         * Get all token balances on a specific chain.
         */
        public async getChainWalletBalances(chain: string): Promise<Result<any>> {
            if (!this.signer) {
                return Result.fail('Private key not configured.');
            }
            
            try {
                const address = await this.signer.getAddress();
                const info: any = {
                    address: address,
                    chain: chain,
                    chain_balances: []
                };

                if (chain === "Dexalot L1") {
                    const l1Entry = await this._getL1NativeBalance(address);
                    if (!l1Entry.error) {
                        info.chain_balances.push(l1Entry);
                    }
                    return Result.ok(info);
                }

                if (!this.connectedChainProviders[chain]) {
                    const available = ["Dexalot L1", ...Object.keys(this.connectedChainProviders)];
                    return Result.fail(`Chain '${chain}' not connected. Available: ${available.join(', ')}`);
                }

                const provider = this.connectedChainProviders[chain];
                const chainInfo = this.chainConfig[chain] || {};
                const chainId = chainInfo.chain_id;
                const nativeSymbol = chainInfo.native_symbol || 'ETH';

                const nativeEntry = await this._getNativeBalance(chain, provider, address, nativeSymbol);
                if (!nativeEntry.error) {
                    info.chain_balances.push(nativeEntry);
                }

                if (chainId) {
                    await this._fetchErc20Balances(info, chainId, chain, provider, address);
                }

                return Result.ok(info);
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting chain wallet balances'));
            }
        }

        /**
         * Get all token balances across all connected chains.
         */
        public async getAllChainWalletBalances(): Promise<Result<any>> {
            if (!this.signer) {
                return Result.fail('Private key not configured.');
            }
             
            try {
                const address = await this.signer.getAddress();
                const info: any = {
                    address: address,
                    chain_balances: []
                };

                const l1Entry = await this._getL1NativeBalance(address);
                if (!l1Entry.error) {
                    info.chain_balances.push(l1Entry);
                }

                for (const [name, provider] of Object.entries(this.connectedChainProviders)) {
                    const chainInfo = this.chainConfig[name] || {};
                    const chainId = chainInfo.chain_id;
                    const nativeSymbol = chainInfo.native_symbol || 'ETH';

                    const nativeEntry = await this._getNativeBalance(name, provider, address, nativeSymbol);
                    if (!nativeEntry.error) {
                        info.chain_balances.push(nativeEntry);
                    }

                    if (chainId) {
                        await this._fetchErc20Balances(info, chainId, name, provider, address);
                    }
                }

                return Result.ok(info);
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'getting all chain wallet balances'));
            }
        }

        public async _getL1NativeBalance(address: string): Promise<any> {
            const l1Provider = this.provider || this.signer?.provider;
            const entry: any = { chain: "Dexalot L1", symbol: "ALOT", balance: "Not connected", type: "Native" };
            if (l1Provider) {
                try {
                    const l1Bal = await l1Provider.getBalance(address);
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
            for (const [symbol, envData] of Object.entries(this.tokenData)) {
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

                if (!tokenInfo || !tokenInfo.address || tokenInfo.address === DEFAULTS.ZERO_ADDRESS) continue;

                const tokenEntry = {
                    chain: chainName,
                    symbol: symbol,
                    balance: "Error",
                    address: tokenInfo.address,
                    type: "ERC20"
                };

                try {
                     const contract = new Contract(tokenInfo.address, ERC20_ABI, provider);
                     const bal = await contract.balanceOf(address);
                     const dec = tokenInfo.decimals || 18;
                     tokenEntry.balance = Utils.unitConversion(bal.toString(), dec, false);
                } catch (e) {
                     continue;
                }

                info.chain_balances.push(tokenEntry);
            }
        }
        
        /**
         * Get all portfolio balances.
         */
        public async getAllPortfolioBalances(): Promise<Result<Record<string, TokenBalance>>> {
            if (!this.portfolioSubContractView) {
                return Result.fail('Subnet View Contract not initialized.');
            }
            if (!this.signer) {
                return Result.fail('Signer not initialized.');
            }
             
            try {
                const address = await this.signer.getAddress();
                const balances: Record<string, TokenBalance> = {};
                let page = 0;
                
                while (true) {
                    const data = await this.portfolioSubContractView.getBalances(address, page);
                    const symbolsBytes = data[0];
                    const totals = data[1];
                    const availables = data[2];
                    
                    if (symbolsBytes.length === 0) break;

                    for (let i = 0; i < symbolsBytes.length; i++) {
                        const symbol = Utils.fromBytes32(symbolsBytes[i]);
                        const dec = this._resolveTokenDecimals(symbol);
                     
                        const total = parseFloat(Utils.unitConversion(totals[i].toString(), dec, false));
                        const available = parseFloat(Utils.unitConversion(availables[i].toString(), dec, false));
                     
                        balances[symbol] = {
                            total,
                            available,
                            locked: total - available
                        };
                    }
                    page++;
                    if (page > 10) break;
                }
                
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
