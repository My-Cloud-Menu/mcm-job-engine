import { AxiosError } from 'axios';
import { HandlerError } from './types';

export interface ClassifiedError {
  message: string;
  code: string;
  retryable: boolean;
  statusCode?: number;
  responseBody?: unknown;
  retryAfterSeconds?: number;
}

/**
 * Normalises any thrown value into a ClassifiedError.
 * Determines retryability based on error type and HTTP status.
 */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof HandlerError) {
    return {
      message: err.message,
      code: err.code,
      retryable: err.retryable,
      statusCode: err.statusCode,
      responseBody: err.responseBody,
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }

  const isAxios =
    err instanceof AxiosError ||
    (typeof err === 'object' && err !== null && (err as Record<string, unknown>)['isAxiosError'] === true);

  if (isAxios) {
    const ax = err as AxiosError;
    const status = ax.response?.status;

    if (!status) {
      return {
        message: ax.message,
        code: ax.code ?? 'NETWORK_ERROR',
        retryable: true,
      };
    }

    if (status >= 400 && status < 500) {
      // 408 Request Timeout and 429 Too Many Requests are retryable
      const retryable = status === 408 || status === 429;
      return {
        message: `HTTP ${status}: ${ax.message}`,
        code: `HTTP_${status}`,
        retryable,
        statusCode: status,
        responseBody: ax.response?.data,
      };
    }

    if (status >= 500) {
      return {
        message: `HTTP ${status}: ${ax.message}`,
        code: `HTTP_${status}`,
        retryable: true,
        statusCode: status,
        responseBody: ax.response?.data,
      };
    }
  }

  const e = err as Error;
  return {
    message: e?.message ?? 'Unknown error',
    code: 'UNKNOWN_ERROR',
    retryable: true,
  };
}
