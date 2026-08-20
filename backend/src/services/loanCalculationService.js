'use strict';

const ApiError = require('../utils/ApiError');
const { toPaise, fromPaise, toScaledBigInt, divideRoundHalfUp } = require('../utils/money');
const {
  chargeableDayOffsets,
  chargeableOffsetsForCount,
  addDays,
  addMonths,
  differenceInDays
} = require('../utils/dates');
const {
  PERIODS_PER_YEAR,
  ROI_DECIMALS,
  LOAN_TYPES,
  INTEREST_METHODS,
  WEEKLY_OFF,
  ROI_BASIS,
  DEFAULT_ROI_BASIS,
  MONTHS_PER_YEAR,
  TENURE_UNITS,
  DEFAULT_TENURE_UNIT,
  isWeeklyOffAllowed,
  isTenureUnitAllowed,
  usesCollectionCount,
  collectionUnitLabel,
  COLLECTION_STEP_DAYS
} = require('../config/loans');

/**
 * The single place loan money is calculated. Nothing financial is computed in a
 * controller, a route or a React component.
 *
 * ── THE CONTRACTUAL TERM ──────────────────────────────────────────────────────
 * `tenureUnit` says what `tenure` counts:
 *
 *   PERIODS — periods of the loan type (the original meaning, still the default)
 *   MONTHS  — calendar months of contractual term, whatever the collection
 *             frequency. A DAILY loan of 6 MONTHS starting 2026-08-20 runs to
 *             2026-08-20 + 6 months = 2027-02-20, and collects daily inside it.
 *
 * The end date comes from the existing `addMonths` helper, so it keeps the same
 * day of the month and is never approximated as a number of days.
 *
 * Interest follows the CONTRACT, not the instalment count: a six-month loan
 * charges six months of interest whether it collects on 184 days or, with
 * Sundays excluded, on 158. Skipping a collection day changes how the total is
 * split, never how much it is, and never the end date.
 *
 * ── COLLECTION COUNT ──────────────────────────────────────────────────────────
 * A month-based loan that collects in days states `collectionCount`: how many
 * instalments collect the repayment — days for DAILY, weeks for WEEKLY,
 * fortnights for BI_WEEKLY. It is a COUNT of collections, never a span of
 * calendar days:
 *
 *   DAILY     collections land on consecutive chargeable days; asking for 150
 *             with Sundays off gives 150 non-Sunday dates, reaching further
 *             into the window rather than dropping to 150 minus the Sundays.
 *   WEEKLY    one collection every 7 days.
 *   BI_WEEKLY one collection every 14 days.
 *
 * The run must finish on or before the contractual end date; a count that
 * cannot fit is refused rather than extending the contract. The last collection
 * may fall earlier than the end date, which is normal and does not shorten the
 * agreement. A MONTHLY loan has one collection per contractual month, so it has
 * no such number.
 *
 * ── CHARGEABLE PERIODS ────────────────────────────────────────────────────────
 * With a PERIODS tenure a DAILY loan's `tenure` counts CALENDAR days; the
 * instalments fall on the chargeable days inside that same window:
 *
 *   weeklyOff NONE   -> every day is chargeable          (30 days -> 30 EMIs)
 *   weeklyOff SUNDAY -> Sundays are dropped, not pushed  (30 days -> 26 EMIs)
 *
 * The window is never extended to recover a skipped Sunday, so the loan still
 * ends on the agreed date. Interest is charged on chargeable periods only —
 * "chargeable" means exactly that, and a borrower is not charged for a day the
 * lender does not collect on. WEEKLY and MONTHLY loans have no weekly off, so
 * their chargeable period count is the tenure and nothing about them changes.
 *
 * ── THE ENTERED RATE ──────────────────────────────────────────────────────────
 * The operator enters a MONTHLY percentage: 1.50 means 1.50% per month. Loans
 * created before that rule carry `roiBasis: ANNUAL` and keep their original
 * meaning forever, so nothing already priced can move.
 *
 * There is exactly ONE conversion, and everything downstream is unchanged:
 *
 *   annualEquivalent = monthlyRoi x 12          (MONTHLY basis)
 *   annualEquivalent = roi                      (ANNUAL basis, legacy loans)
 *   periodRate       = annualEquivalent / (100 x periodsPerYear)
 *
 * Routing the monthly rate through its annual equivalent reuses the existing
 * periodsPerYear convention instead of inventing a second one, so a daily loan
 * still charges 1/365 of a year and a weekly loan 1/52 — no "30-day month" or
 * "4-week month" constant is introduced anywhere. For a MONTHLY loan the two
 * twelves cancel exactly in integer arithmetic, giving periodRate = roi / 100:
 * the entered monthly rate is used directly, never divided by 12.
 *
 * ── FLAT ──────────────────────────────────────────────────────────────────────
 *   interest       = loanAmount x (annualEquivalent / 100) x (chargeablePeriods / periodsPerYear)
 *   totalRepayment = loanAmount + interest
 *   emiAmount      = totalRepayment / emiCount
 *
 *   periodsPerYear: DAILY 365, WEEKLY 52, MONTHLY 12
 *
 *   10,000 at 1% per month over 10 MONTHLY periods:
 *     10,000 x (12/100) x (10/12) = 1,000 interest, 11,000 repayment.
 *
 * ── REDUCING ──────────────────────────────────────────────────────────────────
 * Level instalments against a falling balance — the standard reducing-balance
 * EMI. The periodic rate is i = annualEquivalent / (100 x periodsPerYear) —
 * for a monthly loan simply the entered monthly rate / 100 — and
 *
 *   EMI = P x i x (1 + i)^n / ((1 + i)^n - 1)
 *
 * is evaluated as EXACT integer arithmetic. With i = r/d the formula becomes
 * P x r x (d + r)^n / (d x ((d + r)^n - d^n)), so both powers are plain BigInt
 * exponentiations and only the final division rounds. No floating point, no
 * iterative approximation.
 *
 * Each instalment then charges interest on the balance still outstanding, so
 * interest falls and principal rises across the schedule. The final instalment
 * repays whatever principal remains, which is what makes SUM(principal) equal
 * the loan amount to the paise.
 *
 * ── PRECISION AND ROUNDING ────────────────────────────────────────────────────
 * All arithmetic runs in integer paise via BigInt; no step touches floating
 * point. Rounding is half away from zero, to 2 decimal places.
 *
 * Because emiAmount is rounded, emiAmount x emiCount can differ from
 * totalRepayment by a few paise. That residue is never dropped: it is reported
 * as `roundingRemainder` and folded into `lastEmiAmount`, so the instalments
 * always sum exactly to totalRepayment. Phase 6 applies it to the final
 * instalment when it builds the schedule.
 */

const HUNDRED = 100n;

function roiScale() {
  return 10n ** BigInt(ROI_DECIMALS);
}

function periodsPerYearFor(loanType) {
  const periodsPerYear = PERIODS_PER_YEAR[loanType];
  if (!periodsPerYear) {
    throw new TypeError(`Unknown loan type "${loanType}"`);
  }
  return periodsPerYear;
}

/**
 * The entered rate as its ANNUAL equivalent, scaled by 10^ROI_DECIMALS.
 *
 * This is the only place the monthly-versus-annual meaning is resolved. It
 * multiplies rather than divides, so no precision is lost: for a monthly loan
 * the x12 here and the /12 in periodsPerYear cancel exactly.
 */
function annualRoiScaled(roi, roiBasis = DEFAULT_ROI_BASIS) {
  const scaled = toScaledBigInt(roi, ROI_DECIMALS);
  return roiBasis === ROI_BASIS.ANNUAL ? scaled : scaled * BigInt(MONTHS_PER_YEAR);
}

/**
 * The contractual term expressed in MONTHS, as an exact fraction.
 *
 * A MONTHS tenure is already the answer. A PERIODS tenure is converted with the
 * existing periodsPerYear convention — periods x 12 / periodsPerYear — which is
 * what makes this a strict generalisation: every loan priced before this change
 * produces byte-identical figures, because the twelves cancel exactly inside
 * the single final division.
 */
function termMonths({ loanType, periods, tenureUnit = DEFAULT_TENURE_UNIT }) {
  if (tenureUnit === TENURE_UNITS.MONTHS) {
    return { numerator: BigInt(periods), denominator: 1n };
  }
  return { numerator: BigInt(periods) * BigInt(MONTHS_PER_YEAR), denominator: BigInt(periodsPerYearFor(loanType)) };
}

/** The periodic interest rate as an exact fraction r/d. */
function periodicRate(roi, loanType, roiBasis = DEFAULT_ROI_BASIS) {
  return {
    numerator: annualRoiScaled(roi, roiBasis),
    denominator: HUNDRED * roiScale() * BigInt(periodsPerYearFor(loanType))
  };
}

/**
 * How many periods a loan actually charges, and — for daily loans — which day
 * offsets those are. One resolver, used by the preview, by loan creation and by
 * schedule generation, so the three can never disagree.
 */
function resolvePeriods({
  loanType,
  tenure,
  startDate,
  weeklyOff = WEEKLY_OFF.NONE,
  tenureUnit = DEFAULT_TENURE_UNIT,
  collectionCount = null
}) {
  const periods = Number(tenure);
  if (!Number.isInteger(periods) || periods < 1) {
    throw ApiError.badRequest('Tenure must be a whole number of at least 1');
  }

  if (!isWeeklyOffAllowed(loanType, weeklyOff)) {
    throw ApiError.badRequest(`A weekly off can only be set on a ${LOAN_TYPES.DAILY} loan`);
  }

  if (!isTenureUnitAllowed(loanType, tenureUnit)) {
    throw ApiError.badRequest(`This loan type cannot be written as a tenure in months`);
  }

  const requested =
    collectionCount === null || collectionCount === undefined || collectionCount === '' ? null : Number(collectionCount);

  if (requested !== null) {
    if (!Number.isInteger(requested) || requested < 1) {
      throw ApiError.badRequest('The number of collections must be a whole number of at least 1');
    }
    if (!usesCollectionCount(loanType, tenureUnit)) {
      throw ApiError.badRequest(
        'A collection count applies only to a loan that collects in days and whose tenure is written in months'
      );
    }
  }

  const inMonths = tenureUnit === TENURE_UNITS.MONTHS;
  const term = termMonths({ loanType, periods, tenureUnit });
  const stepDays = COLLECTION_STEP_DAYS[loanType] ?? null;

  // A MONTHLY loan steps in calendar months: one collection per contractual
  // month, and no separate collection count.
  if (stepDays === null) {
    const emiCount = periods;
    return {
      calendarDays: null,
      chargeableDays: null,
      collectionCount: null,
      emiCount,
      offsets: null,
      term,
      endDate: startDate ? addMonths(startDate, emiCount) : null,
      tenureUnit
    };
  }

  const skipSundays = weeklyOff === WEEKLY_OFF.SUNDAY;

  if ((skipSundays || inMonths) && !startDate) {
    // The contractual window, and which days inside it are Sundays, both depend
    // on where the term starts; neither can be guessed without it.
    throw ApiError.badRequest(
      inMonths
        ? 'A start date is required to work out the contractual period of a loan with a tenure in months'
        : 'A start date is required to work out the chargeable days of a daily loan with a weekly off'
    );
  }

  const anchor = startDate ?? '2000-01-01';

  // A months tenure ends on the same day of the month, whatever its length; a
  // periods tenure is a count of this loan type's own periods.
  const endDate = inMonths ? addMonths(anchor, periods) : addDays(anchor, periods * stepDays);
  const calendarDays = inMonths ? differenceInDays(anchor, endDate) : periods * stepDays;

  if (requested !== null) {
    /*
     * Daily collections may skip an excluded weekday, so how many fit depends on
     * the calendar and is answered by walking it. Weekly and bi-weekly ones keep
     * a fixed cadence, so their offsets are multiples of it and the capacity is
     * a plain integer division — no floating point is involved either way.
     */
    let offsets = null;

    if (stepDays === 1) {
      offsets = chargeableOffsetsForCount(anchor, requested, { skipSundays, maxOffset: calendarDays });
    } else if (requested * stepDays <= calendarDays) {
      offsets = Array.from({ length: requested }, (_, index) => (index + 1) * stepDays);
    }

    if (!offsets) {
      const available =
        stepDays === 1
          ? chargeableDayOffsets(anchor, calendarDays, { skipSundays }).length
          : (calendarDays - (calendarDays % stepDays)) / stepDays;

      throw ApiError.badRequest(
        `${requested} ${collectionUnitLabel(loanType)} do not fit between ${anchor} and the contractual end date ${endDate}` +
          `${skipSundays ? ' with Sundays excluded' : ''} — at most ${available} are available`
      );
    }

    return {
      calendarDays,
      chargeableDays: offsets.length,
      collectionCount: offsets.length,
      emiCount: offsets.length,
      offsets,
      term,
      endDate: startDate ? endDate : null,
      tenureUnit
    };
  }

  // No stated count. A daily loan collects on every chargeable day of its
  // window; a weekly or bi-weekly one collects once per period of its tenure.
  if (stepDays === 1) {
    const offsets = chargeableDayOffsets(anchor, calendarDays, { skipSundays });

    if (offsets.length === 0) {
      throw ApiError.badRequest('This term contains no chargeable days');
    }

    return {
      calendarDays,
      chargeableDays: offsets.length,
      collectionCount: null,
      emiCount: offsets.length,
      offsets,
      term,
      endDate: startDate ? endDate : null,
      tenureUnit
    };
  }

  if (inMonths) {
    // A months tenure says nothing about how many weekly collections there are.
    throw ApiError.badRequest(
      `A ${loanType} loan with a tenure in months must state how many ${collectionUnitLabel(loanType)} collect it`
    );
  }

  return {
    calendarDays: null,
    chargeableDays: null,
    collectionCount: null,
    emiCount: periods,
    offsets: null,
    term,
    endDate: startDate ? endDate : null,
    tenureUnit
  };
}

/**
 * Flat interest over the contractual term, as a fixed-point string.
 *
 *   interest = amount x (annualEquivalent / 100) x (termMonths / 12)
 *
 * kept as one integer division so no intermediate rounding is introduced.
 * 100,000 at 5% per month for 6 months gives exactly 30,000.
 */
function flatInterest({ loanAmount, roi, term, roiBasis = DEFAULT_ROI_BASIS }) {
  const amountPaise = toPaise(loanAmount);
  const roiScaled = annualRoiScaled(roi, roiBasis);

  const numerator = amountPaise * roiScaled * term.numerator;
  const denominator = HUNDRED * roiScale() * BigInt(MONTHS_PER_YEAR) * term.denominator;

  return fromPaise(divideRoundHalfUp(numerator, denominator));
}

/**
 * Interest over the whole tenure (FLAT).
 * Kept on the original signature — `tenure` here is the chargeable period count.
 */
function calculateInterest({ loanAmount, roi, tenure, loanType, roiBasis = DEFAULT_ROI_BASIS, tenureUnit = DEFAULT_TENURE_UNIT }) {
  return flatInterest({
    loanAmount,
    roi,
    term: termMonths({ loanType, periods: Number(tenure), tenureUnit }),
    roiBasis
  });
}

/** Principal + interest (FLAT). */
function calculateTotalRepayment({ loanAmount, roi, tenure, loanType, roiBasis = DEFAULT_ROI_BASIS, tenureUnit = DEFAULT_TENURE_UNIT }) {
  const interestPaise = toPaise(calculateInterest({ loanAmount, roi, tenure, loanType, roiBasis, tenureUnit }));
  return fromPaise(toPaise(loanAmount) + interestPaise);
}

/** Per-instalment amount, plus the deterministic handling of the residue. */
function calculateEmiAmount({ totalRepayment, emiCount }) {
  const count = BigInt(emiCount);
  if (count <= 0n) {
    throw new RangeError('EMI count must be greater than zero');
  }

  const totalPaise = toPaise(totalRepayment);
  const emiPaise = divideRoundHalfUp(totalPaise, count);
  const remainderPaise = totalPaise - emiPaise * count;

  return {
    emiAmount: fromPaise(emiPaise),
    roundingRemainder: fromPaise(remainderPaise),
    // Absorbs the residue so the instalments reconcile to the total exactly.
    lastEmiAmount: fromPaise(emiPaise + remainderPaise)
  };
}

/**
 * The level instalment for a reducing-balance loan, in paise.
 * Exact rational arithmetic; the single rounding is the final one.
 */
function reducingEmiPaise({ principalPaise, roi, loanType, emiCount, roiBasis = DEFAULT_ROI_BASIS }) {
  const { numerator: r, denominator: d } = periodicRate(roi, loanType, roiBasis);
  const n = BigInt(emiCount);

  // A zero rate has no annuity: the principal is simply shared out.
  if (r === 0n) {
    return divideRoundHalfUp(principalPaise, n);
  }

  const grown = (d + r) ** n; // (1 + i)^n, scaled by d^n
  const base = d ** n;

  return divideRoundHalfUp(principalPaise * r * grown, d * (grown - base));
}

/**
 * Amortises a reducing-balance loan into per-instalment parts.
 *
 * Interest is charged on the balance still outstanding, so it falls as the
 * balance does. The final instalment repays the exact remaining principal,
 * which is what makes the three totals reconcile without a fudge factor.
 */
function reducingPlan({ loanAmount, roi, loanType, emiCount, roiBasis = DEFAULT_ROI_BASIS }) {
  const principalPaise = toPaise(loanAmount);
  const { numerator: r, denominator: d } = periodicRate(roi, loanType, roiBasis);
  const emiPaise = reducingEmiPaise({ principalPaise, roi, loanType, emiCount, roiBasis });

  const periods = [];
  let outstanding = principalPaise;

  for (let index = 0; index < emiCount; index += 1) {
    const interestPaise = r === 0n ? 0n : divideRoundHalfUp(outstanding * r, d);
    const isLast = index === emiCount - 1;

    // The last instalment clears the balance; the others pay the level EMI.
    const principalPart = isLast ? outstanding : emiPaise - interestPaise;

    if (!isLast && principalPart <= 0n) {
      throw ApiError.badRequest(
        'At this rate and tenure the instalment would not cover the interest, so the loan would never be repaid'
      );
    }

    periods.push({
      emiAmount: fromPaise(principalPart + interestPaise),
      principal: fromPaise(principalPart),
      interest: fromPaise(interestPaise)
    });

    outstanding -= principalPart;
  }

  const totalPaise = periods.reduce((total, period) => total + toPaise(period.emiAmount), 0n);
  const lastPaise = toPaise(periods[periods.length - 1].emiAmount);

  return {
    periods,
    summary: {
      interest: fromPaise(totalPaise - principalPaise),
      totalRepayment: fromPaise(totalPaise),
      emiCount,
      emiAmount: fromPaise(emiPaise),
      roundingRemainder: fromPaise(lastPaise - emiPaise),
      lastEmiAmount: fromPaise(lastPaise)
    }
  };
}

/**
 * Amortises a flat loan into per-instalment parts.
 *
 * Every instalment but the last carries the headline EMI the borrower was
 * quoted; the last carries the residue. Interest is spread evenly and principal
 * is the remainder, so SUM(principal) = SUM(emi) - SUM(interest) = loan amount.
 * `totalRepayment` and `emiAmount` can be supplied to reproduce a stored loan's
 * schedule exactly rather than recomputing it.
 */
function flatPlan({ loanAmount, roi, loanType, emiCount, totalRepayment, emiAmount, roiBasis = DEFAULT_ROI_BASIS, term }) {
  const contractualTerm = term ?? termMonths({ loanType, periods: emiCount });
  const interest = flatInterest({ loanAmount, roi, term: contractualTerm, roiBasis });
  const totalPaise = totalRepayment !== undefined ? toPaise(totalRepayment) : toPaise(loanAmount) + toPaise(interest);
  const perEmiPaise = emiAmount !== undefined ? toPaise(emiAmount) : divideRoundHalfUp(totalPaise, BigInt(emiCount));

  const interestPaise = totalPaise - toPaise(loanAmount);
  const interestShare = divideRoundHalfUp(interestPaise, BigInt(emiCount));

  const periods = [];
  for (let index = 0; index < emiCount; index += 1) {
    const isLast = index === emiCount - 1;
    const emiPart = isLast ? totalPaise - perEmiPaise * BigInt(emiCount - 1) : perEmiPaise;
    const interestPart = isLast ? interestPaise - interestShare * BigInt(emiCount - 1) : interestShare;

    periods.push({
      emiAmount: fromPaise(emiPart),
      principal: fromPaise(emiPart - interestPart),
      interest: fromPaise(interestPart)
    });
  }

  const lastPaise = toPaise(periods[periods.length - 1].emiAmount);

  return {
    periods,
    summary: {
      interest: fromPaise(interestPaise),
      totalRepayment: fromPaise(totalPaise),
      emiCount,
      emiAmount: fromPaise(perEmiPaise),
      roundingRemainder: fromPaise(lastPaise - perEmiPaise),
      lastEmiAmount: fromPaise(lastPaise)
    }
  };
}

/**
 * Every instalment of a loan, plus the loan-level totals derived from them.
 * The schedule generator and the preview both come through here, so a quoted
 * figure and a stored instalment can never be produced by different code.
 */
function buildInstalmentPlan({
  loanAmount,
  roi,
  tenure,
  loanType,
  startDate,
  interestMethod = INTEREST_METHODS.FLAT,
  weeklyOff = WEEKLY_OFF.NONE,
  roiBasis = DEFAULT_ROI_BASIS,
  tenureUnit = DEFAULT_TENURE_UNIT,
  collectionCount = null,
  totalRepayment,
  emiAmount
}) {
  const resolved = resolvePeriods({ loanType, tenure, startDate, weeklyOff, tenureUnit, collectionCount });
  const { calendarDays, chargeableDays, emiCount, offsets, term, endDate } = resolved;

  const plan =
    interestMethod === INTEREST_METHODS.REDUCING
      ? reducingPlan({ loanAmount, roi, loanType, emiCount, roiBasis })
      : flatPlan({ loanAmount, roi, loanType, emiCount, totalRepayment, emiAmount, roiBasis, term });

  return {
    periods: plan.periods,
    offsets,
    summary: {
      ...plan.summary,
      interestMethod,
      weeklyOff,
      roiBasis,
      tenureUnit,
      // The contractual window, so the form can show what the borrower signs up
      // to rather than only the instalment count. Reported only for a
      // month-based contract, where it is the whole number that was entered —
      // no float is produced anywhere in this service.
      termMonths: tenureUnit === TENURE_UNITS.MONTHS ? Number(tenure) : null,
      startDate: startDate ?? null,
      endDate,
      calendarDays,
      chargeableDays,
      // The number of collections actually asked for, when the loan states one.
      collectionCount: resolved.collectionCount,
      // Where the last collection falls, which may precede the contractual end.
      lastCollectionDate: offsets && startDate ? addDays(startDate, offsets[offsets.length - 1]) : null
    }
  };
}

/**
 * Everything the loan record needs, derived from the borrower-facing terms.
 * `emiCount` is the number of chargeable periods, which equals `tenure` unless
 * a daily loan skips a weekday.
 */
function calculateLoanFinancials(terms) {
  return buildInstalmentPlan(terms).summary;
}

module.exports = {
  resolvePeriods,
  termMonths,
  annualRoiScaled,
  periodicRate,
  flatInterest,
  reducingEmiPaise,
  reducingPlan,
  flatPlan,
  buildInstalmentPlan,
  calculateInterest,
  calculateTotalRepayment,
  calculateEmiAmount,
  calculateLoanFinancials
};
