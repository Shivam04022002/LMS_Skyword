'use strict';

/**
 * Decimal-safe arithmetic for money, built on BigInt.
 *
 * Financial values are converted to integer minor units (paise) and every
 * operation stays in integer space, so no persisted amount is ever the result
 * of IEEE-754 floating point. `0.1 + 0.2` problems cannot occur here.
 *
 * No external decimal library is used — integer arithmetic is sufficient for
 * the operations this system performs.
 */

const MONEY_DECIMALS = 2;

/** Parses a decimal value into a scaled BigInt without going through Number. */
function toScaledBigInt(value, decimals) {
  if (value === null || value === undefined || value === '') {
    throw new TypeError('A numeric value is required');
  }

  const text = String(value).trim();

  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new TypeError(`"${value}" is not a plain decimal number`);
  }

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');

  // Truncate beyond the requested precision; pad when shorter.
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  const scaled = BigInt(whole + padded);

  return negative ? -scaled : scaled;
}

/** Renders a scaled BigInt back to a fixed-point decimal string. */
function fromScaledBigInt(scaled, decimals) {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Integer division rounding half away from zero — the documented rule. */
function divideRoundHalfUp(numerator, denominator) {
  if (denominator === 0n) {
    throw new RangeError('Division by zero');
  }

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

const toPaise = (value) => toScaledBigInt(value, MONEY_DECIMALS);
const fromPaise = (paise) => fromScaledBigInt(paise, MONEY_DECIMALS);

module.exports = {
  MONEY_DECIMALS,
  toScaledBigInt,
  fromScaledBigInt,
  divideRoundHalfUp,
  toPaise,
  fromPaise
};
