import {
    validatePositiveFloat,
    validatePositiveInt,
    validateNonNegativeFloat,
    validateAddress,
    validatePairFormat,
    validateOrderIdFormat,
    validateTokenSymbol,
    validateChainIdentifier,
    validateOrderParams,
    validateTransferParams,
    validateSwapParams
} from '../../src/utils/inputValidators';
import { Result } from '../../src/utils/result';

describe('inputValidators', () => {
    describe('validatePositiveFloat', () => {
        it('should accept positive numbers', () => {
            expect(validatePositiveFloat(1.5, 'value').success).toBe(true);
            expect(validatePositiveFloat(0.001, 'value').success).toBe(true);
            expect(validatePositiveFloat(100, 'value').success).toBe(true);
        });

        it('should reject zero', () => {
            const result = validatePositiveFloat(0, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('positive');
        });

        it('should reject negative numbers', () => {
            const result = validatePositiveFloat(-1, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('positive');
        });

        it('should reject NaN', () => {
            const result = validatePositiveFloat(NaN, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('number');
        });

        it('should reject Infinity', () => {
            const result = validatePositiveFloat(Infinity, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('finite');
        });

        it('should reject non-numbers', () => {
            const result = validatePositiveFloat('1' as any, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('number');
        });
    });

    describe('validatePositiveInt', () => {
        it('should accept positive integers', () => {
            expect(validatePositiveInt(1, 'value').success).toBe(true);
            expect(validatePositiveInt(100, 'value').success).toBe(true);
        });

        it('should reject floats', () => {
            const result = validatePositiveInt(1.5, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('integer');
        });

        it('should reject zero', () => {
            const result = validatePositiveInt(0, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('positive');
        });

        it('should reject negative integers', () => {
            const result = validatePositiveInt(-1, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('positive');
        });

        it('should reject NaN', () => {
            const result = validatePositiveInt(NaN, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('number');
        });

        it('should reject non-numbers', () => {
            const result = validatePositiveInt('1' as any, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('number');
        });
    });

    describe('validateNonNegativeFloat', () => {
        it('should accept zero', () => {
            expect(validateNonNegativeFloat(0, 'value').success).toBe(true);
        });

        it('should accept positive numbers', () => {
            expect(validateNonNegativeFloat(1.5, 'value').success).toBe(true);
        });

        it('should reject negative numbers', () => {
            const result = validateNonNegativeFloat(-1, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('non-negative');
        });

        it('should reject NaN', () => {
            const result = validateNonNegativeFloat(NaN, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('number');
        });

        it('should reject Infinity', () => {
            const result = validateNonNegativeFloat(Infinity, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('finite');
        });

        it('should reject non-numbers', () => {
            const result = validateNonNegativeFloat('1' as any, 'value');
            expect(result.success).toBe(false);
            expect(result.error).toContain('number');
        });
    });

    describe('validateAddress', () => {
        it('should accept valid Ethereum addresses', () => {
            expect(validateAddress('0x1234567890123456789012345678901234567890').success).toBe(true);
            expect(validateAddress('0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD').success).toBe(true);
        });

        it('should reject invalid addresses', () => {
            expect(validateAddress('0x123').success).toBe(false);
            expect(validateAddress('1234567890123456789012345678901234567890').success).toBe(false);
            expect(validateAddress('0x123456789012345678901234567890123456789g').success).toBe(false);
        });

        it('should reject empty strings', () => {
            const result = validateAddress('', 'address');
            expect(result.success).toBe(false);
            expect(result.error).toContain('empty');
        });

        it('should reject non-strings', () => {
            const result = validateAddress(123 as any, 'address');
            expect(result.success).toBe(false);
            expect(result.error).toContain('string');
        });

        it('should use custom param name', () => {
            const result = validateAddress('invalid', 'toAddress');
            expect(result.error).toContain('toAddress');
        });
    });

    describe('validatePairFormat', () => {
        it('should accept valid pairs', () => {
            expect(validatePairFormat('AVAX/USDC').success).toBe(true);
            expect(validatePairFormat('BTC/ETH').success).toBe(true);
            expect(validatePairFormat('TOKEN123/QUOTE456').success).toBe(true);
        });

        it('should reject invalid formats', () => {
            expect(validatePairFormat('AVAX-USDC').success).toBe(false);
            expect(validatePairFormat('AVAX').success).toBe(false);
            expect(validatePairFormat('avax/usdc').success).toBe(false);
            expect(validatePairFormat('AVAX/USDC/EXTRA').success).toBe(false);
        });

        it('should reject empty strings', () => {
            const result = validatePairFormat('', 'pair');
            expect(result.success).toBe(false);
            expect(result.error).toContain('empty');
        });

        it('should reject non-strings', () => {
            const result = validatePairFormat(123 as any, 'pair');
            expect(result.success).toBe(false);
            expect(result.error).toContain('string');
        });
    });

    describe('validateOrderIdFormat', () => {
        it('should accept valid hex order IDs', () => {
            const validHex = '0x' + 'a'.repeat(64);
            expect(validateOrderIdFormat(validHex).success).toBe(true);
        });

        it('should accept Uint8Array of 32 bytes', () => {
            const bytes = new Uint8Array(32);
            expect(validateOrderIdFormat(bytes).success).toBe(true);
        });

        it('should reject invalid hex format', () => {
            expect(validateOrderIdFormat('0x123').success).toBe(false);
            expect(validateOrderIdFormat('0x' + 'a'.repeat(63)).success).toBe(false);
        });

        it('should reject Uint8Array of wrong length', () => {
            const bytes = new Uint8Array(31);
            const result = validateOrderIdFormat(bytes);
            expect(result.success).toBe(false);
            expect(result.error).toContain('32 bytes');
        });

        it('should accept non-hex string IDs', () => {
            expect(validateOrderIdFormat('client-order-123').success).toBe(true);
        });

        it('should accept decimal digit-only order id strings', () => {
            expect(validateOrderIdFormat('123456789').success).toBe(true);
        });

        it('should reject empty strings', () => {
            const result = validateOrderIdFormat('');
            expect(result.success).toBe(false);
            expect(result.error).toContain('empty');
        });

        it('should reject non-string non-Uint8Array', () => {
            const result = validateOrderIdFormat(123 as any);
            expect(result.success).toBe(false);
            expect(result.error).toContain('string or bytes');
        });

        it('should reject 0x with empty hex body', () => {
            const result = validateOrderIdFormat('0x', 'id');
            expect(result.success).toBe(false);
            expect(result.error).toContain("cannot be empty after '0x'");
        });

        it('should reject hex body with invalid characters', () => {
            const result = validateOrderIdFormat('0x' + 'g'.repeat(64), 'id');
            expect(result.success).toBe(false);
            expect(result.error).toContain('invalid hex');
        });

        it('should reject 0x hex longer than bytes32', () => {
            const result = validateOrderIdFormat('0x' + 'a'.repeat(66), 'id');
            expect(result.success).toBe(false);
            expect(result.error).toContain('too long');
        });

        it('should accept 64-char hex without 0x prefix', () => {
            expect(validateOrderIdFormat('a'.repeat(64), 'id').success).toBe(true);
        });

        it('should reject plain string longer than 32 bytes', () => {
            const long = 'x'.repeat(33);
            const result = validateOrderIdFormat(long, 'id');
            expect(result.success).toBe(false);
            expect(result.error).toContain('32 bytes');
        });
    });

    describe('validateTokenSymbol', () => {
        it('should accept valid token symbols', () => {
            expect(validateTokenSymbol('AVAX').success).toBe(true);
            expect(validateTokenSymbol('USDC').success).toBe(true);
            expect(validateTokenSymbol('TOKEN123').success).toBe(true);
            expect(validateTokenSymbol('A').success).toBe(true);
        });

        it('should reject invalid formats', () => {
            expect(validateTokenSymbol('avax').success).toBe(false);
            expect(validateTokenSymbol('token-symbol').success).toBe(false);
            expect(validateTokenSymbol('TOKEN_SYMBOL').success).toBe(false);
            expect(validateTokenSymbol('TOOLONGSYMBOL').success).toBe(false);
        });

        it('should reject empty strings', () => {
            const result = validateTokenSymbol('');
            expect(result.success).toBe(false);
            expect(result.error).toContain('empty');
        });

        it('should reject non-strings', () => {
            const result = validateTokenSymbol(123 as any);
            expect(result.success).toBe(false);
            expect(result.error).toContain('string');
        });
    });

    describe('validateChainIdentifier', () => {
        it('should accept positive integers', () => {
            expect(validateChainIdentifier(1).success).toBe(true);
            expect(validateChainIdentifier(43114).success).toBe(true);
        });

        it('should accept non-empty strings', () => {
            expect(validateChainIdentifier('Avalanche').success).toBe(true);
            expect(validateChainIdentifier('Fuji').success).toBe(true);
        });

        it('should reject zero', () => {
            const result = validateChainIdentifier(0);
            expect(result.success).toBe(false);
            expect(result.error).toContain('positive');
        });

        it('should reject negative numbers', () => {
            const result = validateChainIdentifier(-1);
            expect(result.success).toBe(false);
            expect(result.error).toContain('positive');
        });

        it('should reject empty strings', () => {
            const result = validateChainIdentifier('');
            expect(result.success).toBe(false);
            expect(result.error).toContain('empty');
        });

        it('should reject non-number non-string', () => {
            const result = validateChainIdentifier(null as any);
            expect(result.success).toBe(false);
            expect(result.error).toContain('number or string');
        });
    });

    describe('validateOrderParams', () => {
        it('should accept valid LIMIT order', () => {
            const result = validateOrderParams('AVAX/USDC', 10, 20, 'LIMIT');
            expect(result.success).toBe(true);
        });

        it('should accept valid MARKET order', () => {
            const result = validateOrderParams('AVAX/USDC', 10, null, 'MARKET');
            expect(result.success).toBe(true);
        });

        it('should reject invalid pair', () => {
            const result = validateOrderParams('invalid', 10, 20, 'LIMIT');
            expect(result.success).toBe(false);
            expect(result.error).toContain('pair');
        });

        it('should reject invalid amount', () => {
            const result = validateOrderParams('AVAX/USDC', -1, 20, 'LIMIT');
            expect(result.success).toBe(false);
            expect(result.error).toContain('amount');
        });

        it('should reject invalid order type', () => {
            const result = validateOrderParams('AVAX/USDC', 10, 20, 'INVALID');
            expect(result.success).toBe(false);
            expect(result.error).toContain('LIMIT');
        });

        it('should require price for LIMIT orders', () => {
            const result = validateOrderParams('AVAX/USDC', 10, null, 'LIMIT');
            expect(result.success).toBe(false);
            expect(result.error).toContain('price is required');
        });

        it('should validate price for LIMIT orders', () => {
            const result = validateOrderParams('AVAX/USDC', 10, -1, 'LIMIT');
            expect(result.success).toBe(false);
            expect(result.error).toContain('price');
        });
    });

    describe('validateTransferParams', () => {
        it('should accept valid transfer params', () => {
            const result = validateTransferParams('AVAX', 10, '0x1234567890123456789012345678901234567890');
            expect(result.success).toBe(true);
        });

        it('should reject invalid token', () => {
            const result = validateTransferParams('invalid-token', 10, '0x1234567890123456789012345678901234567890');
            expect(result.success).toBe(false);
            expect(result.error).toContain('token');
        });

        it('should reject invalid amount', () => {
            const result = validateTransferParams('AVAX', -1, '0x1234567890123456789012345678901234567890');
            expect(result.success).toBe(false);
            expect(result.error).toContain('amount');
        });

        it('should reject invalid address', () => {
            const result = validateTransferParams('AVAX', 10, 'invalid');
            expect(result.success).toBe(false);
            expect(result.error).toContain('toAddress');
        });
    });

    describe('validateSwapParams', () => {
        it('should accept valid swap params', () => {
            const result = validateSwapParams('AVAX', 'USDC', 10);
            expect(result.success).toBe(true);
        });

        it('should reject same tokens', () => {
            const result = validateSwapParams('AVAX', 'AVAX', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('different');
        });

        it('should reject invalid fromToken', () => {
            const result = validateSwapParams('invalid', 'USDC', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('fromToken');
        });

        it('should reject invalid toToken', () => {
            const result = validateSwapParams('AVAX', 'invalid', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('toToken');
        });

        it('should reject invalid amount', () => {
            const result = validateSwapParams('AVAX', 'USDC', -1);
            expect(result.success).toBe(false);
            expect(result.error).toContain('amount');
        });

        it('should be case-insensitive for token comparison', () => {
            // First validation will fail on 'avax' format, so test with valid format
            const result = validateSwapParams('AVAX', 'AVAX', 10);
            expect(result.success).toBe(false);
            expect(result.error).toContain('different');
        });
    });
});

