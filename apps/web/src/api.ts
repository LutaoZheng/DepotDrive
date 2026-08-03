import axios from 'axios';
import { MAX_UPLOAD_FILE_SIZE } from '@depot-drive/shared';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000', withCredentials: true });

interface BackendErrorBody { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } }

export class UserFacingError extends Error {
  constructor(public readonly userMessage: string) { super(userMessage); this.name = 'UserFacingError'; }
}

const sentence = (message: string) => /[.!?]$/.test(message) ? message : `${message}.`;
export const maximumUploadSizeLabel = `${MAX_UPLOAD_FILE_SIZE / (1024 * 1024 * 1024)} GB`;
export const fileTooLargeMessage = (message = 'File exceeds the maximum allowed size') => `${sentence(message)}\nMaximum allowed size: ${maximumUploadSizeLabel}.`;

function backendError(data: unknown): { code?: string; message?: string } {
  if (!data || typeof data !== 'object') return {};
  const body = data as BackendErrorBody;
  const source = body.error && typeof body.error === 'object' ? body.error : body;
  return {
    code: typeof source.code === 'string' ? source.code : undefined,
    message: typeof source.message === 'string' && source.message.trim() ? source.message.trim() : undefined,
  };
}

function statusMessage(status: number): string | undefined {
  if (status === 400) return 'Invalid request';
  if (status === 401) return 'Authentication required';
  if (status === 403) return 'Access denied';
  if (status === 404) return 'Resource not found';
  if (status === 409) return 'Request conflict';
  if (status === 413) return fileTooLargeMessage();
  if (status === 422) return 'Request could not be processed';
  if (status >= 500) return 'Server error';
  return undefined;
}

export function parseApiError(error: unknown, fallback = 'Something went wrong'): string {
  if (error instanceof UserFacingError) return error.userMessage;
  if (axios.isAxiosError(error)) {
    const parsed = backendError(error.response?.data);
    if (parsed.code === 'FILE_TOO_LARGE') return fileTooLargeMessage(parsed.message);
    if (parsed.message) return parsed.message;
    if (error.response?.status) return statusMessage(error.response.status) ?? fallback;
    return fallback;
  }
  return fallback;
}

export const errorMessage = parseApiError;
