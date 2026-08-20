import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AlertMessage from '../../components/common/AlertMessage';
import Spinner from '../../components/common/Spinner';
import RouteFormModal from '../../components/routes/RouteFormModal';
import AssignCollectorModal from '../../components/routes/AssignCollectorModal';
import AssignLoanModal from '../../components/routes/AssignLoanModal';
import { CollectorAssignmentsTable, LoanAssignmentsTable } from '../../components/routes/RouteAssignmentTables';
import { RouteStatusBadge } from '../../components/routes/RouteStatusBadge';
import usePermissions from '../../hooks/usePermissions';
import { getRoute, getRouteAssignments, updateRouteStatus, setCollectorAssignmentStatus, setLoanAssignmentStatus } from '../../services/routeService';
import { PERMISSIONS } from '../../utils/permissions';

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

export default function RouteDetailsPage() {
  const { id } = useParams();
  const { can } = usePermissions();

  const [route, setRoute] = useState(null);
  const [collectors, setCollectors] = useState([]);
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const [editOpen, setEditOpen] = useState(false);
  const [collectorModalOpen, setCollectorModalOpen] = useState(false);
  const [loanModalOpen, setLoanModalOpen] = useState(false);

  const canUpdate = can(PERMISSIONS.ROUTES_UPDATE);
  const canAssign = can(PERMISSIONS.ROUTES_ASSIGN);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [routeResponse, assignmentsResponse] = await Promise.all([getRoute(id), getRouteAssignments(id)]);
      setRoute(routeResponse.data.route);
      setCollectors(assignmentsResponse.data.collectors);
      setLoans(assignmentsResponse.data.loans);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load this route.');
      setRoute(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggleStatus = async () => {
    const nextStatus = route.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    setBusy(true);
    setError('');
    try {
      await updateRouteStatus(route.id, nextStatus);
      setNotice(`Route is now ${nextStatus.toLowerCase()}.`);
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const handleUnassignCollector = async (assignment) => {
    setBusyId(assignment.id);
    setError('');
    try {
      await setCollectorAssignmentStatus(route.id, assignment.id, 'REMOVED');
      setNotice(`${assignment.collector?.name ?? 'Collector'} unassigned. The assignment is retained as history.`);
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleRemoveLoan = async (assignment) => {
    setBusyId(assignment.id);
    setError('');
    try {
      await setLoanAssignmentStatus(route.id, assignment.id, 'REMOVED');
      setNotice(`${assignment.loan?.loanNumber ?? 'Loan'} removed from this route. The assignment is retained as history.`);
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  };

  const afterAssignment = async (message) => {
    setCollectorModalOpen(false);
    setLoanModalOpen(false);
    setNotice(message);
    await load();
  };

  if (loading) return <Spinner label="Loading route…" />;

  const activeCollectorIds = collectors.filter((a) => a.status === 'ACTIVE').map((a) => a.collector?.id).filter(Boolean);
  const activeLoanIds = loans.filter((a) => a.status === 'ACTIVE').map((a) => a.loan?.id).filter(Boolean);

  return (
    <div className="container-fluid px-0">
      <Link className="btn btn-sm btn-outline-secondary mb-3" to="/routes">
        <i className="bi bi-arrow-left me-1" aria-hidden="true" />
        Back to routes
      </Link>

      <AlertMessage message={notice} variant="success" onDismiss={() => setNotice('')} />
      <AlertMessage message={error} onDismiss={() => setError('')} />

      {route ? (
        <>
          <div className="card border-0 shadow-sm mb-4">
            <div className="card-body d-flex flex-wrap align-items-start justify-content-between gap-3">
              <div>
                <div className="d-flex align-items-center gap-2 mb-2">
                  <span className="badge text-bg-light border font-monospace fs-6">{route.routeCode}</span>
                  <RouteStatusBadge status={route.status} size="lg" />
                </div>
                <h1 className="h3 fw-bold mb-1">{route.name}</h1>
                <p className="text-secondary mb-0">{route.description || 'No description'}</p>
              </div>

              {canUpdate ? (
                <div className="d-flex flex-wrap gap-2">
                  <button type="button" className="btn btn-outline-primary" onClick={() => setEditOpen(true)} disabled={busy}>
                    <i className="bi bi-pencil me-2" aria-hidden="true" />
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`btn ${route.status === 'ACTIVE' ? 'btn-outline-danger' : 'btn-primary'}`}
                    onClick={handleToggleStatus}
                    disabled={busy}
                  >
                    {route.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              ) : null}
            </div>
            {route.status === 'INACTIVE' ? (
              <div className="card-footer bg-white text-secondary small">
                <i className="bi bi-info-circle me-1" aria-hidden="true" />
                This route is inactive. New collectors and loans cannot be assigned to it, and its history remains readable.
              </div>
            ) : null}
          </div>

          <div className="card border-0 shadow-sm mb-4">
            <div className="card-body">
              <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
                <h2 className="h5 fw-bold mb-0">
                  Collectors
                  <span className="badge text-bg-light border ms-2">{activeCollectorIds.length} active</span>
                </h2>
                {canAssign ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => setCollectorModalOpen(true)}
                    disabled={route.status !== 'ACTIVE'}
                    title={route.status !== 'ACTIVE' ? 'Activate the route before assigning collectors' : undefined}
                  >
                    <i className="bi bi-person-plus me-1" aria-hidden="true" />
                    Assign collector
                  </button>
                ) : null}
              </div>
              <CollectorAssignmentsTable
                assignments={collectors}
                canAssign={canAssign}
                onUnassign={handleUnassignCollector}
                busyId={busyId}
              />
            </div>
          </div>

          <div className="card border-0 shadow-sm mb-4">
            <div className="card-body">
              <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
                <h2 className="h5 fw-bold mb-0">
                  Loans
                  <span className="badge text-bg-light border ms-2">{activeLoanIds.length} active</span>
                </h2>
                {canAssign ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => setLoanModalOpen(true)}
                    disabled={route.status !== 'ACTIVE'}
                    title={route.status !== 'ACTIVE' ? 'Activate the route before assigning loans' : undefined}
                  >
                    <i className="bi bi-plus-lg me-1" aria-hidden="true" />
                    Assign loan
                  </button>
                ) : null}
              </div>
              <LoanAssignmentsTable assignments={loans} canAssign={canAssign} onUnassign={handleRemoveLoan} busyId={busyId} />
              <p className="form-text mb-0 mt-2">
                A loan sits on one active route at a time. Assigning a loan that is already routed elsewhere moves it and
                closes the previous assignment, which stays visible as history.
              </p>
            </div>
          </div>

          <div className="card border-0 shadow-sm">
            <div className="card-body">
              <h2 className="h6 fw-bold mb-3">
                <i className="bi bi-info-circle me-2 text-primary" aria-hidden="true" />
                System information
              </h2>
              <dl className="row mb-0">
                <dt className="col-6 col-sm-4 text-secondary fw-normal">Created by</dt>
                <dd className="col-6 col-sm-8">{route.createdBy?.name ?? '—'}</dd>
                <dt className="col-6 col-sm-4 text-secondary fw-normal">Created</dt>
                <dd className="col-6 col-sm-8">{formatDateTime(route.createdAt)}</dd>
                <dt className="col-6 col-sm-4 text-secondary fw-normal">Last updated by</dt>
                <dd className="col-6 col-sm-8">{route.updatedBy?.name ?? '—'}</dd>
                <dt className="col-6 col-sm-4 text-secondary fw-normal">Updated</dt>
                <dd className="col-6 col-sm-8 mb-0">{formatDateTime(route.updatedAt)}</dd>
              </dl>
            </div>
          </div>

          <RouteFormModal
            open={editOpen}
            mode="edit"
            route={route}
            onClose={() => setEditOpen(false)}
            onSaved={async () => {
              setEditOpen(false);
              setNotice('Route updated.');
              await load();
            }}
          />

          <AssignCollectorModal
            open={collectorModalOpen}
            route={route}
            assignedUserIds={activeCollectorIds}
            onClose={() => setCollectorModalOpen(false)}
            onAssigned={afterAssignment}
          />

          <AssignLoanModal
            open={loanModalOpen}
            route={route}
            assignedLoanIds={activeLoanIds}
            onClose={() => setLoanModalOpen(false)}
            onAssigned={afterAssignment}
          />
        </>
      ) : null}
    </div>
  );
}
