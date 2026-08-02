import axios from 'axios';
import { describe, expect, it } from 'vitest';
import { errorMessage } from './api';

describe('errorMessage', () => {
  it('uses the structured API error message', () => {
    const error = new axios.AxiosError(
      'Request failed',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        data: { error: { message: 'Folder is not empty' } },
        status: 409,
        statusText: 'Conflict',
        headers: {},
        config: { headers: new axios.AxiosHeaders() },
      },
    );

    expect(errorMessage(error)).toBe('Folder is not empty');
  });

  it('does not expose arbitrary internal errors', () => {
    expect(errorMessage(new Error('database password leaked'))).toBe('Something went wrong');
  });
});
