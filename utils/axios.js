import axios from 'axios';
import https from 'https';
import axiosRetry from 'axios-retry';

const axiosInstance = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

axiosRetry(axiosInstance, {
  retries: 3,
  retryDelay: retryCount => retryCount * 1000,
  retryCondition: error =>
    error.code === 'ECONNABORTED' ||
    error.message.includes('timeout') ||
    error.message.includes('Network Error')
});

export default axiosInstance;
