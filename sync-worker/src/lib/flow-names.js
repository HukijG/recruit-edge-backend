export const FLOWS = Object.freeze({
  WORKFLOW_FULL_REBUILD: 'WorkflowFullRebuild',
  WORKFLOW_PIPELINE_REBUILD: 'WorkflowPipelineRebuild',
  WORKFLOW_CACHE_SEED: 'WorkflowCacheSeed',
  CRON_TAIL_SYNC: 'CronTailSync',
  CRON_CANDIDATES_TICK: 'CronCandidatesTick',
  CRON_JOBS_TICK: 'CronJobsTick',
  CRON_CALLS_TICK: 'CronCallsTick',
  ADMIN_TRIGGER_FULL_REBUILD: 'AdminTriggerFullRebuild',
  ADMIN_TRIGGER_CACHE_REBUILD: 'AdminTriggerCacheRebuild',
  INTERNAL_CALLS_UPSERT: 'InternalCallsUpsert',
});
