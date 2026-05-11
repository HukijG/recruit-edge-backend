import { handleCacheStatus } from './cache-status.js';
import { handleCandidateGet } from './candidate-get.js';
import { handleCandidateSearch } from './candidate-search.js';
import { handleJobPipeline } from './job-pipeline.js';
import { handleJobCandidatesFilter } from './job-candidates-filter.js';
import { handleCandidateMoveStage } from './candidate-move-stage.js';
import { handleCandidateLogInterview } from './candidate-log-interview.js';
import { handleCandidateAddNote } from './candidate-add-note.js';
import { handleCandidateCallNotes } from './candidate-call-notes.js';

export const handlers = {
  '/mcp/cache-status': handleCacheStatus,
  '/mcp/candidate-get': handleCandidateGet,
  '/mcp/candidate-search': handleCandidateSearch,
  '/mcp/job-pipeline': handleJobPipeline,
  '/mcp/job-candidates-filter': handleJobCandidatesFilter,
  '/mcp/candidate-move-stage': handleCandidateMoveStage,
  '/mcp/candidate-log-interview': handleCandidateLogInterview,
  '/mcp/candidate-add-note': handleCandidateAddNote,
  '/mcp/candidate-call-notes': handleCandidateCallNotes,
};
