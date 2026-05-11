export const FLOWS = Object.freeze({
  EXTENSION_ADD_CANDIDATE: 'ExtensionAddCandidate',
  EXTENSION_ADD_TO_JOB: 'ExtensionAddToJob',
  EXTENSION_MARK_INVALID: 'ExtensionMarkInvalid',
  EXTENSION_FETCH_DETAILS: 'ExtensionFetchCandidateDetails',
  EXTENSION_DIALPAD_USER_CONTEXT: 'ExtensionDialpadUserContext',
  EXTENSION_CALL_REQUEST: 'ExtensionCallRequest',
  EXTENSION_DIALPAD_SMS: 'ExtensionDialpadSms',
  EXTENSION_CALL_STATE_POLL: 'ExtensionCallStatePoll',

  WEBHOOK_RF: 'WebhookRecruiterflow',
  WEBHOOK_RF_MANUAL: 'WebhookRecruiterflowManual',
  WEBHOOK_DIALPAD_GENERAL: 'WebhookDialpadGeneral',
  WEBHOOK_DIALPAD_CALL: 'WebhookDialpadCall',
  WEBHOOK_DIALPAD_EXT_CALL: 'WebhookDialpadExtensionCall',
  WEBHOOK_KRISP: 'WebhookKrisp',
  WEBHOOK_CALENDAR: 'WebhookCalendar',
  WEBHOOK_APOLLO_ENRICHMENT: 'WebhookApolloEnrichment',

  MCP_PROXY: 'MCP/Proxy',

  HEALTH: 'Health',
  TEST_COLD_CALL: 'TestColdCall',
});

export function mcpToolFlow(toolName) {
  return `MCP/${toolName}`;
}
