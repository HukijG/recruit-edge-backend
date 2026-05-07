import { handleCacheStatus } from './cache-status.js';
import { handleCandidateGet } from './candidate-get.js';
import { handleCandidateSearch } from './candidate-search.js';
import { handleJobPipeline } from './job-pipeline.js';
import { handleJobCandidatesFilter } from './job-candidates-filter.js';

export const handlers = {
  '/mcp/cache-status': handleCacheStatus,
  '/mcp/candidate-get': handleCandidateGet,
  '/mcp/candidate-search': handleCandidateSearch,
  '/mcp/job-pipeline': handleJobPipeline,
  '/mcp/job-candidates-filter': handleJobCandidatesFilter,
};
