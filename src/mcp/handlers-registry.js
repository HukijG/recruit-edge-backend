import { handleCacheStatus } from './cache-status.js';
import { handleCandidateGet } from './candidate-get.js';
import { handleCandidateSearch } from './candidate-search.js';

export const handlers = {
  '/mcp/cache-status': handleCacheStatus,
  '/mcp/candidate-get': handleCandidateGet,
  '/mcp/candidate-search': handleCandidateSearch,
};
