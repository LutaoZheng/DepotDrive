import axios from 'axios';
import { describe, expect, it } from 'vitest';
import { parseApiError } from './api';

function axiosError(data:unknown,status=400){return new axios.AxiosError('Request failed','ERR_BAD_REQUEST',undefined,undefined,{data,status,statusText:'Error',headers:{},config:{headers:new axios.AxiosHeaders()}})}

describe('parseApiError',()=>{
  it('formats flat FILE_TOO_LARGE responses with the shared maximum',()=>{expect(parseApiError(axiosError({code:'FILE_TOO_LARGE',message:'File exceeds the maximum allowed size'},413),'Upload failed')).toBe('File exceeds the maximum allowed size.\nMaximum allowed size: 5 GB.')});
  it('supports the standard nested backend error response',()=>{expect(parseApiError(axiosError({error:{code:'FOLDER_NOT_EMPTY',message:'Folder is not empty'}},409))).toBe('Folder is not empty')});
  it('supports an ordinary flat backend error',()=>{expect(parseApiError(axiosError({code:'UPLOAD_INCOMPLETE',message:'Not all chunks have been uploaded'},409),'Upload failed')).toBe('Not all chunks have been uploaded')});
  it('falls back to the HTTP status when the response has no message',()=>{expect(parseApiError(axiosError({},404),'Upload failed')).toBe('Resource not found')});
  it('uses Upload failed for a Network Error without a response',()=>{expect(parseApiError(new axios.AxiosError('Network Error','ERR_NETWORK'), 'Upload failed')).toBe('Upload failed')});
  it('does not expose arbitrary internal errors',()=>{expect(parseApiError(new Error('database password leaked'))).toBe('Something went wrong')});
});
