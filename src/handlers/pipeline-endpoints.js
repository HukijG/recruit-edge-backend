/**
 * Sourcing/pipeline read endpoints for the extension + mobile PWA —
 * my-sourcing-jobs, job-pipeline, and per-consultant call stats.
 */

import { getDailyCallCount } from '../cache.js';
import { listOpenJobs, searchCandidatesByJobAndStage, extractLinkedInSlug } from '../rf-client.js';
import { resolveRFUserId, getUserByFirstName } from '../users.js';
import { trace } from '@opentelemetry/api';

export async function handleMySourcingJobsEndpoint(request, env, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    let consultantFirstName;
    let consultantRfUserId;
    if (auth?.user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = auth.user.firstName;
      consultantRfUserId = auth.user.rfUserId;
    } else {
      // Legacy path: preserve today's 400 on missing, 403 on unknown.
      consultantFirstName = typeof payload.consultantFirstName === 'string'
        ? payload.consultantFirstName.trim()
        : '';

      if (!consultantFirstName) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
          status: 400, headers: responseHeaders,
        });
      }

      consultantRfUserId = await resolveRFUserId(env, consultantFirstName);
      if (!consultantRfUserId) {
        return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
          status: 403, headers: responseHeaders,
        });
      }
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName);

    const allJobs = await listOpenJobs(env);
    const filtered = allJobs.filter(job => {
      const onHiringTeamAsRecruiter = Array.isArray(job.hiring_team)
        && job.hiring_team.some(member =>
          member && member.user_id === consultantRfUserId
            && typeof member.role === 'string'
            && member.role.toLowerCase() === 'recruiter');
      const isSourcing = job.job_status
        && typeof job.job_status.name === 'string'
        && job.job_status.name.toLowerCase() === 'sourcing';
      return onHiringTeamAsRecruiter && isSourcing;
    });

    const jobs = filtered.map(j => ({
      id: j.id,
      name: j.name,
      company: j.company,
    }));

    console.log({
      message: `[MySourcingJobs] consultant=${consultantFirstName} jobs=${jobs.length} (filtered from ${allJobs.length} open)`,
      source: 'my-sourcing-jobs',
      consultantFirstName,
      consultantRfUserId,
      jobsReturned: jobs.length,
      jobsTotal: allJobs.length,
    });

    return new Response(JSON.stringify({ jobs }), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[MySourcingJobs] error: ${error.message}`,
      source: 'my-sourcing-jobs',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

// ---------------------------------------------------------------------------
// /job-pipeline — return Sourced-stage candidates for a job, ordered by
// per-job added_time DESC (newest-first — the recruiter just bulk-added
// these and wants to walk through them in the order they came in).
// Returns just rfId + linkedinUrl per candidate; the PWA fetches full
// details per-card via the existing /candidate-details route as it
// traverses prev/next.
// ---------------------------------------------------------------------------

export async function handleJobPipelineEndpoint(request, env, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const jobIdRaw = payload.jobId;
    const jobId = typeof jobIdRaw === 'number'
      ? jobIdRaw
      : (typeof jobIdRaw === 'string' && /^\d+$/.test(jobIdRaw.trim()) ? parseInt(jobIdRaw.trim(), 10) : null);

    let consultantFirstName;
    let consultantRfUserId;
    if (auth?.user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = auth.user.firstName;
      consultantRfUserId = auth.user.rfUserId;
    } else {
      // Legacy path: preserve today's 400-on-missing-firstName, then 400-on-missing-jobId,
      // then 403-on-unknown ordering.
      consultantFirstName = typeof payload.consultantFirstName === 'string'
        ? payload.consultantFirstName.trim()
        : '';

      if (!consultantFirstName) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
          status: 400, headers: responseHeaders,
        });
      }
      if (!jobId) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing or invalid "jobId"' }), {
          status: 400, headers: responseHeaders,
        });
      }

      consultantRfUserId = await resolveRFUserId(env, consultantFirstName);
      if (!consultantRfUserId) {
        return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
          status: 403, headers: responseHeaders,
        });
      }
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName);

    // jobId validation must run on the JWT path too; the legacy path enforced it inline.
    if (!jobId) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing or invalid "jobId"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const { candidates: rawCandidates, totalItems } = await searchCandidatesByJobAndStage(
      { jobId, stageName: 'Sourced' },
      env,
    );

    // Map → filter out missing linkedin → sort by per-job added_time DESC.
    //
    // RF's /candidate/search response carries `added_time` at TWO levels:
    //   - top-level `added_time` = candidate-record creation date (when they
    //     were first added to RF — could be years ago for existing leads)
    //   - jobs[].added_time = when this candidate was added to that specific
    //     job (the job-link creation date — what the pipeline view wants)
    //
    // Sorting by the top-level field mixes "candidate created in 2022" with
    // "candidate created today" by their CREATION date, which has no
    // relationship to the order they were added to this Sourced pipeline
    // and therefore looks random to the recruiter walking the queue.
    const enriched = rawCandidates.map(c => {
      const linkedinRaw = typeof c?.linkedin_profile === 'string' ? c.linkedin_profile.trim() : '';
      // RF returns the literal string "None" for missing fields.
      const linkedin = linkedinRaw && linkedinRaw.toLowerCase() !== 'none' ? linkedinRaw : null;
      const slug = linkedin ? extractLinkedInSlug(linkedin) : null;
      const linkedinUrl = slug ? `https://www.linkedin.com/in/${slug}` : null;
      const jobs = Array.isArray(c?.jobs) ? c.jobs : [];
      const matchingJob = jobs.find(j => Number(j?.job_id) === jobId);
      // Fall back to top-level added_time only when the per-job entry is
      // missing (shouldn't happen — RF only returns the candidate because
      // they matched the job filter — but defensive).
      const addedTime = matchingJob?.added_time || c?.added_time || null;
      const addedTs = addedTime ? Date.parse(addedTime) : NaN;
      return {
        rfId: c?.id,
        linkedinUrl,
        addedTime,
        addedTs: Number.isFinite(addedTs) ? addedTs : null,
      };
    }).filter(c => c.rfId && c.linkedinUrl);

    enriched.sort((a, b) => {
      // Newest-first; missing timestamps sink to the bottom.
      const aT = a.addedTs ?? Number.NEGATIVE_INFINITY;
      const bT = b.addedTs ?? Number.NEGATIVE_INFINITY;
      return bT - aT;
    });

    const candidates = enriched.map(c => ({
      rfId: c.rfId,
      linkedinUrl: c.linkedinUrl,
    }));

    console.log({
      message: `[JobPipeline] consultant=${consultantFirstName} job=${jobId} sourced=${candidates.length} (raw=${rawCandidates.length}, totalItems=${totalItems})`,
      source: 'job-pipeline',
      consultantFirstName,
      consultantRfUserId,
      jobId,
      stage: 'Sourced',
      candidatesReturned: candidates.length,
      rawCount: rawCandidates.length,
      totalItems,
    });

    return new Response(JSON.stringify({
      jobId,
      stage: 'Sourced',
      total: typeof totalItems === 'number' ? totalItems : candidates.length,
      candidates,
    }), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[JobPipeline] error: ${error.message}`,
      source: 'job-pipeline',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

// ---------------------------------------------------------------------------
// /call-stats — extension's "calls today" badge data. Pure KV read of the
// per-consultant daily counter, which is incremented by the
// /webhook/dialpad/extension-calls handler on every monitored outbound
// `hangup` event. Body: { consultantFirstName }. Returns { daily }.
// ---------------------------------------------------------------------------

export async function handleCallStatsEndpoint(request, env, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    let user = auth?.user ?? null;
    let consultantFirstName;
    if (user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = user.firstName;
    } else {
      // Legacy path: preserve today's 400 on missing, 403 on unknown.
      consultantFirstName = typeof payload.consultantFirstName === 'string'
        ? payload.consultantFirstName.trim()
        : '';

      if (!consultantFirstName) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
          status: 400, headers: responseHeaders,
        });
      }

      user = await getUserByFirstName(env, consultantFirstName);
      if (!user) {
        return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
          status: 403, headers: responseHeaders,
        });
      }
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName);

    const daily = await getDailyCallCount(user.rfUserId, env);

    return new Response(JSON.stringify({ daily }), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[CallStats] error: ${error.message}`,
      source: 'call-stats',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}
