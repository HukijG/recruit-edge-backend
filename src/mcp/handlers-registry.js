import { handleCacheStatus } from './cache-status.js';
import { handleCandidateGet } from './candidate-get.js';

export const handlers = {
  '/mcp/cache-status': handleCacheStatus,
  '/mcp/candidate-get': handleCandidateGet,
};
