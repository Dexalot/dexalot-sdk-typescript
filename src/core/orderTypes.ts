/**
 * CLOB order-type domain model.
 *
 * Single source of truth for the on-chain order enums (`side`, `type1`,
 * `type2`, `stp`, order `status`) and the rules governing valid order-type
 * combinations. Both the write paths (placing orders) and the read paths
 * (formatting orders returned by the contract / REST API) route through this
 * module so the integer<->label mapping cannot drift between them.
 *
 * On-chain enum values (from the `TradePairs` contract, verified against
 * `ITradePairs.sol`) are authoritative:
 *
 * - `side`   -- 0 BUY, 1 SELL
 * - `type1`  -- 0 MARKET, 1 LIMIT, 2 STOP, 3 STOPLIMIT. STOP/STOPLIMIT are
 *   reserved/unused on-chain (no trigger-price field in `NewOrder`, never
 *   enabled per pair), so the write-side {@link OrderType} enum omits them and
 *   the SDK never originates a stop order — but reads still label them.
 * - `type2`  -- 0 GTC, 1 FOK, 2 IOC, 3 PO (time-in-force)
 * - `stp`    -- self-trade prevention (see {@link SelfTradePrevention})
 * - `status` -- 0 NEW .. 6 KILLED, 7 CANCEL_REJECT
 */

import { Result } from '../utils/result';
import { OrderType } from '../types';

/** Time-in-force / execution modifier (`type2` field). */
export enum TimeInForce {
    GTC = 0, // Good-Till-Cancelled
    FOK = 1, // Fill-Or-Kill
    IOC = 2, // Immediate-Or-Cancel
    PO = 3, // Post-Only (maker-only)
}

/**
 * Self-trade prevention mode (`stp` field).
 *
 * Integer values confirmed against the contract `STP` enum
 * (`CANCELTAKER, CANCELMAKER, CANCELBOTH, NONE`). Canonical names use readable
 * underscored spellings; the bare contract spellings are accepted as aliases.
 */
export enum SelfTradePrevention {
    CANCEL_TAKER = 0, // cancel the incoming (taker) order
    CANCEL_MAKER = 1, // cancel the resting (maker) order
    CANCEL_BOTH = 2,
    CANCEL_NONE = 3, // NONE on-chain: do not cancel; allow the self-trade
}

// --- int -> canonical label maps (read paths) ------------------------------

export const SIDE_NAMES: Record<number, string> = { 0: 'BUY', 1: 'SELL' };

// Read-side type1 labels mirror the full contract Type1 enum, including the
// reserved STOP/STOPLIMIT members. The SDK never *places* those (the write-side
// OrderType enum omits them), but a read should faithfully reflect any value
// the contract could report rather than mislabel it as UNKNOWN.
export const ORDER_TYPE_NAMES: Record<number, string> = {
    0: 'MARKET',
    1: 'LIMIT',
    2: 'STOP',
    3: 'STOPLIMIT',
};

export const TIME_IN_FORCE_NAMES: Record<number, string> = {
    0: 'GTC',
    1: 'FOK',
    2: 'IOC',
    3: 'PO',
};

export const STP_NAMES: Record<number, string> = {
    0: 'CANCEL_TAKER',
    1: 'CANCEL_MAKER',
    2: 'CANCEL_BOTH',
    3: 'CANCEL_NONE',
};

export const ORDER_STATUS_NAMES: Record<number, string> = {
    0: 'NEW',
    1: 'REJECTED',
    2: 'PARTIAL',
    3: 'FILLED',
    4: 'CANCELED',
    5: 'EXPIRED',
    6: 'KILLED',
    7: 'CANCEL_REJECT',
};

// --- name -> int canonical maps + aliases (write paths) --------------------

const SIDE_CANON: Record<string, number> = { BUY: 0, SELL: 1 };
// Write-side accepts only the placeable order types (no STOP/STOPLIMIT).
const ORDER_TYPE_CANON: Record<string, number> = { MARKET: 0, LIMIT: 1 };
const TIF_CANON: Record<string, number> = { GTC: 0, FOK: 1, IOC: 2, PO: 3 };
const STP_CANON: Record<string, number> = {
    CANCEL_TAKER: 0,
    CANCEL_MAKER: 1,
    CANCEL_BOTH: 2,
    CANCEL_NONE: 3,
};

const SIDE_ALIASES: Record<string, number> = { B: 0, S: 1 };
const ORDER_TYPE_ALIASES: Record<string, number> = {};
const TIF_ALIASES: Record<string, number> = {
    GOOD_TILL_CANCEL: 0,
    GOOD_TILL_CANCELLED: 0,
    GOOD_TILL_CANCELED: 0,
    FILL_OR_KILL: 1,
    IMMEDIATE_OR_CANCEL: 2,
    POST_ONLY: 3,
    POSTONLY: 3,
};
const STP_ALIASES: Record<string, number> = {
    // Contract spellings (ITradePairs.sol enum STP): no underscores, bare NONE.
    CANCELTAKER: 0,
    CANCELMAKER: 1,
    CANCELBOTH: 2,
    // Readable aliases.
    CANCEL_NEWEST: 0,
    CANCEL_OLDEST: 1,
    DO_NOT_CANCEL: 3,
    NONE: 3,
};

/**
 * Normalize an enum integer from a contract/API read into a string label.
 *
 * Integers present in `names` map to their canonical label. Integers absent
 * from `names` map to an explicit `"UNKNOWN(<n>)"` sentinel rather than a
 * fabricated label, so an unexpected on-chain value is visible (and signals the
 * SDK needs updating) instead of being silently mislabelled. Non-integer values
 * (e.g. labels already normalized upstream) pass through unchanged.
 */
export function enumIntToName(value: unknown, names: Record<number, string>): unknown {
    if (typeof value === 'bigint') {
        const n = Number(value);
        return names[n] ?? `UNKNOWN(${n})`;
    }
    if (typeof value === 'number') {
        return names[value] ?? `UNKNOWN(${value})`;
    }
    return value;
}

function parseEnumValue(
    value: unknown,
    canonical: Record<string, number>,
    aliases: Record<string, number>,
    field: string
): Result<number> {
    if (typeof value === 'number') {
        if (Object.values(canonical).includes(value)) {
            return Result.ok(value);
        }
        const valid = Object.values(canonical).join(', ');
        return Result.fail(`Invalid ${field} ${value}. Must be one of: ${valid}.`);
    }
    if (typeof value === 'string') {
        const key = value.trim().toUpperCase();
        if (key in canonical) {
            return Result.ok(canonical[key]);
        }
        if (key in aliases) {
            return Result.ok(aliases[key]);
        }
        const valid = Object.keys(canonical).join(', ');
        return Result.fail(`Invalid ${field} '${value}'. Must be one of: ${valid}.`);
    }
    return Result.fail(`Invalid ${field}: expected name or number, got ${typeof value}.`);
}

/** Resolve a side (`"BUY"`/`"SELL"`, alias, or int) to its integer value. */
export function parseSide(value: unknown): Result<number> {
    return parseEnumValue(value, SIDE_CANON, SIDE_ALIASES, 'side');
}

/** Resolve an order type (`"MARKET"`/`"LIMIT"`, or int) to its integer value. */
export function parseOrderType(value: unknown): Result<number> {
    return parseEnumValue(value, ORDER_TYPE_CANON, ORDER_TYPE_ALIASES, 'order type');
}

/** Resolve a time-in-force (`"GTC"`/`"FOK"`/`"IOC"`/`"PO"`, alias, or int) to int. */
export function parseTimeInForce(value: unknown): Result<number> {
    return parseEnumValue(value, TIF_CANON, TIF_ALIASES, 'timeInForce');
}

/** Resolve a self-trade-prevention mode (name, alias, or int) to its int value. */
export function parseStp(value: unknown): Result<number> {
    return parseEnumValue(value, STP_CANON, STP_ALIASES, 'stp');
}

/**
 * Validate a (`type1`, `type2`, price-presence) combination client-side.
 *
 * Only the one constraint the contract itself relies on is enforced here:
 * a LIMIT order requires a price. Everything else is left to the contract,
 * matching its actual behavior (verified against `TradePairs.sol`): MARKET
 * orders ignore `type2` and any supplied price (no revert), and per-pair
 * enabled order types, Post-Only and self-trade rules are enforced on-chain
 * (`T-IVOT-01`, `T-POOA-01`, `T-T2PO-01`, `T-FOKF-01`, `T-STPR-01`).
 */
export function validateOrderCombo(
    type1: number,
    _type2: number,
    hasPrice: boolean
): Result<null> {
    if (type1 === OrderType.LIMIT && !hasPrice) {
        return Result.fail('LIMIT orders require a price.');
    }
    return Result.ok(null);
}
