import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import AlertMessage from '../common/AlertMessage';
import { CifIdBadge } from './CustomerBadges';
import { createCustomer, updateCustomer } from '../../services/customerService';
import { toFieldErrors } from '../../utils/errorHandler';
import { isValidMobile } from '../../utils/mobile';
import { GENDERS, MARITAL_STATUSES, titleCase } from '../../utils/customerConstants';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMPTY = {
  firstName: '',
  middleName: '',
  lastName: '',
  mobile: '',
  alternateMobile: '',
  email: '',
  dateOfBirth: '',
  gender: '',
  fatherName: '',
  motherName: '',
  maritalStatus: '',
  occupation: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  pincode: ''
};

function validate(form) {
  const errors = {};

  if (!form.firstName.trim()) errors.firstName = 'First name is required';
  if (!form.mobile.trim()) errors.mobile = 'Mobile is required';
  else if (!isValidMobile(form.mobile)) errors.mobile = 'Enter a valid 10-digit Indian mobile number';

  if (form.alternateMobile.trim() && !isValidMobile(form.alternateMobile)) {
    errors.alternateMobile = 'Enter a valid 10-digit Indian mobile number';
  }
  if (form.email.trim() && !EMAIL_PATTERN.test(form.email.trim())) errors.email = 'Enter a valid email address';
  if (form.pincode.trim() && !/^\d{6}$/.test(form.pincode.trim())) errors.pincode = 'Pincode must be 6 digits';
  if (form.dateOfBirth && new Date(form.dateOfBirth) >= new Date()) errors.dateOfBirth = 'Date of birth must be in the past';

  return errors;
}

/** Only non-empty values are sent; the API treats absent fields as unchanged. */
function toPayload(form) {
  return Object.entries(form).reduce((accumulator, [key, value]) => {
    const trimmed = typeof value === 'string' ? value.trim() : value;
    if (trimmed !== '' && trimmed !== null && trimmed !== undefined) accumulator[key] = trimmed;
    return accumulator;
  }, {});
}

export default function CustomerFormModal({ open, mode = 'create', customer = null, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && customer) {
      setForm({
        ...EMPTY,
        ...Object.fromEntries(Object.keys(EMPTY).map((key) => [key, customer[key] ?? ''])),
        dateOfBirth: customer.dateOfBirth ? String(customer.dateOfBirth).slice(0, 10) : ''
      });
    } else {
      setForm(EMPTY);
    }
    setFieldErrors({});
    setFormError('');
  }, [open, mode, customer]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => ({ ...current, [name]: undefined }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError('');

    const errors = validate(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      const payload = toPayload(form);

      if (mode === 'create') {
        const response = await createCustomer(payload);
        onSaved({ mode: 'create', customer: response.data.customer });
      } else {
        const response = await updateCustomer(customer.id, payload);
        onSaved({ mode: 'edit', customer: response.data.customer });
      }
    } catch (error) {
      setFormError(error.message);
      setFieldErrors(toFieldErrors(error));
    } finally {
      setSubmitting(false);
    }
  };

  const field = (name, label, { type = 'text', required = false, colClass = 'col-12 col-md-4', ...rest } = {}) => (
    <div className={colClass} key={name}>
      <label className="form-label small fw-semibold" htmlFor={`customer-${name}`}>
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </label>
      <input
        id={`customer-${name}`}
        name={name}
        type={type}
        className={`form-control${fieldErrors[name] ? ' is-invalid' : ''}`}
        value={form[name]}
        onChange={handleChange}
        disabled={submitting}
        {...rest}
      />
      <div className="invalid-feedback">{fieldErrors[name]}</div>
    </div>
  );

  const select = (name, label, options, colClass = 'col-12 col-md-4') => (
    <div className={colClass} key={name}>
      <label className="form-label small fw-semibold" htmlFor={`customer-${name}`}>
        {label}
      </label>
      <select
        id={`customer-${name}`}
        name={name}
        className={`form-select${fieldErrors[name] ? ' is-invalid' : ''}`}
        value={form[name]}
        onChange={handleChange}
        disabled={submitting}
      >
        <option value="">Not specified</option>
        {options.map((option) => (
          <option value={option} key={option}>
            {titleCase(option)}
          </option>
        ))}
      </select>
      <div className="invalid-feedback">{fieldErrors[name]}</div>
    </div>
  );

  return (
    <Modal
      title={mode === 'create' ? 'New customer' : 'Edit customer'}
      open={open}
      onClose={submitting ? () => {} : onClose}
      size="modal-lg"
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="modal-body">
          <AlertMessage message={formError} onDismiss={() => setFormError('')} />

          {mode === 'edit' ? (
            <div className="d-flex align-items-center gap-2 mb-3 pb-3 border-bottom">
              <span className="text-secondary small">CIFID</span>
              <CifIdBadge cifId={customer?.cifId} />
              <span className="text-secondary small">· system generated, cannot be changed</span>
            </div>
          ) : (
            <p className="text-secondary small">A CIFID is generated automatically when the customer is saved.</p>
          )}

          <h3 className="h6 fw-bold text-uppercase text-secondary small mt-2 mb-2">Basic information</h3>
          <div className="row g-3 mb-3">
            {field('firstName', 'First name', { required: true })}
            {field('middleName', 'Middle name')}
            {field('lastName', 'Last name')}
            {field('dateOfBirth', 'Date of birth', { type: 'date' })}
            {select('gender', 'Gender', GENDERS)}
            {select('maritalStatus', 'Marital status', MARITAL_STATUSES)}
            {field('fatherName', "Father's name")}
            {field('motherName', "Mother's name")}
            {field('occupation', 'Occupation')}
          </div>

          <h3 className="h6 fw-bold text-uppercase text-secondary small mt-4 mb-2">Contact information</h3>
          <div className="row g-3 mb-3">
            {field('mobile', 'Mobile', { required: true, inputMode: 'tel', placeholder: '9876543210' })}
            {field('alternateMobile', 'Alternate mobile', { inputMode: 'tel' })}
            {field('email', 'Email', { type: 'email' })}
          </div>

          <h3 className="h6 fw-bold text-uppercase text-secondary small mt-4 mb-2">Address</h3>
          <div className="row g-3">
            {field('addressLine1', 'Address line 1', { colClass: 'col-12 col-md-6' })}
            {field('addressLine2', 'Address line 2', { colClass: 'col-12 col-md-6' })}
            {field('city', 'City')}
            {field('state', 'State')}
            {field('pincode', 'Pincode', { inputMode: 'numeric', maxLength: 6 })}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                Saving…
              </>
            ) : mode === 'create' ? (
              'Create customer'
            ) : (
              'Save changes'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
