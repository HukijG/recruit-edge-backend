import { env as workerEnv } from 'cloudflare:workers';
import { installBodyCapture } from './lib/body-capture.js';
import { installLogsBridge, withLogsFlush } from './lib/logs-bridge.js';

installBodyCapture();
installLogsBridge('rf-dialpad-sync-dev');

import { instrument } from '@microlabs/otel-cf-workers';
import { resolveOtelConfig } from './lib/otel-config.js';
import { trace } from '@opentelemetry/api';
import { FLOWS } from './lib/flow-names.js';
import { readInboundTraceLink } from './lib/trace-link.js';
import { authExtensionRequest, setAuthSpanSuccess, setAuthSpanFailure } from './auth-extension.js';
import {
  handleSmsTemplatesList, handleSmsTemplateUpsert, handleSmsTemplateDelete,
} from './sms-templates.js';
import {
  handleStageMovedWebhook, handleAggregatePull,
  handleReconcileRoute, runReconcile, handleBackfillRoute,
} from './stage-stats.js';
import { ExtCallState } from './extension-call-do.js';
export { ExtCallState };
import { ColdCallArbiter } from './cold-call-arbiter-do.js';
export { ColdCallArbiter };
import { handleRecruiterflowWebhook, handleManualRFWebhook } from './handlers/rf-webhooks.js';
import {
  handleDialpadWebhook,
  handleDialpadCallWebhook,
  handleDialpadExtensionCallsWebhook,
} from './handlers/dialpad-webhooks.js';
import { handleCalendarWebhook } from './handlers/calendar-webhook.js';
import { handleKrispWebhook } from './handlers/krisp-webhook.js';
import { handleColdCallFinalizeCancelled, handleTestColdCall } from './handlers/cold-call-routes.js';
import { handleApolloWebhook } from './handlers/apollo-enrichment.js';
import {
  handleCandidatesEndpoint,
  handleAddToJobEndpoint,
  handleMarkInvalidEndpoint,
  handleCandidateDetailsEndpoint,
} from './handlers/candidates.js';
import {
  handleDialpadUserContextEndpoint,
  handleDialpadCallEndpoint,
  handleDialpadSmsEndpoint,
  handleDialpadHangupEndpoint,
  handleExtensionCallStatusEndpoint,
} from './handlers/dialpad-endpoints.js';
import { handleMySourcingJobsEndpoint, handleJobPipelineEndpoint, handleCallStatsEndpoint } from './handlers/pipeline-endpoints.js';

const handler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-RF-Webhook-Token, X-Calendar-Webhook-Token, X-Krisp-Webhook-Token, X-Extension-Token, RF-Event-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (url.pathname.startsWith('/mcp/')) {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.MCP_PROXY);
        const { routeMcp } = await import('./mcp/router.js');
        const { handlers } = await import('./mcp/handlers-registry.js');
        return routeMcp(request, env, ctx, handlers);
      }

      if (url.pathname === '/health') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.HEALTH);
        return new Response('RF-Dialpad Sync Middleware - OK', {
          status: 200,
          headers: corsHeaders
        });
      }

      if (url.pathname === '/webhook/recruiterflow' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.WEBHOOK_RF);
        return await handleRecruiterflowWebhook(request, env);
      }

      if (url.pathname === '/webhook/dialpad' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.WEBHOOK_DIALPAD_GENERAL);
        return await handleDialpadWebhook(request, env);
      }

      if (url.pathname === '/webhook/calendar' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.WEBHOOK_CALENDAR);
        return await handleCalendarWebhook(request, env);
      }

      if (url.pathname === '/webhook/recruiterflow/manual' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.WEBHOOK_RF_MANUAL);
        return await handleManualRFWebhook(request, env, url);
      }

      if (url.pathname === '/webhook/recruiterflow/stage-moved' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.WEBHOOK_RF_STAGE_MOVED);
        return await handleStageMovedWebhook(request, env, ctx);
      }

      if (url.pathname === '/stats/stage-aggregate' && request.method === 'GET') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.STATS_AGGREGATE_PULL);
        return await handleAggregatePull(request, env, url);
      }

      if (url.pathname === '/admin/stage-stats/reconcile' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.STATS_RECONCILE);
        return await handleReconcileRoute(request, env);
      }

      if (url.pathname === '/admin/stage-stats/backfill' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.STATS_BACKFILL);
        return await handleBackfillRoute(request, env);
      }

      if (url.pathname === '/webhook/krisp' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.WEBHOOK_KRISP);
        return await handleKrispWebhook(request, env);
      }

      if (url.pathname === '/webhook/dialpad/calls' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.WEBHOOK_DIALPAD_CALL);
        return await handleDialpadCallWebhook(request, env);
      }

      if (url.pathname === '/webhook/dialpad/extension-calls' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.WEBHOOK_DIALPAD_EXT_CALL);
        return await handleDialpadExtensionCallsWebhook(request, env, ctx);
      }

      if (url.pathname === '/internal/coldcall/finalize-cancelled' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.COLD_CALL_CANCELLED_FINALIZE);
        const link = readInboundTraceLink(request);
        if (link) trace.getActiveSpan()?.addLink({ context: link });
        return await handleColdCallFinalizeCancelled(request, env);
      }

      if (url.pathname === '/webhook/apollo' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.WEBHOOK_APOLLO_ENRICHMENT);
        const link = readInboundTraceLink(request);
        if (link) trace.getActiveSpan()?.addLink({ context: link });
        return await handleApolloWebhook(request, env, url);
      }

      if (url.pathname === '/test/coldcall' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.TEST_COLD_CALL);
        return await handleTestColdCall(request, env, url);
      }

      if (url.pathname === '/candidates' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_ADD_CANDIDATE);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleCandidatesEndpoint(request, env, corsHeaders, auth);
      }

      if (url.pathname === '/candidates/add-to-job' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_ADD_TO_JOB);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleAddToJobEndpoint(request, env, ctx, corsHeaders, auth);
      }

      if (url.pathname === '/candidate-mark-invalid' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_MARK_INVALID);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleMarkInvalidEndpoint(request, env, corsHeaders, auth);
      }

      if (url.pathname === '/candidate-details' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_FETCH_DETAILS);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleCandidateDetailsEndpoint(request, env, ctx, corsHeaders, auth);
      }

      if (url.pathname === '/dialpad-user-context' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_DIALPAD_USER_CONTEXT);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleDialpadUserContextEndpoint(request, env, corsHeaders, auth);
      }

      if (url.pathname === '/dialpad-call' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_CALL_REQUEST);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleDialpadCallEndpoint(request, env, corsHeaders, auth);
      }

      if (url.pathname === '/dialpad-sms' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_DIALPAD_SMS);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleDialpadSmsEndpoint(request, env, corsHeaders, auth);
      }

      if (url.pathname === '/dialpad-hangup' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_DIALPAD_HANGUP);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleDialpadHangupEndpoint(request, env, corsHeaders, auth);
      }

      if (url.pathname === '/extension-call-status' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_CALL_STATE_POLL);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleExtensionCallStatusEndpoint(request, env, corsHeaders, auth);
      }

      if (url.pathname === '/my-sourcing-jobs' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.MOBILE_MY_SOURCING_JOBS);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleMySourcingJobsEndpoint(request, env, corsHeaders, auth);
      }

      if (url.pathname === '/job-pipeline' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.MOBILE_JOB_PIPELINE);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleJobPipelineEndpoint(request, env, corsHeaders, auth);
      }

      if (url.pathname === '/call-stats' && request.method === 'POST') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_CALL_STATS);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleCallStatsEndpoint(request, env, corsHeaders, auth);
      }

      if (url.pathname === '/sms-templates' && request.method === 'GET') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_SMS_TEMPLATES_LIST);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        return await handleSmsTemplatesList(request, env, corsHeaders, auth);
      }

      // PUT and DELETE share the path shape /sms-templates/:id ; regex pins
      // the segment so /sms-templates and /sms-templates/foo/bar can't hit it.
      const smsTemplateIdMatch = url.pathname.match(/^\/sms-templates\/([^/]+)$/);
      if (smsTemplateIdMatch && request.method === 'PUT') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_SMS_TEMPLATES_UPSERT);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        const idFromPath = decodeURIComponent(smsTemplateIdMatch[1]);
        return await handleSmsTemplateUpsert(request, env, corsHeaders, auth, idFromPath);
      }
      if (smsTemplateIdMatch && request.method === 'DELETE') {
        trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.EXTENSION_SMS_TEMPLATES_DELETE);
        const auth = await authExtensionRequest(request, env);
        if (!auth.ok) {
          setAuthSpanFailure(auth);
          return new Response(JSON.stringify({ ok: false, error: auth.message }), {
            status: auth.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        setAuthSpanSuccess(auth);
        const idFromPath = decodeURIComponent(smsTemplateIdMatch[1]);
        return await handleSmsTemplateDelete(request, env, corsHeaders, auth, idFromPath);
      }

      return new Response('Not Found', {
        status: 404,
        headers: corsHeaders
      });

    } catch (error) {
      console.error({ source: 'worker', message: 'Worker error', error: error?.message ?? String(error), stack: error?.stack });
      return new Response('Internal Server Error', {
        status: 500,
        headers: corsHeaders
      });
    }
  },

  // Hourly stage-stats reconcile (cron "7 * * * *" in wrangler.jsonc) — the
  // backstop for missed/failed stage-moved webhooks. Same instrumented-
  // scheduled pattern as the cache worker's tail-sync cron.
  async scheduled(event, env, ctx) {
    trace.getActiveSpan()?.setAttribute('flow.name', FLOWS.STATS_RECONCILE);
    ctx.waitUntil(
      runReconcile(env).catch((error) => {
        console.error({
          message: `[stage-stats] cron reconcile failed: ${error?.message}`,
          source: 'stage-stats',
          error: error?.message,
          stack: error?.stack,
        });
      }),
    );
  },
};

// `instrument()` is the production wiring. In environments where `LD_SDK_KEY` is
// absent (e.g. the vitest harness — see vitest.config.js for why), we export the
// raw handler so requests never touch the OTLP exporters. The lib `installLogsBridge`
// already self-skips on missing key; this mirrors that semantic at the handler layer.
//
// `withLogsFlush` is the INNER wrap: it proxies ctx.waitUntil so we can await all
// handler-side promises before force-flushing the OTel LoggerProvider. Without it,
// the BatchLogRecordProcessor's 1s scheduled flush never fires before fast
// handlers terminate and queued log records are dropped. @microlabs's instrument()
// does the same for spans on its outer wrap.
const wrappedHandler = withLogsFlush(handler);
export default workerEnv.LD_SDK_KEY
  ? instrument(wrappedHandler, resolveOtelConfig)
  : wrappedHandler;
