import { ethers, Contract, TransactionResponse, MaxUint256, Provider } from 'ethers';
import {
    TokenBalance,
    TokenInfo,
    PricePoint,
    Transfer,
    TransferActionType,
    TransferBridge,
    TransferStatus,
} from '../types/index.js';
import { ACCESS_ID, ICM_CHAINS, DEFAULTS, ENDPOINTS } from '../constants.js';
import { Utils } from '../utils/index.js';
import { toWei } from '../utils/decimal.js';
import { SwapClient } from './swap.js';
import { Result } from '../utils/result.js';
import { withInstanceCache } from '../utils/cache.js';
import {
    validateTokenSymbol,
    validatePositiveNumber,
    validateAddress,
    validateChainIdentifier
} from '../utils/inputValidators.js';

// Re-export PricePoint / Transfer types so consumers importing from
// `dexalot-sdk/internal` (which re-exports `core/transfer`) see them
// alongside the methods that return them. The canonical declarations
// live in `src/types/index.ts`.
export type {
    PricePoint,
    Transfer,
    TransferActionType,
    TransferBridge,
    TransferStatus,
} from '../types/index.js';

// Numeric enum → human-readable string lookup tables for the
// `transferscombined` REST response. These mirror the
// `TRANSFER_ACTION_TYPE` / `TRANSFER_STATUS` / `BRIDGES` enums that the
// official Dexalot frontend uses to render the same rows; keeping them
// in lockstep avoids drift if the backend ever adds new variants.
const TRANSFER_ACTION_TYPE_LABELS: Record<number, TransferActionType> = {
    0: 'WITHDRAWN',
    1: 'DEPOSITED',
    5: 'SENT',
    6: 'RECEIVED',
    7: 'RECOVERED',
    8: 'ADD_GAS',
    9: 'REMOVE_GAS',
    10: 'AUTO_FILL',
    11: 'WITHDRAW_PENDING',
    12: 'DEPOSIT_PENDING',
};

const TRANSFER_STATUS_LABELS: Record<number, TransferStatus> = {
    0: 'COMPLETED',
    1: 'INFLIGHT',
    2: 'DELAYED',
};

const TRANSFER_BRIDGE_LABELS: Record<number, TransferBridge> = {
    [-1]: 'NATIVE',
    0: 'LAYER0',
    1: 'CELER',
    2: 'ICM',
};

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

            const amountResult = validatePositiveNumber(amount, 'amount');
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
                        const amountWei = toWei(amount, dec);
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

            const amountResult = validatePositiveNumber(amount, 'amount');
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
                    const amountWei = toWei(amount, dec);
                    const symbolBytes = Utils.toBytes32(token);
                    const bridgeId = this._getBridgeId(sourceChain, useLayerZero);

                    const bridgeFee = await this._getBridgeFee(contract, bridgeId, symbolBytes, amountWei);
                    const signerAddress = await this.signer!.getAddress();
                    
                    let tx: TransactionResponse;
                    let allowanceGrantedToken: string | null = null;
                    let allowanceGrantedRunner: any = null;

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
                        const spender = await contract.getAddress();
                        await this._ensureAllowance(tokenAddr, spender, amountWei, mainnetRunner);
                        allowanceGrantedToken = tokenAddr;
                        allowanceGrantedRunner = mainnetRunner;

                        const gasEst = await contract.depositToken.estimateGas(
                            signerAddress,
                            symbolBytes,
                            amountWei,
                            bridgeId,
                            { value: bridgeFee }
                        );
                        const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));

                        try {
                            tx = await contract.depositToken(
                                signerAddress,
                                symbolBytes,
                                amountWei,
                                bridgeId,
                                { value: bridgeFee, gasLimit }
                            );
                        } catch (txError) {
                            // Best-effort allowance revoke. Swallow secondary errors so the
                            // caller sees the original tx failure, not the revoke failure.
                            try {
                                await this._revokeAllowance(allowanceGrantedToken, spender, allowanceGrantedRunner);
                            } catch (revokeError) {
                                this._logger.debug('Best-effort allowance revoke failed after deposit tx error', {
                                    token,
                                    error: String(revokeError),
                                });
                            }
                            throw txError;
                        }
                    }

                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            if (allowanceGrantedToken) {
                                const spender = await contract.getAddress();
                                try {
                                    await this._revokeAllowance(allowanceGrantedToken, spender, allowanceGrantedRunner);
                                } catch (revokeError) {
                                    this._logger.debug('Best-effort allowance revoke failed after deposit revert', {
                                        token,
                                        error: String(revokeError),
                                    });
                                }
                            }
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

            const amountResult = validatePositiveNumber(amount, 'amount');
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
                    const amountWei = toWei(amount, decimals);
                    const bridgeId = this._getBridgeId(destinationChain, useLayerZero);
                    const symbolBytes = Utils.toBytes32(token);
                    const signerAddress = await this.signer!.getAddress();

                    const subnetTokenAddr = this.tokenData[token]?.[this.subnetEnv]?.address;
                    let allowanceGrantedToken: string | null = null;
                    let allowanceGrantedRunner: any = null;
                    const spender = await contract.getAddress();
                    if (subnetTokenAddr) {
                        const subnetRunner = contract.runner;
                        await this._ensureAllowance(subnetTokenAddr, spender, amountWei, subnetRunner);
                        allowanceGrantedToken = subnetTokenAddr;
                        allowanceGrantedRunner = subnetRunner;
                    }

                    const gasEst = await contract.withdrawToken.estimateGas(
                        signerAddress,
                        symbolBytes,
                        amountWei,
                        bridgeId,
                        destChainId
                    );
                    const gasLimit = BigInt(Math.floor(Number(gasEst) * DEFAULTS.GAS_BUFFER));

                    let tx: TransactionResponse;
                    try {
                        tx = await contract.withdrawToken(
                            signerAddress,
                            symbolBytes,
                            amountWei,
                            bridgeId,
                            destChainId,
                            { gasLimit }
                        );
                    } catch (txError) {
                        if (allowanceGrantedToken) {
                            try {
                                await this._revokeAllowance(allowanceGrantedToken, spender, allowanceGrantedRunner);
                            } catch (revokeError) {
                                this._logger.debug('Best-effort allowance revoke failed after withdraw tx error', {
                                    token,
                                    error: String(revokeError),
                                });
                            }
                        }
                        throw txError;
                    }

                    if (waitForReceipt) {
                        const receipt = await tx.wait();
                        if (!receipt || receipt.status !== 1) {
                            if (allowanceGrantedToken) {
                                try {
                                    await this._revokeAllowance(allowanceGrantedToken, spender, allowanceGrantedRunner);
                                } catch (revokeError) {
                                    this._logger.debug('Best-effort allowance revoke failed after withdraw revert', {
                                        token,
                                        error: String(revokeError),
                                    });
                                }
                            }
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

            const amountResult = validatePositiveNumber(amount, 'amount');
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
                const amountWei = toWei(amount, dec);
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
            const amountResult = validatePositiveNumber(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            const subDep = this._portfolioSubDeployment();
            if (!this.signer || !subDep) {
                return Result.fail('Signer/Contract not initialized.');
            }

            try {
                const amountWei = toWei(amount, 18);
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
            const amountResult = validatePositiveNumber(amount, 'amount');
            if (!amountResult.success) return Result.fail(amountResult.error!);

            const subDep = this._portfolioSubDeployment();
            if (!this.signer || !subDep) {
                return Result.fail('Signer/Contract not initialized.');
            }

            try {
                const amountWei = toWei(amount, 18);
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
         * Get balances for an explicit list of tokens on one chain.
         *
         * Returns a flat `token -> balance` map. The caller specifies exactly
         * which tokens to read; unknown tokens produce an aggregated error
         * rather than being silently skipped. Cached for 10 seconds (balance
         * cache tier); cache keys are order-insensitive — `['AVAX', 'USDC']`
         * and `['USDC', 'AVAX']` share a cache slot because tokens are
         * sorted and deduplicated before delegating to the cached internal.
         */
        public async getChainTokenBalances(
            chain: string,
            tokens: string[],
            address?: string
        ): Promise<Result<Record<string, string>>> {
            if (typeof chain !== 'string' || !chain.trim()) {
                return Result.fail(
                    `Invalid chain: must be non-empty string, got ${typeof chain}`
                );
            }
            if (!Array.isArray(tokens) || tokens.length === 0) {
                return Result.fail('tokens must be a non-empty array of token symbols.');
            }
            for (const tok of tokens) {
                const tokRes = validateTokenSymbol(tok, 'tokens');
                if (!tokRes.success) return Result.fail(tokRes.error!);
            }

            const resolved = this.resolveChainReference(chain, true);
            if (!resolved.success || !resolved.data) {
                return Result.fail(resolved.error || `Could not resolve chain '${chain}'.`);
            }

            const addrRes = await this._resolveQueryAddress(address);
            if (!addrRes.success) {
                return Result.fail(addrRes.error!);
            }

            // Sort + dedupe so that ['AVAX', 'USDC'] and ['USDC', 'AVAX']
            // share a cache slot. Tokens are also canonicalized via
            // normalizeToken so 'avax' and 'AVAX' collapse.
            const normalized = Array.from(
                new Set(tokens.map(t => this.normalizeToken(t)))
            ).sort();

            return this._getChainTokenBalancesCached(
                resolved.data.canonicalName,
                addrRes.data!,
                normalized
            );
        }

        /**
         * Cached internal: fetch each requested token's balance in parallel
         * and aggregate. Sorted+deduped `tokens` keeps the cache key stable
         * for caller-order variations of the same set.
         */
        private async _getChainTokenBalancesCached(
            chain: string,
            queryAddress: string,
            tokens: string[]
        ): Promise<Result<Record<string, string>>> {
            const cachedFn = withInstanceCache(
                this,
                this._balanceCache,
                'getChainTokenBalances',
                async (
                    c: string,
                    addr: string,
                    toks: string[]
                ): Promise<Result<Record<string, string>>> => {
                    const results = await Promise.allSettled(
                        toks.map(t => this.getChainWalletBalance(c, t, addr))
                    );

                    const balances: Record<string, string> = {};
                    const unknown: string[] = [];
                    const errors: string[] = [];

                    for (let i = 0; i < toks.length; i++) {
                        const tok = toks[i];
                        const r = results[i];
                        if (r.status === 'rejected') {
                            errors.push(`${tok}: ${this._sanitizeError(r.reason, 'fetching balance')}`);
                            continue;
                        }
                        const res = r.value;
                        if (!res.success || !res.data) {
                            const err = res.error || 'unknown error';
                            if (err.includes('not available') || err.includes('not found')) {
                                unknown.push(tok);
                            } else {
                                errors.push(`${tok}: ${err}`);
                            }
                            continue;
                        }
                        const bal = (res.data as any).balance;
                        balances[tok] = bal === undefined || bal === null ? '' : String(bal);
                    }

                    if (unknown.length > 0) {
                        return Result.fail(
                            `Unknown tokens on chain ${c}: ${JSON.stringify(unknown)}`
                        );
                    }
                    if (errors.length > 0) {
                        return Result.fail(errors.join('; '));
                    }
                    return Result.ok(balances);
                }
            );
            return cachedFn(chain, queryAddress, tokens);
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
                // Pages are fetched in parallel batches: each batch of
                // BATCH_SIZE pages is issued via Promise.all, then we
                // check for an empty page (the end-of-data signal). If
                // the backend has more data we advance and issue the
                // next batch. PAGE_HARD_CAP bounds the worst case.
                const BATCH_SIZE = 5;
                const PAGE_HARD_CAP = 50;

                const balances = await this.withRpcFailover(this._dexalotL1DisplayName(), async (p) => {
                    const c = this._contractReadOnly(p, subDep.address, subDep.abi);
                    const out: Record<string, TokenBalance> = {};

                    let batchStart = 0;
                    while (batchStart < PAGE_HARD_CAP) {
                        const batchEnd = Math.min(batchStart + BATCH_SIZE, PAGE_HARD_CAP);
                        const pageNumbers: number[] = [];
                        for (let pg = batchStart; pg < batchEnd; pg++) pageNumbers.push(pg);

                        const results = await Promise.all(
                            pageNumbers.map((pg) => c.getBalances(queryAddress, pg))
                        );

                        let sawEmpty = false;
                        for (const data of results) {
                            const symbolsBytes = data[0];
                            if (!symbolsBytes || symbolsBytes.length === 0) {
                                sawEmpty = true;
                                break;
                            }
                            const totals = data[1];
                            const availables = data[2];
                            for (let i = 0; i < symbolsBytes.length; i++) {
                                const symbol = Utils.fromBytes32(symbolsBytes[i]);
                                const dec = this._resolveTokenDecimals(symbol);
                                const total = parseFloat(
                                    Utils.unitConversion(totals[i].toString(), dec, false)
                                );
                                const available = parseFloat(
                                    Utils.unitConversion(availables[i].toString(), dec, false)
                                );
                                out[symbol] = {
                                    total,
                                    available,
                                    locked: total - available,
                                };
                            }
                        }

                        if (sawEmpty) break;
                        batchStart += BATCH_SIZE;
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
            const lower = chainName.toLowerCase();
            const isIcm =
                ICM_CHAINS.some(c => lower.includes(c.toLowerCase())) || lower.includes('gunz');
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

        /**
         * Unconditionally set ERC20 allowance for `spender` to 0. Used as a
         * best-effort cleanup when a deposit/withdraw transaction reverts after
         * `_ensureAllowance` has already granted `MaxUint256` — leaving the
         * granted allowance in place would expose the user to a stale approval.
         * Callers wrap this in their own try/catch; secondary failures must be
         * logged at debug and never override the original transaction error.
         */
        public async _revokeAllowance(token: string, spender: string, runner?: any) {
            const signerToUse = runner || this.signer;
            const contract = new Contract(token, ERC20_ABI, signerToUse);
            const tx = await contract.approve(spender, 0n);
            await tx.wait();
        }

        /**
         * Coerce a single price value into a finite positive number. Returns
         * `null` for anything we cannot confidently interpret as a price
         * (non-string/non-number, empty string, NaN, ±Infinity, negative).
         * The backend currently emits decimal strings (including scientific
         * notation e.g. `"1.04662e-7"`), so `parseFloat` is the right primitive
         * — but we tolerate plain numbers too in case the shape ever flips.
         */
        private _coerceUsdPrice(raw: unknown): number | null {
            if (typeof raw === 'number') {
                return Number.isFinite(raw) && raw >= 0 ? raw : null;
            }
            if (typeof raw !== 'string') return null;
            const trimmed = raw.trim();
            if (trimmed === '') return null;
            const n = parseFloat(trimmed);
            if (!Number.isFinite(n) || n < 0) return null;
            return n;
        }

        /**
         * Fetch current USD prices for every Dexalot-listed token. Public
         * endpoint, no signed auth required. Cached for 15 minutes (semi-static
         * tier).
         *
         * Returns a `Record<string, number>` map of token symbol → USD price.
         * The backend currently emits the map shape directly as
         * `Record<string, string>` (string prices, including scientific
         * notation for very small values); we coerce to `number` and silently
         * drop entries we cannot interpret. An array-of-objects fallback
         * (`[{symbol, price}, ...]`) is also accepted in case the backend
         * shape ever changes.
         *
         * The `env` query parameter is forwarded for parity with the Python
         * SDK and to namespace the cache key per network; the backend itself
         * currently determines the network from the API host and does not
         * consult the parameter.
         */
        public async getTokenUsdPrices(env?: string): Promise<Result<Record<string, number>>> {
            const targetEnv = env ?? this.config.parentEnv;
            const cachedFn = withInstanceCache(
                this,
                this._semiStaticCache,
                `getTokenUsdPrices|${targetEnv}`,
                async (): Promise<Result<Record<string, number>>> => {
                    try {
                        const data = await this._apiCall<unknown>(
                            'get',
                            ENDPOINTS.INFO_USD_PRICES,
                            { params: { env: targetEnv } }
                        );
                        const out: Record<string, number> = {};
                        if (Array.isArray(data)) {
                            // Forward-compat: array-of-objects shape.
                            for (const row of data) {
                                if (!row || typeof row !== 'object') continue;
                                const r = row as Record<string, unknown>;
                                const symbol = typeof r.symbol === 'string' ? r.symbol.trim() : '';
                                if (!symbol) continue;
                                const price = this._coerceUsdPrice(r.price);
                                if (price === null) continue;
                                out[symbol] = price;
                            }
                            return Result.ok(out);
                        }
                        if (data && typeof data === 'object') {
                            // Current shape: flat `Record<string, string>` map.
                            for (const [symbol, raw] of Object.entries(data as Record<string, unknown>)) {
                                const trimmedSym = symbol.trim();
                                if (!trimmedSym) continue;
                                const price = this._coerceUsdPrice(raw);
                                if (price === null) continue;
                                out[trimmedSym] = price;
                            }
                            return Result.ok(out);
                        }
                        return Result.fail(
                            `Unexpected USD prices response shape: expected object or array, got ${typeof data}.`
                        );
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, 'fetching token USD prices'));
                    }
                }
            );
            return cachedFn();
        }

        /**
         * Coerce a raw timestamp value (number or numeric string) into unix
         * seconds. Heuristic: anything ≥ 1e12 is treated as milliseconds and
         * divided by 1000 (a 32-bit second-precision unix epoch maxes out at
         * `2^31 ≈ 2.1e9`, so 1e12 is a safe boundary that catches both
         * `Date.now()` and 13-digit string forms). Returns `null` if the
         * input cannot be parsed as a finite non-negative integer.
         */
        private _coerceTimestampSeconds(raw: unknown): number | null {
            let n: number;
            if (typeof raw === 'number') {
                n = raw;
            } else if (typeof raw === 'string') {
                const trimmed = raw.trim();
                if (trimmed === '') return null;
                n = Number(trimmed);
            } else {
                return null;
            }
            if (!Number.isFinite(n) || n < 0) return null;
            if (n >= 1e12) n = Math.floor(n / 1000);
            return Math.floor(n);
        }

        /**
         * Coerce a raw price value into a finite non-negative number. Mirrors
         * `_coerceUsdPrice` above but exposed as a separate helper so future
         * tightening of the price-history shape (e.g. requiring strictly
         * positive prices) is local to one branch.
         */
        private _coerceHistoryPrice(raw: unknown): number | null {
            if (typeof raw === 'number') {
                return Number.isFinite(raw) && raw >= 0 ? raw : null;
            }
            if (typeof raw !== 'string') return null;
            const trimmed = raw.trim();
            if (trimmed === '') return null;
            const n = parseFloat(trimmed);
            if (!Number.isFinite(n) || n < 0) return null;
            return n;
        }

        /**
         * Pull a timestamp out of a raw row. The backend currently emits
         * `date` as an ISO-8601 string; we additionally accept `ts`,
         * `timestamp`, and `time` (numeric or numeric-string) so the contract
         * is stable if the shape ever flips. Returns unix seconds (UTC), or
         * `null` if no recognised field parses.
         */
        private _extractHistoryTimestamp(row: Record<string, unknown>): number | null {
            // ISO-string `date` first, matching the current backend shape.
            const rawDate = row.date;
            if (typeof rawDate === 'string' && rawDate.trim() !== '') {
                const parsed = Date.parse(rawDate);
                if (Number.isFinite(parsed)) {
                    return Math.floor(parsed / 1000);
                }
            }
            // Numeric aliases — try each in turn.
            for (const key of ['ts', 'timestamp', 'time'] as const) {
                if (key in row) {
                    const coerced = this._coerceTimestampSeconds(row[key]);
                    if (coerced !== null) return coerced;
                }
            }
            return null;
        }

        /**
         * Shared implementation for daily / hourly USD price history. Public
         * methods only vary in the REST endpoint constant they pass here, so
         * the cache key, normalization, sort order, and client-side
         * `[from, to]` filter are guaranteed to behave identically across
         * both surfaces.
         *
         * Cache: static tier (1h TTL) — past prices don't change. Cache key
         * includes `path` so daily and hourly never collide on the same slot
         * even with identical `(token, from, to)` tuples.
         */
        private async _fetchPriceHistory(
            path: string,
            token: string,
            opts?: { from?: number; to?: number }
        ): Promise<Result<PricePoint[]>> {
            const tokenResult = validateTokenSymbol(token, 'token');
            if (!tokenResult.success) {
                return Result.fail(tokenResult.error!);
            }
            const sym = this.normalizeToken(token);
            const from = opts?.from;
            const to = opts?.to;
            const cachedFn = withInstanceCache(
                this,
                this._staticCache,
                `priceHistory|${path}|${sym}|${from ?? ''}|${to ?? ''}`,
                async (): Promise<Result<PricePoint[]>> => {
                    try {
                        const params: Record<string, string | number> = { token: sym };
                        if (from !== undefined) params.from = from;
                        if (to !== undefined) params.to = to;
                        const data = await this._apiCall<unknown>(
                            'get',
                            path,
                            { params }
                        );
                        if (!Array.isArray(data)) {
                            return Result.fail(
                                `Unexpected price history response shape: expected array, got ${typeof data}.`
                            );
                        }
                        const points: PricePoint[] = [];
                        for (const row of data) {
                            if (!row || typeof row !== 'object') continue;
                            const r = row as Record<string, unknown>;
                            const ts = this._extractHistoryTimestamp(r);
                            if (ts === null) continue;
                            const price = this._coerceHistoryPrice(r.price);
                            if (price === null) continue;
                            if (from !== undefined && ts < from) continue;
                            if (to !== undefined && ts > to) continue;
                            points.push({ timestamp: ts, price });
                        }
                        points.sort((a, b) => a.timestamp - b.timestamp);
                        return Result.ok(points);
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, 'fetching token price history'));
                    }
                }
            );
            return cachedFn();
        }

        /**
         * Daily USD price history for one token. Returns an ascending-time
         * ordered `PricePoint[]` from the public `token-usd-price-history`
         * endpoint. Past prices don't change, so results are cached in the
         * static tier (1h TTL); the cache key is path-namespaced so daily
         * and hourly never collide.
         *
         * The optional `from`/`to` window is in unix seconds. The backend
         * currently ignores it (the host fixes the network and the
         * lookback) but the SDK forwards both for forward-compat and
         * additionally filters the returned series client-side so the
         * caller's range contract holds regardless of backend behavior.
         *
         * No authentication required (public endpoint).
         */
        public async getTokenPriceHistory(
            token: string,
            opts?: { from?: number; to?: number }
        ): Promise<Result<PricePoint[]>> {
            return this._fetchPriceHistory(ENDPOINTS.INFO_PRICE_HISTORY, token, opts);
        }

        /**
         * Hourly USD price history for one token. Same contract as
         * `getTokenPriceHistory` (ascending-time `PricePoint[]`, static-tier
         * 1h cache, optional `from`/`to` window applied client-side) but
         * routes through the hourly endpoint. Useful when a more granular
         * series is needed than the daily variant — backend currently
         * returns the trailing ~24h at 3-hour granularity.
         *
         * No authentication required (public endpoint).
         */
        public async getTokenHourlyPriceHistory(
            token: string,
            opts?: { from?: number; to?: number }
        ): Promise<Result<PricePoint[]>> {
            return this._fetchPriceHistory(ENDPOINTS.INFO_HOURLY_PRICE_HISTORY, token, opts);
        }

        /**
         * Coerce a Big-string display-decimal numeric value (e.g. `"100.5"`)
         * into a finite non-negative `number`. The backend's
         * `transferscombined` rows ship `quantity` and `fee` as already-
         * display-decimal numeric strings — there is no wei→human
         * conversion to apply. Returns `null` for non-string/non-number
         * input, empty strings, or anything that does not parse to a
         * finite non-negative float (mirroring how the frontend's
         * NumberHelper guards against malformed rows).
         */
        private _coerceTransferAmount(raw: unknown): number | null {
            if (typeof raw === 'number') {
                return Number.isFinite(raw) && raw >= 0 ? raw : null;
            }
            if (typeof raw !== 'string') return null;
            const trimmed = raw.trim();
            if (trimmed === '') return null;
            const n = parseFloat(trimmed);
            if (!Number.isFinite(n) || n < 0) return null;
            return n;
        }

        /**
         * Normalize one raw `DBTransfer`-shaped row from the backend into
         * the canonical `Transfer` type. Returns `null` for any row that
         * is missing required fields or carries an unknown
         * `action_type` / `status` enum — the public method silently
         * drops these so a single bad row doesn't poison the page.
         *
         * `bridge` falls back to `"NATIVE"` for unknown enum values
         * because the frontend treats unrecognised bridges the same way
         * (display-only label, no behavior depends on the precise id),
         * and the row is otherwise valid.
         */
        private _normalizeTransfer(raw: unknown): Transfer | null {
            if (!raw || typeof raw !== 'object') return null;
            const r = raw as Record<string, unknown>;

            const actionKey = typeof r.action_type === 'number' ? r.action_type : null;
            if (actionKey === null) return null;
            const actionType = TRANSFER_ACTION_TYPE_LABELS[actionKey];
            if (!actionType) return null;

            const statusKey = typeof r.status === 'number' ? r.status : null;
            if (statusKey === null) return null;
            const status = TRANSFER_STATUS_LABELS[statusKey];
            if (!status) return null;

            const symbol = typeof r.symbol === 'string' ? r.symbol : null;
            if (!symbol) return null;

            const quantity = this._coerceTransferAmount(r.quantity);
            if (quantity === null) return null;

            // Fee defaults to 0 if missing or unparseable — many native /
            // portfolio-internal legs report `"0"` and some omit the field.
            const fee = this._coerceTransferAmount(r.fee) ?? 0;

            const traderAddress = typeof r.traderaddress === 'string' ? r.traderaddress : '';
            const bridgeKey = typeof r.bridge === 'number' ? r.bridge : -1;
            const bridge = TRANSFER_BRIDGE_LABELS[bridgeKey] ?? 'NATIVE';

            const bridgeUrl = typeof r.bridge_url === 'string' ? r.bridge_url : '';
            const nonce = typeof r.nonce === 'number' ? r.nonce : -1;
            const sourceEnv = typeof r.source_env === 'string' ? r.source_env : '';
            const sourceChainId =
                typeof r.source_chain_id === 'number' ? r.source_chain_id : 0;
            const sourceTx = typeof r.source_tx === 'string' ? r.source_tx : '';
            const sourceTs = typeof r.source_ts === 'string' ? r.source_ts : '';

            const targetEnv = typeof r.target_env === 'string' ? r.target_env : null;
            const targetChainId =
                typeof r.target_chain_id === 'number' ? r.target_chain_id : null;
            const targetTx = typeof r.target_tx === 'string' ? r.target_tx : null;
            const targetTs = typeof r.target_ts === 'string' ? r.target_ts : null;

            return {
                actionType,
                status,
                symbol,
                quantity,
                fee,
                traderAddress,
                bridge,
                bridgeUrl,
                nonce,
                sourceEnv,
                sourceChainId,
                sourceTx,
                sourceTs,
                targetEnv,
                targetChainId,
                targetTx,
                targetTs,
            };
        }

        /**
         * Paginated history of every deposit, withdrawal, gas top-up,
         * portfolio P2P send/receive, and bridge recovery involving the
         * connected wallet. Returns canonical `Transfer[]` rows with
         * camelCase fields and human-readable `actionType` / `status`
         * / `bridge` labels lifted from the backend's numeric enums.
         *
         * Routes through the signed REST endpoint
         * `/api/trading/signed/transferscombined`; `x-signature` is
         * attached via the shared `_getAuthHeaders()` helper. The
         * backend's request shape uses `itemsperpage` / `pageno` /
         * `periodfrom` / `periodto` / `symbol` query params (NOT the
         * `limit`/`offset`/`from`/`to`/`kind` shape suggested by a
         * plan-only reading of the trade-kit tool wrapper) — the
         * trade-kit's MCP tool forwards `limit`/`offset` blindly but
         * the actual backend ignores them.
         *
         * Cached for 10 seconds (balance tier) per `(address, opts)`
         * tuple — distinct signers and distinct filter combinations
         * never share a cache slot. Returned amounts (`quantity`,
         * `fee`) are already display-decimal numbers; no
         * wei→human conversion is applied because the backend has
         * already done it.
         */
        public async getCombinedTransfers(opts?: {
            symbol?: string;
            periodfrom?: string;
            periodto?: string;
            itemsperpage?: number;
            pageno?: number;
        }): Promise<Result<Transfer[]>> {
            if (!this.signer) {
                return Result.fail('Signer not configured.');
            }
            let address: string;
            try {
                address = await this.signer.getAddress();
            } catch (e) {
                return Result.fail(this._sanitizeError(e, 'resolving wallet address'));
            }

            const itemsperpage = opts?.itemsperpage ?? 100;
            const pageno = opts?.pageno ?? 1;
            const symbol = opts?.symbol ? this.normalizeToken(opts.symbol) : undefined;
            const periodfrom = opts?.periodfrom;
            const periodto = opts?.periodto;

            // Cache key is namespaced by resolved address so signer
            // swaps within a single client never collide on the same
            // slot, and by the serialized opts so different filter
            // combinations are distinct.
            const cacheArgs = JSON.stringify({
                itemsperpage,
                pageno,
                symbol,
                periodfrom,
                periodto,
            });

            const cachedFn = withInstanceCache(
                this,
                this._balanceCache,
                `getCombinedTransfers|${address}|${cacheArgs}`,
                async (): Promise<Result<Transfer[]>> => {
                    try {
                        const headers = await this._getAuthHeaders();
                        const params: Record<string, string | number> = {
                            itemsperpage,
                            pageno,
                        };
                        if (symbol !== undefined) params.symbol = symbol;
                        if (periodfrom !== undefined) params.periodfrom = periodfrom;
                        if (periodto !== undefined) params.periodto = periodto;

                        const data = await this._apiCall<unknown>(
                            'get',
                            ENDPOINTS.TRADING_COMBINED_TRANSFERS,
                            { headers, params }
                        );

                        // Backend ships `{count, rows}`; we tolerate a
                        // bare array as a forward-compat fallback.
                        let rows: unknown[];
                        if (Array.isArray(data)) {
                            rows = data;
                        } else if (data && typeof data === 'object') {
                            const envelope = data as Record<string, unknown>;
                            rows = Array.isArray(envelope.rows) ? envelope.rows : [];
                        } else {
                            return Result.fail(
                                `Unexpected transfers response shape: expected object or array, got ${typeof data}.`
                            );
                        }

                        const transfers: Transfer[] = [];
                        for (const row of rows) {
                            const normalized = this._normalizeTransfer(row);
                            if (normalized) transfers.push(normalized);
                        }
                        return Result.ok(transfers);
                    } catch (e) {
                        return Result.fail(this._sanitizeError(e, 'fetching combined transfers'));
                    }
                }
            );
            return cachedFn();
        }
}
