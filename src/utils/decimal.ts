import Big from 'big.js';

/**
 * Decimal-safe helpers for converting between human-readable amounts and
 * on-chain integer wei amounts, and for truncating display-precision.
 *
 * Background: encoding `2933.0 * 10**18` via float arithmetic produces
 * `2932999999999999737856`, which the trading contract rejects. All
 * write paths must route through {@link toWei} (or equivalent) so the
 * intended value reaches the contract exactly.
 *
 * Big.js operates on arbitrary-precision decimal strings; only the
 * final conversion to wei narrows to `bigint`.
 */

/**
 * Accepted scalar inputs for the helpers below. `number` is convenient
 * for human callers; `string`, `bigint`, and `Big` preserve precision
 * exactly and are the safer choice for amounts that may have many
 * fractional digits.
 */
export type DecimalInput = number | string | bigint | Big;

/**
 * Coerce a numeric value to Big preserving the user's intended decimal
 * representation. Floats route through `String(value)` (so `0.1` stays
 * `"0.1"` rather than picking up binary-noise tail digits).
 */
export function toDecimal(value: DecimalInput): Big {
    if (value instanceof Big) return value;
    if (typeof value === 'bigint') return new Big(value.toString());
    return new Big(String(value));
}

/**
 * Convert a human-readable amount to integer wei: floor(value * 10^decimals).
 *
 * Truncation toward zero (Big.roundDown) matches the Python reference's
 * `int(Decimal(str(value)) * Decimal(10)**decimals)` semantics. Inputs
 * whose precision exceeds `decimals` are truncated silently here; the
 * display-precision REJECT-with-tolerance gate (introduced separately
 * by the CLOB write paths) is responsible for refusing over-precise
 * order inputs before they reach this helper.
 */
export function toWei(value: DecimalInput, decimals: number): bigint {
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new Error(`toWei: decimals must be a non-negative integer, got ${decimals}`);
    }
    const scaled = toDecimal(value).times(new Big(10).pow(decimals));
    return BigInt(scaled.toFixed(0, Big.roundDown));
}

/**
 * Truncate `value` to `displayDecimals` fractional digits using ROUND_DOWN.
 *
 * Intended for callers that have already validated precision (so this
 * never silently rounds away meaningful significant digits). Use the
 * REJECT-with-tolerance precision gate in the write paths for inputs
 * that may exceed display precision.
 */
export function quantizeToDisplay(value: DecimalInput, displayDecimals: number): Big {
    if (!Number.isInteger(displayDecimals) || displayDecimals < 0) {
        throw new Error(
            `quantizeToDisplay: displayDecimals must be a non-negative integer, got ${displayDecimals}`
        );
    }
    return toDecimal(value).round(displayDecimals, Big.roundDown);
}

export { Big };
