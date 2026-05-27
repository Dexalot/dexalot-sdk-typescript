import Big from 'big.js';
import { Result } from './result.js';

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
 * Convert an integer wei value to a human-readable `Big` via
 * precision-safe decimal division. Inverse of {@link toWei}.
 *
 * Used by the order-format path so the wei → display conversion is
 * exact through the entire arithmetic chain; callers that need a
 * `number` (e.g. for the public `Order` shape) take `.toNumber()` at
 * the boundary, accepting the standard IEEE-754 rounding only at the
 * final step rather than at every intermediate operation.
 */
export function fromWei(wei: bigint | string | number, decimals: number): Big {
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new Error(`fromWei: decimals must be a non-negative integer, got ${decimals}`);
    }
    const weiStr = typeof wei === 'bigint' ? wei.toString() : String(wei);
    return new Big(weiStr).div(new Big(10).pow(decimals));
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

/**
 * Tolerance band that absorbs binary-float-representation noise when
 * validating display-precision. Float arithmetic like `0.1 + 0.2` produces
 * residuals on the order of `1e-17`; a user typing genuinely extra digits
 * produces residuals `>= 1e-6`. `1e-10` sits comfortably in the gap.
 */
export const DISPLAY_PRECISION_TOLERANCE = new Big('1e-10');

/**
 * Validate that `value` fits in `displayDecimals` fractional digits.
 *
 * Returns `Result.ok(snapped)` when the input is at display precision —
 * or differs from a representable value only by float noise (within
 * {@link DISPLAY_PRECISION_TOLERANCE}). Returns `Result.fail` when the
 * input has genuinely more decimals than the pair allows; callers must
 * round explicitly rather than have the SDK silently slip the order.
 *
 * Silent rounding would be dangerous in a trading SDK — a stop-loss
 * at `99.99` quietly becoming `99.9` is silent slippage.
 */
export function checkDisplayPrecision(
    value: DecimalInput,
    displayDecimals: number,
    paramName: string
): Result<Big> {
    if (!Number.isInteger(displayDecimals) || displayDecimals < 0) {
        throw new Error(
            `checkDisplayPrecision: displayDecimals must be a non-negative integer, got ${displayDecimals}`
        );
    }
    const d = toDecimal(value);
    if (d.eq(0)) return Result.ok(d);
    const nearest = d.round(displayDecimals, Big.roundHalfEven);
    if (d.minus(nearest).abs().gt(DISPLAY_PRECISION_TOLERANCE)) {
        return Result.fail(
            `Invalid ${paramName}: ${String(value)} has more than ${displayDecimals} ` +
                `decimals; pair allows ${displayDecimals}. Round before passing.`
        );
    }
    return Result.ok(nearest);
}

/**
 * Enforce a pair's min/max trade-amount bounds, computed against the
 * quote-token notional `price * amount`. A bound of `0` is treated as
 * "no bound" (some pairs legitimately omit a cap). When `price` is
 * `null` the bounds check is skipped — market orders have no
 * client-side notional to check.
 */
export function checkTradeAmountBounds(
    price: Big | null,
    amount: Big,
    minTradeAmount: DecimalInput,
    maxTradeAmount: DecimalInput,
    pairName: string
): Result<null> {
    if (price === null) return Result.ok(null);
    const notional = price.times(amount);
    const minAmt = toDecimal(minTradeAmount);
    const maxAmt = toDecimal(maxTradeAmount);
    if (minAmt.gt(0) && notional.lt(minAmt)) {
        return Result.fail(
            `Trade notional ${notional.toString()} below min_trade_amount ` +
                `${minAmt.toString()} (quote-token) for pair ${pairName}.`
        );
    }
    if (maxAmt.gt(0) && notional.gt(maxAmt)) {
        return Result.fail(
            `Trade notional ${notional.toString()} above max_trade_amount ` +
                `${maxAmt.toString()} (quote-token) for pair ${pairName}.`
        );
    }
    return Result.ok(null);
}

export { Big };
