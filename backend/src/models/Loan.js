'use strict';

const { DataTypes, Model } = require('sequelize');
const {
  LOAN_TYPE_VALUES,
  LOAN_STATUS,
  LOAN_STATUS_VALUES,
  LOAN_TYPES,
  INTEREST_METHODS,
  INTEREST_METHOD_VALUES,
  WEEKLY_OFF,
  WEEKLY_OFF_VALUES,
  ROI_BASIS_VALUES,
  DEFAULT_ROI_BASIS,
  TENURE_UNITS,
  TENURE_UNIT_VALUES,
  DEFAULT_TENURE_UNIT,
  COLLECTION_STEP_DAYS
} = require('../config/loans');
const { PARTY_ROLES, PARTY_STATUS } = require('../config/loanParties');
const { addDays, addMonths } = require('../utils/dates');

/**
 * The financial agreement.
 *
 * Customers are attached only through LoanParty — there is deliberately no
 * applicant_id, co_applicant_id or guarantor_id here, and no CIFID: that stays
 * owned by the customer record.
 *
 * Money is stored as DECIMAL and read back as a string, so no value passes
 * through a JavaScript float on its way to or from MySQL.
 */
class Loan extends Model {
  /** Active parties in a given role, if the association was loaded. */
  partiesWithRole(role) {
    if (!Array.isArray(this.Parties)) return [];
    return this.Parties.filter((party) => party.partyRole === role && party.status === PARTY_STATUS.ACTIVE);
  }

  applicant() {
    return this.partiesWithRole(PARTY_ROLES.APPLICANT)[0] ?? null;
  }

  /**
   * The contractual end date, derived from the start date and the tenure — a
   * month-based term keeps its day of the month rather than being approximated
   * as a number of days. Derived, never stored twice.
   */
  contractualEndDate() {
    if (!this.startDate) return null;
    const start = String(this.startDate).slice(0, 10);
    const tenure = Number(this.tenure);

    if (this.tenureUnit === TENURE_UNITS.MONTHS || this.loanType === LOAN_TYPES.MONTHLY) {
      return addMonths(start, tenure);
    }
    return addDays(start, tenure * (COLLECTION_STEP_DAYS[this.loanType] ?? 1));
  }

  toPublicJSON() {
    const applicant = this.applicant();

    return {
      id: this.id,
      loanNumber: this.loanNumber,
      status: this.status,
      loanAmount: this.loanAmount,
      roi: this.roi,
      roiBasis: this.roiBasis,
      tenure: this.tenure,
      tenureUnit: this.tenureUnit,
      collectionCount: this.collectionCount,
      loanType: this.loanType,
      interestMethod: this.interestMethod,
      weeklyOff: this.weeklyOff,
      // Derived, never stored twice: a daily loan's term is `tenure` calendar
      // days and it charges `emiCount` of them.
      calendarDays: this.loanType === LOAN_TYPES.DAILY ? this.tenure : null,
      chargeableDays: this.loanType === LOAN_TYPES.DAILY ? this.emiCount : null,
      totalRepayment: this.totalRepayment,
      emiAmount: this.emiAmount,
      emiCount: this.emiCount,
      startDate: this.startDate,
      endDate: this.contractualEndDate(),
      applicant: applicant ? applicant.toPublicJSON() : null,
      coApplicants: this.partiesWithRole(PARTY_ROLES.CO_APPLICANT).map((party) => party.toPublicJSON()),
      guarantors: this.partiesWithRole(PARTY_ROLES.GUARANTOR).map((party) => party.toPublicJSON()),
      createdBy: this.CreatedBy ? { id: this.CreatedBy.id, name: this.CreatedBy.name } : null,
      updatedBy: this.UpdatedBy ? { id: this.UpdatedBy.id, name: this.UpdatedBy.name } : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  /** Compact shape for the list view. */
  toListJSON() {
    const applicant = this.applicant();

    return {
      id: this.id,
      loanNumber: this.loanNumber,
      status: this.status,
      loanAmount: this.loanAmount,
      loanType: this.loanType,
      interestMethod: this.interestMethod,
      weeklyOff: this.weeklyOff,
      tenure: this.tenure,
      emiAmount: this.emiAmount,
      startDate: this.startDate,
      endDate: this.contractualEndDate(),
      applicant: applicant?.Customer
        ? {
            cifId: applicant.Customer.cifId,
            fullName: applicant.Customer.fullName,
            mobile: applicant.Customer.mobile
          }
        : null,
      createdAt: this.createdAt
    };
  }
}

module.exports = (sequelize) => {
  Loan.init(
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      // System-generated and immutable: LN26-000001.
      loanNumber: {
        type: DataTypes.STRING(20),
        allowNull: false,
        unique: { msg: 'This loan number already exists' }
      },
      loanAmount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false
      },
      // Percentage for one period of `roiBasis`: 1.5000 means 1.50%.
      roi: {
        type: DataTypes.DECIMAL(7, 4),
        allowNull: false
      },
      /*
       * Whether `roi` is a monthly or an annual rate. New loans are monthly;
       * the ANNUAL value exists so loans priced before the change keep their
       * original meaning and can never be re-priced by a later default.
       */
      roiBasis: {
        type: DataTypes.ENUM(...ROI_BASIS_VALUES),
        allowNull: false,
        defaultValue: DEFAULT_ROI_BASIS
      },
      // Repayment periods, or contractual months — see `tenureUnit`.
      tenure: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
      },
      /*
       * Whether `tenure` counts periods of the loan type (the original meaning)
       * or calendar months of contractual term. Stored per loan so an existing
       * one is never reinterpreted.
       */
      tenureUnit: {
        type: DataTypes.ENUM(...TENURE_UNIT_VALUES),
        allowNull: false,
        defaultValue: DEFAULT_TENURE_UNIT
      },
      /*
       * How many instalments collect the contract — days, weeks or fortnights
       * depending on the loan type. NULL means the schedule follows the tenure
       * itself, which is what every loan created before this field meant.
       */
      collectionCount: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
        defaultValue: null
      },
      loanType: {
        type: DataTypes.ENUM(...LOAN_TYPE_VALUES),
        allowNull: false
      },
      // Fixed at creation: an existing loan is never re-priced by a later
      // change to the system default.
      interestMethod: {
        type: DataTypes.ENUM(...INTEREST_METHOD_VALUES),
        allowNull: false,
        defaultValue: INTEREST_METHODS.FLAT
      },
      // Only meaningful for DAILY loans; the validator enforces that.
      weeklyOff: {
        type: DataTypes.ENUM(...WEEKLY_OFF_VALUES),
        allowNull: false,
        defaultValue: WEEKLY_OFF.NONE
      },
      totalRepayment: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false
      },
      emiAmount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false
      },
      emiCount: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
      },
      status: {
        type: DataTypes.ENUM(...LOAN_STATUS_VALUES),
        allowNull: false,
        defaultValue: LOAN_STATUS.DRAFT
      },
      startDate: {
        type: DataTypes.DATEONLY,
        allowNull: false
      },
      createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }
    },
    {
      sequelize,
      modelName: 'Loan',
      tableName: 'loans'
    }
  );

  Loan.associate = ({ LoanParty, EmiSchedule, User }) => {
    Loan.hasMany(LoanParty, { foreignKey: 'loanId', as: 'Parties' });
    Loan.hasMany(EmiSchedule, { foreignKey: 'loanId', as: 'Emis' });
    Loan.belongsTo(User, { foreignKey: 'createdBy', as: 'CreatedBy' });
    Loan.belongsTo(User, { foreignKey: 'updatedBy', as: 'UpdatedBy' });
  };

  return Loan;
};
