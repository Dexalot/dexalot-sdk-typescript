export * from './cache.js';
export * from './result.js';
export { asyncRetry, asyncRetryResult, type RetryOptions } from './retry.js';
export { AsyncRateLimiter, withRateLimit } from './rateLimit.js';
export { AsyncNonceManager } from './nonceManager.js';
export { sanitizeErrorMessage, extractUserMessage, createSafeError } from './errorSanitizer.js';
export * from './inputValidators.js';
export { ProviderManager, type ProviderManagerConfig } from './providerManager.js';
export { WebSocketManager, type WebSocketConfig, type ConnectionState, type MessageCallback } from './websocketManager.js';
export * from './observability.js';
export { normalizeTokenSymbol, normalizeTradingPair } from './tokenNormalization.js';
export { ChainResolver, normalizeChainAlias, inferChainFamily, inferEnvironmentKind, type ResolvedChain } from './chainResolver.js';
import { formatUnits, parseUnits, encodeBytes32String, decodeBytes32String } from "ethers";

export class Utils {
  /**
   * Convert string to bytes32 padded with null bytes.
   * Uses ethers.encodeBytes32String which automatically handles padding.
   */
  static toBytes32(text: string): string {
    // ethers.encodeBytes32String handles the padding and hex conversion
    // Note: It throws if the string is longer than 31 chars.
    try {
        return encodeBytes32String(text);
    } catch (e) {
        // Fallback for strings that might be raw hex already or custom handling if needed,
        // but for Dexalot pairs (e.g. "AVAX/USDC") this is standard.
        // If the string is already a hex string, return it formatted?. 
        // For now, strict behavior is safer.
        throw new Error(`Failed to convert '${text}' to bytes32: ${e}`);
    }
  }

  /**
   * Convert bytes32 to string stripping null bytes.
   */
  static fromBytes32(hex: string): string {
    return decodeBytes32String(hex);
  }

  /**
   * Convert between human-readable and raw unit amounts.
   * @param amount The amount to convert.
   * @param decimals The number of decimals.
   * @param toBase If true, convert from Display (1.5) to Base (1.5e18). If false, Base to Display.
   */
  static unitConversion(amount: string | number, decimals: number, toBase: boolean = true): string {
    if (toBase) {
      // Display -> Base
      const amountStr = amount.toString();
      return parseUnits(amountStr, decimals).toString();
    } else {
      // Base -> Display
      const amountStr = amount.toString();
      return formatUnits(amountStr, decimals);
    }
  }
}
