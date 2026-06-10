export const FLOWS = Object.freeze({
  EXTENSION_ADD_CANDIDATE: 'ExtensionAddCandidate',
  EXTENSION_ADD_TO_JOB: 'ExtensionAddToJob',
  EXTENSION_MARK_INVALID: 'ExtensionMarkInvalid',
  EXTENSION_FETCH_DETAILS: 'ExtensionFetchCandidateDetails',
  EXTENSION_DIALPAD_USER_CONTEXT: 'ExtensionDialpadUserContext',
  EXTENSION_CALL_REQUEST: 'ExtensionCallRequest',
  EXTENSION_DIALPAD_SMS: 'ExtensionDialpadSms',
  EXTENSION_CALL_STATE_POLL: 'ExtensionCallStatePoll',
  EXTENSION_DIALPAD_HANGUP: 'ExtensionDialpadHangup',
  EXTENSION_CALL_STATS: 'ExtensionCallStats',
  EXTENSION_SMS_TEMPLATES_LIST: 'ExtensionSmsTemplatesList',
  EXTENSION_SMS_TEMPLATES_UPSERT: 'ExtensionSmsTemplatesUpsert',
  EXTENSION_SMS_TEMPLATES_DELETE: 'ExtensionSmsTemplatesDelete',

  MOBILE_MY_SOURCING_JOBS: 'MobileMySourcingJobs',
  MOBILE_JOB_PIPELINE: 'MobileJobPipeline',

  WEBHOOK_RF: 'WebhookRecruiterflow',
  WEBHOOK_RF_MANUAL: 'WebhookRecruiterflowManual',
  WEBHOOK_RF_STAGE_MOVED: 'WebhookRecruiterflowStageMoved',
  WEBHOOK_DIALPAD_GENERAL: 'WebhookDialpadGeneral',
  WEBHOOK_DIALPAD_CALL: 'WebhookDialpadCall',
  WEBHOOK_DIALPAD_EXT_CALL: 'WebhookDialpadExtensionCall',
  WEBHOOK_KRISP: 'WebhookKrisp',
  WEBHOOK_CALENDAR: 'WebhookCalendar',
  WEBHOOK_APOLLO_ENRICHMENT: 'WebhookApolloEnrichment',

  MCP_PROXY: 'MCP/Proxy',

  STATS_AGGREGATE_PULL: 'StatsStageAggregatePull',
  STATS_RECONCILE: 'StatsStageReconcile',
  STATS_BACKFILL: 'StatsStageBackfill',

  HEALTH: 'Health',
  TEST_COLD_CALL: 'TestColdCall',
});

export function mcpToolFlow(toolName) {
  return `MCP/${toolName}`;
}
