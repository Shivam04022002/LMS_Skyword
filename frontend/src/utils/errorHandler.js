/**
 * Normalised error surfaced by every API call, so components never have to
 * inspect raw Axios errors.
 */
export class ApiRequestError extends Error {
  constructor({ message, status = null, errors = [], isNetworkError = false }) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.errors = errors;
    this.isNetworkError = isNetworkError;
  }
}

const STATUS_FALLBACKS = {
  400: 'The request could not be processed.',
  401: 'Your session has ended. Please log in again.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested resource was not found.',
  409: 'This action conflicts with existing data.',
  422: 'Please correct the highlighted fields.',
  429: 'Too many attempts. Please wait a moment and try again.',
  500: 'Something went wrong on the server. Please try again.',
  503: 'The service is temporarily unavailable. Please try again shortly.'
};

/** Converts an Axios failure into an ApiRequestError with a usable message. */
export function normalizeApiError(error) {
  if (error?.response) {
    const { status, data } = error.response;
    return new ApiRequestError({
      message: data?.message || STATUS_FALLBACKS[status] || 'Request failed.',
      status,
      errors: Array.isArray(data?.errors) ? data.errors : []
    });
  }

  if (error?.request) {
    return new ApiRequestError({
      message: 'Unable to reach the server. Check your connection and that the API is running.',
      isNetworkError: true
    });
  }

  return new ApiRequestError({ message: error?.message || 'An unexpected error occurred.' });
}

/** Flattens field-level validation errors into a `{ field: message }` map. */
export function toFieldErrors(error) {
  if (!(error instanceof ApiRequestError)) return {};
  return error.errors.reduce((accumulator, item) => {
    if (item?.field) accumulator[item.field] = item.message;
    return accumulator;
  }, {});
}
