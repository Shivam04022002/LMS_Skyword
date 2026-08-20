import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import CustomerFormModal from '../../components/customers/CustomerFormModal';
import { CustomerStatusBadge, CifIdBadge } from '../../components/customers/CustomerBadges';
import usePermissions from '../../hooks/usePermissions';
import { getCustomer } from '../../services/customerService';
import { PERMISSIONS } from '../../utils/permissions';
import { titleCase } from '../../utils/customerConstants';

const dash = <span className="text-secondary">—</span>;

function Row({ label, children }) {
  return (
    <>
      <dt className="col-5 col-sm-4 text-secondary fw-normal">{label}</dt>
      <dd className="col-7 col-sm-8">{children || dash}</dd>
    </>
  );
}

function Section({ title, icon, children }) {
  return (
    <div className="card border-0 shadow-sm h-100">
      <div className="card-body">
        <h2 className="h6 fw-bold mb-3">
          <i className={`bi ${icon} me-2 text-primary`} aria-hidden="true" />
          {title}
        </h2>
        <dl className="row mb-0">{children}</dl>
      </div>
    </div>
  );
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : null;
}

export default function CustomerDetailsPage() {
  const { id } = useParams();
  const { can } = usePermissions();

  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editOpen, setEditOpen] = useState(false);

  const loadCustomer = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await getCustomer(id);
      setCustomer(response.data.customer);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load this customer.');
      setCustomer(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadCustomer();
  }, [loadCustomer]);

  const handleSaved = async () => {
    setEditOpen(false);
    setNotice('Customer updated successfully.');
    await loadCustomer();
  };

  if (loading) {
    return <Spinner label="Loading customer…" />;
  }

  return (
    <div className="container-fluid px-0">
      <Link className="btn btn-sm btn-outline-secondary mb-3" to="/customers">
        <i className="bi bi-arrow-left me-1" aria-hidden="true" />
        Back to customers
      </Link>

      <AlertMessage message={notice} variant="success" onDismiss={() => setNotice('')} />
      <AlertMessage message={error} onDismiss={() => setError('')} />

      {customer ? (
        <>
          <div className="card border-0 shadow-sm mb-4">
            <div className="card-body d-flex flex-wrap align-items-center justify-content-between gap-3">
              <div>
                <div className="d-flex align-items-center gap-2 mb-2">
                  <CifIdBadge cifId={customer.cifId} copyable size="lg" />
                  <CustomerStatusBadge status={customer.status} />
                </div>
                <h1 className="h3 fw-bold mb-0">{customer.fullName}</h1>
              </div>
              {can(PERMISSIONS.CUSTOMERS_UPDATE) ? (
                <button type="button" className="btn btn-outline-primary" onClick={() => setEditOpen(true)}>
                  <i className="bi bi-pencil me-2" aria-hidden="true" />
                  Edit
                </button>
              ) : null}
            </div>
          </div>

          <div className="row g-4">
            <div className="col-12 col-lg-6">
              <Section title="Basic information" icon="bi-person">
                <Row label="First name">{customer.firstName}</Row>
                <Row label="Middle name">{customer.middleName}</Row>
                <Row label="Last name">{customer.lastName}</Row>
                <Row label="Date of birth">{formatDate(customer.dateOfBirth)}</Row>
                <Row label="Gender">{titleCase(customer.gender)}</Row>
                <Row label="Marital status">{titleCase(customer.maritalStatus)}</Row>
                <Row label="Father's name">{customer.fatherName}</Row>
                <Row label="Mother's name">{customer.motherName}</Row>
                <Row label="Occupation">{customer.occupation}</Row>
              </Section>
            </div>

            <div className="col-12 col-lg-6">
              <Section title="Contact information" icon="bi-telephone">
                <Row label="Mobile">
                  <span className="font-monospace">{customer.mobile}</span>
                </Row>
                <Row label="Alternate mobile">
                  {customer.alternateMobile ? <span className="font-monospace">{customer.alternateMobile}</span> : null}
                </Row>
                <Row label="Email">{customer.email}</Row>
              </Section>
            </div>

            <div className="col-12 col-lg-6">
              <Section title="Address" icon="bi-geo-alt">
                <Row label="Address line 1">{customer.addressLine1}</Row>
                <Row label="Address line 2">{customer.addressLine2}</Row>
                <Row label="City">{customer.city}</Row>
                <Row label="State">{customer.state}</Row>
                <Row label="Pincode">{customer.pincode}</Row>
              </Section>
            </div>

            <div className="col-12 col-lg-6">
              <Section title="System information" icon="bi-info-circle">
                <Row label="Status">
                  <CustomerStatusBadge status={customer.status} />
                </Row>
                <Row label="Created by">{customer.createdBy?.name}</Row>
                <Row label="Created">{formatDateTime(customer.createdAt)}</Row>
                <Row label="Updated by">{customer.updatedBy?.name}</Row>
                <Row label="Updated">{formatDateTime(customer.updatedAt)}</Row>
              </Section>
            </div>
          </div>

          <CustomerFormModal
            open={editOpen}
            mode="edit"
            customer={customer}
            onClose={() => setEditOpen(false)}
            onSaved={handleSaved}
          />
        </>
      ) : null}
    </div>
  );
}
