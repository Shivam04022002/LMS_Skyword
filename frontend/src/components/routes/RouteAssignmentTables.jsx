import { Link } from 'react-router-dom';
import { AssignmentStatusBadge } from './RouteStatusBadge';
import { formatRole } from '../../utils/constants';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Collector assignment history for a route.
 *
 * Removed rows are retained and shown: they are the record of who covered the
 * route and when. Only active rows offer an unassign action; history is never
 * editable from the UI.
 */
export function CollectorAssignmentsTable({ assignments = [], canAssign = false, onUnassign, busyId = null }) {
  if (assignments.length === 0) {
    return <p className="text-secondary mb-0">No collector has been assigned to this route yet.</p>;
  }

  return (
    <div className="table-responsive">
      <table className="table table-sm align-middle mb-0">
        <thead className="table-light">
          <tr>
            <th scope="col">Collector</th>
            <th scope="col">Status</th>
            <th scope="col">Assigned</th>
            <th scope="col">Unassigned</th>
            <th scope="col">Assigned by</th>
            {canAssign ? <th scope="col" className="text-end">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {assignments.map((assignment) => {
            const isActive = assignment.status === 'ACTIVE';

            return (
              <tr key={assignment.id} className={isActive ? undefined : 'text-secondary'}>
                <td>
                  <div className="fw-semibold">{assignment.collector?.name ?? '—'}</div>
                  <div className="small text-secondary text-break">
                    {assignment.collector?.email}
                    {assignment.collector?.status === 'INACTIVE' ? (
                      <span className="badge text-bg-warning ms-2">Inactive user</span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <AssignmentStatusBadge status={assignment.status} />
                </td>
                <td className="small">{formatDate(assignment.assignedAt)}</td>
                <td className="small">{formatDate(assignment.unassignedAt)}</td>
                <td className="small text-secondary">{assignment.assignedBy?.name ?? '—'}</td>
                {canAssign ? (
                  <td className="text-end">
                    {isActive ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => onUnassign?.(assignment)}
                        disabled={busyId === assignment.id}
                      >
                        <i className="bi bi-x-circle me-1" aria-hidden="true" />
                        Unassign
                      </button>
                    ) : (
                      <span className="text-secondary small">history</span>
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Loan assignment history for a route.
 *
 * A loan sits on one active route at a time; moving it elsewhere closes the row
 * here as REMOVED with its end date, which stays visible.
 */
export function LoanAssignmentsTable({ assignments = [], canAssign = false, onUnassign, busyId = null }) {
  if (assignments.length === 0) {
    return <p className="text-secondary mb-0">No loan has been assigned to this route yet.</p>;
  }

  return (
    <div className="table-responsive">
      <table className="table table-sm align-middle mb-0">
        <thead className="table-light">
          <tr>
            <th scope="col">Loan</th>
            <th scope="col">Loan status</th>
            <th scope="col">Assignment</th>
            <th scope="col">Assigned</th>
            <th scope="col">Unassigned</th>
            <th scope="col">Assigned by</th>
            {canAssign ? <th scope="col" className="text-end">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {assignments.map((assignment) => {
            const isActive = assignment.status === 'ACTIVE';

            return (
              <tr key={assignment.id} className={isActive ? undefined : 'text-secondary'}>
                <td>
                  {assignment.loan ? (
                    <Link className="font-monospace" to={`/loans/${assignment.loan.id}`}>
                      {assignment.loan.loanNumber}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="small">{assignment.loan?.status ?? '—'}</td>
                <td>
                  <AssignmentStatusBadge status={assignment.status} />
                </td>
                <td className="small">{formatDate(assignment.assignedAt)}</td>
                <td className="small">{formatDate(assignment.unassignedAt)}</td>
                <td className="small text-secondary">{assignment.assignedBy?.name ?? '—'}</td>
                {canAssign ? (
                  <td className="text-end">
                    {isActive ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => onUnassign?.(assignment)}
                        disabled={busyId === assignment.id}
                      >
                        <i className="bi bi-x-circle me-1" aria-hidden="true" />
                        Remove
                      </button>
                    ) : (
                      <span className="text-secondary small">history</span>
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
