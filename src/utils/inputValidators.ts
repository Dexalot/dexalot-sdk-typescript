import { Result } from './result.js';

/**
 * Input validation functions returning Result<null>.
 * Matches Python SDK's input_validators.py implementation.
 */

// Pre-compiled regex patterns for efficiency
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const PAIR_PATTERN = /^[A-Z0-9]+\/[A-Z0-9]+$/;
const ORDER_ID_HEX_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const TOKEN_SYMBOL_PATTERN = /^[A-Z0-9]{1,10}$/;

/**
 * Validate that a value is a positive number (> 0).
 */
export function validatePositiveFloat(value: number, paramName: string): Result<null> {
    if (typeof value !== 'number' || isNaN(value)) {
        return Result.fail(`${paramName} must be a number, got ${typeof value}`);
    }
    if (value <= 0) {
        return Result.fail(`${paramName} must be positive, got ${value}`);
    }
    if (!isFinite(value)) {
        return Result.fail(`${paramName} must be finite, got ${value}`);
    }
    return Result.ok(null);
}

/**
 * Validate that a value is a positive integer (> 0).
 */
export function validatePositiveInt(value: number, paramName: string): Result<null> {
    if (typeof value !== 'number' || isNaN(value)) {
        return Result.fail(`${paramName} must be a number, got ${typeof value}`);
    }
    if (!Number.isInteger(value)) {
        return Result.fail(`${paramName} must be an integer, got ${value}`);
    }
    if (value <= 0) {
        return Result.fail(`${paramName} must be positive, got ${value}`);
    }
    return Result.ok(null);
}

/**
 * Validate that a value is a non-negative number (>= 0).
 */
export function validateNonNegativeFloat(value: number, paramName: string): Result<null> {
    if (typeof value !== 'number' || isNaN(value)) {
        return Result.fail(`${paramName} must be a number, got ${typeof value}`);
    }
    if (value < 0) {
        return Result.fail(`${paramName} must be non-negative, got ${value}`);
    }
    if (!isFinite(value)) {
        return Result.fail(`${paramName} must be finite, got ${value}`);
    }
    return Result.ok(null);
}

/**
 * Validate Ethereum address format.
 */
export function validateAddress(address: string, paramName: string = 'address'): Result<null> {
    if (typeof address !== 'string') {
        return Result.fail(`${paramName} must be a string, got ${typeof address}`);
    }
    if (!address.trim()) {
        return Result.fail(`${paramName} cannot be empty`);
    }
    if (!ADDRESS_PATTERN.test(address)) {
        return Result.fail(`${paramName} must be a valid Ethereum address (0x + 40 hex chars), got ${address}`);
    }
    return Result.ok(null);
}

/**
 * Validate trading pair format (e.g., "AVAX/USDC").
 */
export function validatePairFormat(pair: string, paramName: string = 'pair'): Result<null> {
    if (typeof pair !== 'string') {
        return Result.fail(`${paramName} must be a string, got ${typeof pair}`);
    }
    if (!pair.trim()) {
        return Result.fail(`${paramName} cannot be empty`);
    }
    if (!PAIR_PATTERN.test(pair)) {
        return Result.fail(`${paramName} must be in format 'BASE/QUOTE' (e.g., 'AVAX/USDC'), got '${pair}'`);
    }
    return Result.ok(null);
}

/**
 * Validate order ID format (hex string or bytes).
 */
export function validateOrderIdFormat(
    orderId: string | Uint8Array,
    paramName: string = 'orderId'
): Result<null> {
    if (orderId instanceof Uint8Array) {
        if (orderId.length !== 32) {
            return Result.fail(`${paramName} bytes must be 32 bytes, got ${orderId.length}`);
        }
        return Result.ok(null);
    }

    if (typeof orderId !== 'string') {
        return Result.fail(`${paramName} must be a string or Uint8Array, got ${typeof orderId}`);
    }

    if (!orderId.trim()) {
        return Result.fail(`${paramName} cannot be empty`);
    }

    // If it starts with 0x, validate hex format
    if (orderId.startsWith('0x')) {
        if (!ORDER_ID_HEX_PATTERN.test(orderId)) {
            return Result.fail(`${paramName} hex string must be 0x + 64 hex chars, got '${orderId}'`);
        }
    }
    // Otherwise, it's a string ID (client-generated), just check non-empty
    
    return Result.ok(null);
}

/**
 * Validate token symbol format.
 */
export function validateTokenSymbol(token: string, paramName: string = 'token'): Result<null> {
    if (typeof token !== 'string') {
        return Result.fail(`${paramName} must be a string, got ${typeof token}`);
    }
    if (!token.trim()) {
        return Result.fail(`${paramName} cannot be empty`);
    }
    if (!TOKEN_SYMBOL_PATTERN.test(token)) {
        return Result.fail(`${paramName} must be 1-10 uppercase alphanumeric characters, got '${token}'`);
    }
    return Result.ok(null);
}

/**
 * Validate chain identifier (chain ID number or chain name string).
 */
export function validateChainIdentifier(
    identifier: number | string,
    paramName: string = 'chainIdentifier'
): Result<null> {
    if (typeof identifier === 'number') {
        if (!Number.isInteger(identifier) || identifier <= 0) {
            return Result.fail(`${paramName} must be a positive integer, got ${identifier}`);
        }
        return Result.ok(null);
    }

    if (typeof identifier === 'string') {
        if (!identifier.trim()) {
            return Result.fail(`${paramName} cannot be empty`);
        }
        return Result.ok(null);
    }

    return Result.fail(`${paramName} must be a number or string, got ${typeof identifier}`);
}

/**
 * Validate order parameters.
 */
export function validateOrderParams(
    pair: string,
    amount: number,
    price: number | null,
    orderType: string
): Result<null> {
    // Validate pair
    const pairResult = validatePairFormat(pair, 'pair');
    if (!pairResult.success) return pairResult;

    // Validate amount
    const amountResult = validatePositiveFloat(amount, 'amount');
    if (!amountResult.success) return amountResult;

    // Validate order type
    const validTypes = ['LIMIT', 'MARKET'];
    const upperType = orderType.toUpperCase();
    if (!validTypes.includes(upperType)) {
        return Result.fail(`orderType must be 'LIMIT' or 'MARKET', got '${orderType}'`);
    }

    // Validate price for LIMIT orders
    if (upperType === 'LIMIT') {
        if (price === null || price === undefined) {
            return Result.fail('price is required for LIMIT orders');
        }
        const priceResult = validatePositiveFloat(price, 'price');
        if (!priceResult.success) return priceResult;
    }

    return Result.ok(null);
}

/**
 * Validate transfer parameters.
 */
export function validateTransferParams(
    token: string,
    amount: number,
    toAddress: string
): Result<null> {
    // Validate token
    const tokenResult = validateTokenSymbol(token, 'token');
    if (!tokenResult.success) return tokenResult;

    // Validate amount
    const amountResult = validatePositiveFloat(amount, 'amount');
    if (!amountResult.success) return amountResult;

    // Validate address
    const addressResult = validateAddress(toAddress, 'toAddress');
    if (!addressResult.success) return addressResult;

    return Result.ok(null);
}

/**
 * Validate swap parameters.
 */
export function validateSwapParams(
    fromToken: string,
    toToken: string,
    amount: number
): Result<null> {
    // Validate fromToken
    const fromResult = validateTokenSymbol(fromToken, 'fromToken');
    if (!fromResult.success) return fromResult;

    // Validate toToken
    const toResult = validateTokenSymbol(toToken, 'toToken');
    if (!toResult.success) return toResult;

    // Tokens must be different
    if (fromToken.toUpperCase() === toToken.toUpperCase()) {
        return Result.fail('fromToken and toToken must be different');
    }

    // Validate amount
    const amountResult = validatePositiveFloat(amount, 'amount');
    if (!amountResult.success) return amountResult;

    return Result.ok(null);
}
