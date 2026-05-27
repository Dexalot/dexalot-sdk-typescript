import Big from 'big.js';
import { toDecimal, toWei, quantizeToDisplay } from '../../src/utils/decimal';

describe('decimal utilities', () => {
    describe('toDecimal', () => {
        it('returns Big instances as-is (no defensive copy)', () => {
            const b = new Big('2933.5');
            expect(toDecimal(b)).toBe(b);
        });

        it('coerces numbers through their toString representation', () => {
            expect(toDecimal(0.1).toString()).toBe('0.1');
            expect(toDecimal(2933).toString()).toBe('2933');
            expect(toDecimal(0).toString()).toBe('0');
        });

        it('coerces numeric strings exactly', () => {
            expect(toDecimal('2933.5').toString()).toBe('2933.5');
            expect(toDecimal('0.000000000000000001').toString()).toBe('1e-18');
        });

        it('coerces bigints exactly', () => {
            expect(toDecimal(2933n).toString()).toBe('2933');
            // Big.js switches to scientific notation past 21 digits in toString;
            // toFixed() forces the plain-decimal form.
            expect(toDecimal(10n ** 30n).toFixed()).toBe('1000000000000000000000000000000');
        });

        it('coerces negative inputs without losing the sign', () => {
            expect(toDecimal(-1.5).toString()).toBe('-1.5');
            expect(toDecimal('-2933').toString()).toBe('-2933');
        });
    });

    describe('toWei', () => {
        it('encodes 2933.0 at 18 decimals exactly (float-drift regression)', () => {
            // Naive `BigInt(Math.floor(2933.0 * 10**18))` yields
            // 2932999999999999737856 — which the trading contract rejects.
            expect(toWei(2933.0, 18)).toBe(2933000000000000000000n);
        });

        it('accepts integers, floats, strings, bigints, and Big', () => {
            expect(toWei(1, 18)).toBe(10n ** 18n);
            expect(toWei(1.5, 18)).toBe(1500000000000000000n);
            expect(toWei('1.5', 18)).toBe(1500000000000000000n);
            expect(toWei(1n, 18)).toBe(10n ** 18n);
            expect(toWei(new Big('1.5'), 18)).toBe(1500000000000000000n);
        });

        it('works at common token decimal scales', () => {
            expect(toWei(1.234567, 6)).toBe(1234567n);
            expect(toWei(0.5, 8)).toBe(50000000n);
            expect(toWei('1000', 0)).toBe(1000n);
        });

        it('truncates excess precision toward zero (matches Python int(Decimal))', () => {
            // 0.123456789 at 4 decimals = 1234.56789 -> floor -> 1234
            expect(toWei(0.123456789, 4)).toBe(1234n);
            expect(toWei('-0.123456789', 4)).toBe(-1234n);
        });

        it('handles zero and very small positives without underflow', () => {
            expect(toWei(0, 18)).toBe(0n);
            expect(toWei('0.000000000000000001', 18)).toBe(1n);
        });

        it('handles very large inputs (10^30 wei)', () => {
            expect(toWei('1000000000000', 18)).toBe(10n ** 30n);
        });

        it('throws on non-integer or negative decimals', () => {
            expect(() => toWei(1, 1.5)).toThrow(/non-negative integer/);
            expect(() => toWei(1, -1)).toThrow(/non-negative integer/);
            expect(() => toWei(1, NaN)).toThrow(/non-negative integer/);
        });
    });

    describe('quantizeToDisplay', () => {
        it('truncates to N fractional digits (ROUND_DOWN)', () => {
            expect(quantizeToDisplay(0.123456789, 4).toString()).toBe('0.1234');
            expect(quantizeToDisplay('99.99', 1).toString()).toBe('99.9');
            expect(quantizeToDisplay(1.999999, 2).toString()).toBe('1.99');
        });

        it('leaves values shorter than the requested precision unchanged', () => {
            expect(quantizeToDisplay(0.5, 4).toString()).toBe('0.5');
            expect(quantizeToDisplay(2933, 4).toString()).toBe('2933');
        });

        it('truncates negative values toward zero (ROUND_DOWN, not floor)', () => {
            // Big.roundDown == truncate toward zero (matches Python Decimal ROUND_DOWN)
            expect(quantizeToDisplay(-0.123456, 4).toString()).toBe('-0.1234');
        });

        it('accepts the same input types as toWei', () => {
            expect(quantizeToDisplay('0.123456', 2).toString()).toBe('0.12');
            expect(quantizeToDisplay(new Big('0.123456'), 2).toString()).toBe('0.12');
            expect(quantizeToDisplay(123n, 4).toString()).toBe('123');
        });

        it('handles displayDecimals=0', () => {
            expect(quantizeToDisplay(2933.7, 0).toString()).toBe('2933');
        });

        it('throws on non-integer or negative displayDecimals', () => {
            expect(() => quantizeToDisplay(1, -1)).toThrow(/non-negative integer/);
            expect(() => quantizeToDisplay(1, 2.5)).toThrow(/non-negative integer/);
        });
    });
});
