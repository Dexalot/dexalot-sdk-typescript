import { Utils } from '../../src/utils/index';
import { encodeBytes32String } from 'ethers';

describe('Utils', () => {
    describe('toBytes32', () => {
        it('should convert short string to bytes32', () => {
            const input = "AVAX/USDC";
            const result = Utils.toBytes32(input);
            expect(result).toBe(encodeBytes32String(input));
        });

        it('should throw error for strings longer than 31 characters', () => {
            const longString = "This string is definitely too long to be a bytes32";
            expect(() => Utils.toBytes32(longString)).toThrow('Failed to convert');
        });
    });

    describe('fromBytes32', () => {
        it('should convert bytes32 back to string', () => {
            const original = "AVAX/USDC";
            const bytes32 = encodeBytes32String(original);
            const result = Utils.fromBytes32(bytes32);
            expect(result).toBe(original);
        });
    });

    describe('unitConversion', () => {
        const decimals = 18;

        it('should convert Display to Base (toBase=true)', () => {
            const result = Utils.unitConversion('1.5', decimals, true);
            expect(result).toBe('1500000000000000000'); // 1.5 * 10^18
        });

        it('should convert Base to Display (toBase=false)', () => {
            const result = Utils.unitConversion('1500000000000000000', decimals, false);
            expect(result).toBe('1.5');
        });

        it('should handle number input for Display to Base', () => {
            const result = Utils.unitConversion(1.5, decimals, true);
            expect(result).toBe('1500000000000000000');
        });

        it('should handle number input for Base to Display', () => {
            // Though unlikely to pass a BigInt as number without precision loss if safe int,
            // passing small numbers to verify logic.
            const result = Utils.unitConversion(100, 2, false); // 1.00
            expect(result).toBe('1.0');
        });

        it('should use default toBase=true when omitted', () => {
             const result = Utils.unitConversion('1.5', decimals);
             expect(result).toBe('1500000000000000000');
        });
    });
});
