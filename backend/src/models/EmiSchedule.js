'use strict';

const { DataTypes, Model } = require('sequelize');
const { EMI_STATUS, EMI_STATUS_VALUES, TERMINAL_EMI_STATUSES, DEFAULT_BOUNCE_CHARGE } = require('../config/emis');
const { differenceInDays, today } = require('../utils/dates');
const { toPaise, fromPaise } = require('../utils/money');

/**
 * One instalment of a loan.
 *
 * `dpd` and `status` are stored as snapshots so they can be indexed and
 * reported on, but the API always serves freshly derived values — a stored
 * snapshot is never allowed to be the reason a client sees a stale figure.
 * `recalculateSnapshots` in emiScheduleService brings the columns back in line.
 */
class EmiSchedule extends Model {
  /** Money still owed on this instalment, as a fixed-point string. */
  outstanding() {
    const outstandingPaise = toPaise(this.emiAmount) - toPaise(this.amountCollected ?? '0');
    return fromPaise(outstandingPaise > 0n ? outstandingPaise : 0n);
  }

  /**
   * Days past due.
   *   on or before the due date        -> 0
   *   nothing outstanding, or waived   -> 0
   *   otherwise                        -> days since the due date
   * Derived from the due date and the outstanding amount, never from the
   * payment date alone.
   */
  computeDpd(asOf = today()) {
    if (TERMINAL_EMI_STATUSES.includes(this.status)) return 0;
    if (toPaise(this.outstanding()) <= 0n) return 0;

    const daysLate = differenceInDays(this.emiDate, asOf);
    return daysLate > 0 ? daysLate : 0;
  }

  /**
   * Status derived from date and money, in a fixed precedence:
   *   waived > paid > partially collected > overdue > due today > pending
   * PARTIAL outranks OVERDUE deliberately: it carries the more specific
   * information, and lateness is still reported through DPD.
   */
  computeStatus(asOf = today()) {
    if (TERMINAL_EMI_STATUSES.includes(this.status)) return this.status;

    const collected = toPaise(this.amountCollected ?? '0');
    const due = toPaise(this.emiAmount);

    if (collected >= due) return EMI_STATUS.PAID;
    if (collected > 0n) return EMI_STATUS.PARTIAL;

    const daysLate = differenceInDays(this.emiDate, asOf);
    if (daysLate > 0) return EMI_STATUS.OVERDUE;
    if (daysLate === 0) return EMI_STATUS.DUE;

    return EMI_STATUS.PENDING;
  }

  toPublicJSON(asOf = today()) {
    return {
      id: this.id,
      emiNumber: this.emiNumber,
      emiDate: this.emiDate,
      emiAmount: this.emiAmount,
      principal: this.principal,
      interest: this.interest,
      // Reported alongside the instalment, never folded into it.
      bounceCharge: this.bounceCharge ?? DEFAULT_BOUNCE_CHARGE,
      dpd: this.computeDpd(asOf),
      amountCollected: this.amountCollected,
      outstanding: this.outstanding(),
      paymentDate: this.paymentDate,
      status: this.computeStatus(asOf)
    };
  }
}

module.exports = (sequelize) => {
  EmiSchedule.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      loanId: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
      },
      // 1..emi_count, unique within the loan.
      emiNumber: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
      },
      emiDate: {
        type: DataTypes.DATEONLY,
        allowNull: false
      },
      emiAmount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
      principal: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
      interest: { type: DataTypes.DECIMAL(15, 2), allowNull: false },

      // Manually recorded fee. Read by nothing: outstanding(), computeDpd() and
      // computeStatus() above never reference it, so it cannot alter what the
      // borrower owes on this instalment or how late it is.
      bounceCharge: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: DEFAULT_BOUNCE_CHARGE },

      // Snapshot; the API serves computeDpd().
      dpd: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },

      // Owned by Phase 7 (collections). Phase 6 only ever writes 0.00 / NULL.
      amountCollected: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: '0.00' },
      paymentDate: { type: DataTypes.DATEONLY, allowNull: true },

      // Snapshot; the API serves computeStatus().
      status: {
        type: DataTypes.ENUM(...EMI_STATUS_VALUES),
        allowNull: false,
        defaultValue: EMI_STATUS.PENDING
      }
    },
    {
      sequelize,
      modelName: 'EmiSchedule',
      tableName: 'emi_schedules',
      indexes: [{ unique: true, fields: ['loan_id', 'emi_number'] }]
    }
  );

  EmiSchedule.associate = ({ Loan }) => {
    EmiSchedule.belongsTo(Loan, { foreignKey: 'loanId', as: 'Loan' });
  };

  return EmiSchedule;
};
