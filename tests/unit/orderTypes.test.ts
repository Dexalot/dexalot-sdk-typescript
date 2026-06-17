import {
    TimeInForce,
    SelfTradePrevention,
    SIDE_NAMES,
    ORDER_TYPE_NAMES,
    TIME_IN_FORCE_NAMES,
    STP_NAMES,
    ORDER_STATUS_NAMES,
    enumIntToName,
    parseSide,
    parseOrderType,
    parseTimeInForce,
    parseStp,
    validateOrderCombo,
} from '../../src/core/orderTypes';
import { OrderType } from '../../src/types';

describe('orderTypes', () => {
    describe('enum + map values', () => {
        it('time-in-force values match the contract', () => {
            expect(TimeInForce.GTC).toBe(0);
            expect(TimeInForce.FOK).toBe(1);
            expect(TimeInForce.IOC).toBe(2);
            expect(TimeInForce.PO).toBe(3);
        });

        it('stp values match the contract', () => {
            expect(SelfTradePrevention.CANCEL_TAKER).toBe(0);
            expect(SelfTradePrevention.CANCEL_MAKER).toBe(1);
            expect(SelfTradePrevention.CANCEL_BOTH).toBe(2);
            expect(SelfTradePrevention.CANCEL_NONE).toBe(3);
        });

        it('read map includes the full contract Type1 enum + status incl CANCEL_REJECT', () => {
            expect(ORDER_TYPE_NAMES[2]).toBe('STOP');
            expect(ORDER_TYPE_NAMES[3]).toBe('STOPLIMIT');
            expect(ORDER_STATUS_NAMES[0]).toBe('NEW');
            expect(ORDER_STATUS_NAMES[7]).toBe('CANCEL_REJECT');
            expect(SIDE_NAMES[1]).toBe('SELL');
            expect(TIME_IN_FORCE_NAMES[3]).toBe('PO');
            expect(STP_NAMES[2]).toBe('CANCEL_BOTH');
        });
    });

    describe('enumIntToName', () => {
        it('maps known values to labels', () => {
            expect(enumIntToName(1, ORDER_TYPE_NAMES)).toBe('LIMIT');
            expect(enumIntToName(2, ORDER_TYPE_NAMES)).toBe('STOP');
            expect(enumIntToName(2n, STP_NAMES)).toBe('CANCEL_BOTH');
        });

        it('maps unknown integers to an UNKNOWN sentinel', () => {
            expect(enumIntToName(7, ORDER_TYPE_NAMES)).toBe('UNKNOWN(7)');
            expect(enumIntToName(99n, TIME_IN_FORCE_NAMES)).toBe('UNKNOWN(99)');
        });

        it('passes non-integer values through unchanged', () => {
            expect(enumIntToName('LIMIT', ORDER_TYPE_NAMES)).toBe('LIMIT');
            expect(enumIntToName(undefined, ORDER_TYPE_NAMES)).toBeUndefined();
        });
    });

    describe('parsers', () => {
        it.each([
            ['BUY', 0],
            ['sell', 1],
            ['B', 0],
            ['S', 1],
            [1, 1],
        ])('parseSide(%s) -> %s', (input, expected) => {
            const r = parseSide(input);
            expect(r.success).toBe(true);
            expect(r.data).toBe(expected);
        });

        it.each([
            ['MARKET', 0],
            ['limit', 1],
            [1, 1],
        ])('parseOrderType(%s) -> %s', (input, expected) => {
            const r = parseOrderType(input);
            expect(r.success).toBe(true);
            expect(r.data).toBe(expected);
        });

        it.each([
            ['GTC', 0],
            ['fok', 1],
            ['IOC', 2],
            ['PO', 3],
            ['POST_ONLY', 3],
            ['FILL_OR_KILL', 1],
            ['IMMEDIATE_OR_CANCEL', 2],
            ['GOOD_TILL_CANCEL', 0],
            [3, 3],
        ])('parseTimeInForce(%s) -> %s', (input, expected) => {
            const r = parseTimeInForce(input);
            expect(r.success).toBe(true);
            expect(r.data).toBe(expected);
        });

        it.each([
            ['CANCEL_TAKER', 0],
            ['CANCEL_NEWEST', 0],
            ['CANCEL_OLDEST', 1],
            ['DO_NOT_CANCEL', 3],
            ['NONE', 3],
            // contract spellings
            ['CANCELTAKER', 0],
            ['CANCELMAKER', 1],
            ['CANCELBOTH', 2],
            [2, 2],
        ])('parseStp(%s) -> %s', (input, expected) => {
            const r = parseStp(input);
            expect(r.success).toBe(true);
            expect(r.data).toBe(expected);
        });

        it('rejects unknown names', () => {
            expect(parseTimeInForce('FAST').success).toBe(false);
            // STOP is a real Type1 member but not placeable -> write parser rejects it
            expect(parseOrderType('STOP').success).toBe(false);
            expect(parseSide('HOLD').success).toBe(false);
            expect(parseStp('NOPE').success).toBe(false);
        });

        it('rejects out-of-range integers', () => {
            expect(parseOrderType(2).success).toBe(false);
            expect(parseTimeInForce(9).success).toBe(false);
        });

        it('rejects wrong value types', () => {
            expect(parseSide({} as unknown).success).toBe(false);
            expect(parseTimeInForce(null).success).toBe(false);
        });
    });

    describe('validateOrderCombo', () => {
        it('requires a price for LIMIT', () => {
            expect(validateOrderCombo(OrderType.LIMIT, TimeInForce.GTC, true).success).toBe(true);
            expect(validateOrderCombo(OrderType.LIMIT, TimeInForce.GTC, false).success).toBe(false);
        });

        it('is permissive for MARKET (type2/price ignored on-chain)', () => {
            expect(validateOrderCombo(OrderType.MARKET, TimeInForce.GTC, false).success).toBe(true);
            expect(validateOrderCombo(OrderType.MARKET, TimeInForce.PO, false).success).toBe(true);
            expect(validateOrderCombo(OrderType.MARKET, TimeInForce.IOC, true).success).toBe(true);
        });
    });
});
