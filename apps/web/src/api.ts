import axios from 'axios';
export const api=axios.create({baseURL:import.meta.env.VITE_API_BASE_URL??'http://localhost:3000',withCredentials:true});
export function errorMessage(error:unknown){if(axios.isAxiosError<{error?:{message?:string}}>(error))return error.response?.data?.error?.message??'Request failed';return 'Something went wrong';}
