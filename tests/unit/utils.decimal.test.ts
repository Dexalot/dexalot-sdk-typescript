import Big from 'big.js';
import {
    toDecimal,
    toWei,
    fromWei,
    quantizeToDisplay,
    checkDisplayPrecision,
    checkTradeAmountBounds,
    DISPLAY_PRECISION_TOLERANCE,
} from '../../src/utils/decimal';

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

    describe('fromWei', () => {
        it('decodes integer wei from a bigint input exactly', () => {
            expect(fromWei(2933000000000000000000n, 18).toString()).toBe('2933');
            expect(fromWei(1500000000000000000n, 18).toString()).toBe('1.5');
        });

        it('accepts decimal-string wei (the non-bigint branch)', () => {
            expect(fromWei('1500000000000000000', 18).toString()).toBe('1.5');
            expect(fromWei('1234567', 6).toString()).toBe('1.234567');
        });

        it('accepts number wei for small enough values', () => {
            expect(fromWei(1500, 0).toString()).toBe('1500');
            expect(fromWei(2_933_000_000n, 6).toString()).toBe('2933');
        });

        it('preserves precision past the IEEE-754 limit (string round-trip)', () => {
            // 10^30 is well beyond what a JS number can hold exactly; the
            // Big-based path round-trips it through string form intact.
            expect(fromWei(10n ** 48n, 18).toFixed()).toBe('1000000000000000000000000000000');
        });

        it('handles displayDecimals = 0 (identity in human units)', () => {
            expect(fromWei(42n, 0).toString()).toBe('42');
        });

        it('throws on non-integer or negative decimals', () => {
            expect(() => fromWei(1n, 1.5)).toThrow(/non-negative integer/);
            expect(() => fromWei(1n, -1)).toThrow(/non-negative integer/);
            expect(() => fromWei(1n, NaN)).toThrow(/non-negative integer/);
        });

        it('is the inverse of toWei for representable values', () => {
            const amount = '12345.67';
            const wei = toWei(amount, 6);
            expect(fromWei(wei, 6).toString()).toBe(amount);
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

    describe('checkDisplayPrecision', () => {
        it('accepts values already at display precision', () => {
            const r = checkDisplayPrecision('0.1234', 4, 'amount');
            expect(r.success).toBe(true);
            expect(r.data!.toString()).toBe('0.1234');
        });

        it('rejects values with more precision than allowed', () => {
            const r = checkDisplayPrecision(0.123456789, 4, 'amount');
            expect(r.success).toBe(false);
            expect(r.error).toContain('amount');
            expect(r.error).toContain('more than 4 decimals');
        });

        it('accepts float-representation noise within tolerance', () => {
            // 0.1 + 0.2 produces 0.30000000000000004 due to binary float
            // representation; this residual (~1e-17) is well below the 1e-10
            // tolerance and should be snapped to 0.3 at 1 display decimal.
            const r = checkDisplayPrecision(0.1 + 0.2, 1, 'amount');
            expect(r.success).toBe(true);
            expect(r.data!.toString()).toBe('0.3');
        });

        it('zero is always accepted regardless of display decimals', () => {
            const r = checkDisplayPrecision(0, 8, 'amount');
            expect(r.success).toBe(true);
            expect(r.data!.eq(0)).toBe(true);
        });

        it('throws on invalid displayDecimals', () => {
            expect(() => checkDisplayPrecision(1, -1, 'amount')).toThrow(/non-negative integer/);
            expect(() => checkDisplayPrecision(1, 2.5, 'amount')).toThrow(/non-negative integer/);
        });

        it('exposes a stable tolerance constant', () => {
            expect(DISPLAY_PRECISION_TOLERANCE.toString()).toBe('1e-10');
        });
    });

    describe('checkTradeAmountBounds', () => {
        const pairName = 'AVAX/USDC';

        it('skips entirely when price is null (market order)', () => {
            const r = checkTradeAmountBounds(null, new Big('1'), 10, 0, pairName);
            expect(r.success).toBe(true);
        });

        it('accepts when notional is within bounds', () => {
            const price = new Big('10');
            const amount = new Big('2');
            // notional = 20; bounds = [5, 100]
            const r = checkTradeAmountBounds(price, amount, 5, 100, pairName);
            expect(r.success).toBe(true);
        });

        it('rejects when notional is below min_trade_amount', () => {
            const price = new Big('1');
            const amount = new Big('0.5');
            // notional = 0.5; min = 10
            const r = checkTradeAmountBounds(price, amount, 10, 1000, pairName);
            expect(r.success).toBe(false);
            expect(r.error).toContain('below min_trade_amount');
            expect(r.error).toContain('AVAX/USDC');
        });

        it('rejects when notional is above max_trade_amount', () => {
            const price = new Big('10');
            const amount = new Big('200');
            // notional = 2000; max = 1000
            const r = checkTradeAmountBounds(price, amount, 0, 1000, pairName);
            expect(r.success).toBe(false);
            expect(r.error).toContain('above max_trade_amount');
        });

        it('treats min=0 as "no bound"', () => {
            const r = checkTradeAmountBounds(new Big('0.001'), new Big('0.001'), 0, 0, pairName);
            expect(r.success).toBe(true);
        });

        it('treats max=0 as "no bound"', () => {
            // Huge notional but max=0 means uncapped.
            const r = checkTradeAmountBounds(new Big('1e18'), new Big('1e18'), 0, 0, pairName);
            expect(r.success).toBe(true);
        });
    });
});
