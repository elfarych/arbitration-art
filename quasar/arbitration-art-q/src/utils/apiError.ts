import type { AxiosError } from 'axios';

/**
 * Extract a human-readable message from a Django REST Framework / axios error.
 *
 * Order of preference:
 *  1. DRF `{"detail": "..."}` (used by APIException and most ViewSet errors,
 *     including our 502 EngineSyncError with the engine-side reason).
 *  2. DRF field-level validation: `{"coin": ["Must be in ccxt format ..."]}`.
 *  3. Plain string body, network error message, or fallback.
 */
export function extractApiErrorMessage(error: unknown, fallback = 'Ошибка'): string {
  const axiosErr = error as AxiosError<unknown> | undefined;
  const data = axiosErr?.response?.data;

  if (typeof data === 'string' && data) return data;

  if (data && typeof data === 'object') {
    const dataObj = data as Record<string, unknown>;
    const detail = dataObj.detail;
    if (typeof detail === 'string' && detail) return detail;

    // Field-level errors: pick the first non-empty message.
    for (const value of Object.values(dataObj)) {
      if (typeof value === 'string' && value) return value;
      if (Array.isArray(value) && value.length > 0) {
        const first = value[0];
        if (typeof first === 'string' && first) return first;
      }
    }
  }

  if (axiosErr?.message) return axiosErr.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
