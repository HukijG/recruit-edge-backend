/**
 * Cold Call Detection Module
 *
 * Classifies Dialpad call transcripts as cold calls using Cloudflare Workers AI,
 * determines call outcome (voicemail, connected positive/negative),
 * and logs detected cold calls as RF custom activities.
 */

import { extractRFIdFromDialpadContact, updateRFCandidate, createRFCustomActivity, getRFCandidate, moveJobsToStage } from './rf-client.js';
import { isMonitoredDialpadUser, getRFUserIdByDialpadId } from './users.js';

// --- Constants ---

const COLD_CALL_ACTIVITY_TYPE_ID = 1002;
const COLD_CALL_TAG = 'Cold Called';
const TRANSCRIPT_MAX_CHARS = 5000;
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const VALID_OUTCOMES = ['voicemail', 'connected_positive', 'connected_negative'];
const ACTION_ITEMS_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const TRANSCRIPT_TAIL_CHARS = 1500;

const ACTION_ITEMS_PROMPT = `Extract the key action items and next steps from the end of this cold call transcript. Be very brief — 2-4 bullet points max. Focus on what was agreed: follow-up method (InMail, email, another call), whether the candidate wants more info, any specific topics to discuss next time. If nothing concrete was discussed, say "No specific next steps discussed."

Respond with ONLY the bullet points, no preamble.`;

const NEGATIVE_NOTES_PROMPT = `Summarise the candidate's situation and the key points they raised from the end of this cold call transcript. Be very brief — 2-4 bullet points max. Capture anything notable about their current role, plans, timing, motivations, or perspective on the opportunity. If nothing notable was discussed, say "No specific notes from this call."

Respond with ONLY the bullet points, no preamble. Put each bullet on its own line.`;

const COLD_CALL_SYSTEM_PROMPT = `You are a call transcript classifier for a recruiting firm. Analyze this transcript and determine:
1. Whether this is a COLD CALL (unsolicited outbound contact with a candidate)
2. If it is a cold call, what was the OUTCOME

COLD CALL — DEFINITE indicators (any one of these = cold call, regardless of tone):
- Caller says "headhunter" (e.g. "I'm Joel Haines, a headhunter")
- Caller references following up on a LinkedIn message (e.g. "sent you a message about a role", "following up on my LinkedIn message", "reached out on LinkedIn about...")
- Caller mentions sending a message about a specific role or opportunity

These are ALWAYS cold calls even if the tone sounds casual or like a follow-up — the caller is following up on an unsolicited outreach, not a prior conversation.

COLD CALL — other signals:
- First-ever contact with someone who doesn't know the caller
- Caller introduces themselves and their role/reason for reaching out
- May be a connected conversation OR a voicemail left for a stranger

NOT a cold call:
- Candidate already knows the caller from a prior phone conversation
- Scheduled call, prep call, interview debrief, or status update
- Internal calls between colleagues
- Candidate references a previous phone call ("good to talk again", "as we discussed last time")

OUTCOME (only when is_cold_call is true) — judge from transcript content. Be conservative: when in doubt, prefer "voicemail":

- "voicemail": Caller leaves a message with no real candidate participation. This is the DEFAULT when the transcript is one-sided.
  * The caller does ~all the substantive talking
  * The "other side" of the transcript is silent, has only short greetings, has automated answering-machine prompts ("leave a message after the beep", "hinterlassen Sie eine Nachricht", etc.), OR contains garbled / mistranscribed text — Dialpad's transcription regularly produces nonsense words from non-English voicemail greetings (German, French, Spanish, etc.) that may look like brief candidate utterances. Treat all of these as voicemail prompts, NOT as candidate speech.
  * If you cannot quote a SUBSTANTIVE candidate response (a real sentence, not a fragment or a single word), it's a voicemail.

- "connected_positive": Two-way dialogue. The candidate speaks substantively — full sentences, asks questions, expresses interest, agrees to follow up. You must be able to point to actual candidate sentences in the transcript.

- "connected_negative": Two-way dialogue. The candidate speaks substantively and declines, isn't interested, or disengages after engaging. You must be able to point to actual candidate sentences that EXPLICITLY decline, refuse, or show disinterest (e.g. "I'm not interested", "I just joined a new company", "please don't call me"). NEVER classify as connected_negative based on "tone", "the candidate didn't engage", or "no candidate response" — absence of candidate dialogue means VOICEMAIL, not connected_negative.

Respond with ONLY valid JSON, no other text:
{"is_cold_call": true, "outcome": "voicemail", "reasoning": "one sentence explanation"}
{"is_cold_call": true, "outcome": "connected_positive", "reasoning": "one sentence explanation"}
{"is_cold_call": true, "outcome": "connected_negative", "reasoning": "one sentence explanation"}
{"is_cold_call": false, "outcome": null, "reasoning": "one sentence explanation"}`;

// --- Pure helpers ---

/**
 * Append a tag to an existing tags array (deduped, set-like).
 * Defensive against missing/non-array input — RF returns tags as an array
 * of bare strings.
 */
export function mergeTag(existingTags, value) {
  const tags = Array.isArray(existingTags) ? existingTags : [];
  return tags.includes(value) ? tags : [...tags, value];
}

/**
 * Convert "\n" newlines to "<br>\n" so RF's activity_text renderer breaks lines.
 * RF's activity field only honours <br>; other HTML tags are silently dropped,
 * and bare \n collapses to a space at render time.
 */
export function addHtmlLineBreaks(text) {
  if (!text) return text;
  return text.replace(/\n/g, '<br>\n');
}

export function isOutboundCall(direction) {
  return direction === 'outbound';
}

export function truncateTranscript(text, maxChars = TRANSCRIPT_MAX_CHARS) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars);
}

export function formatActivityTime(timestamp) {
  const date = new Date(typeof timestamp === 'number' ? timestamp : Date.parse(timestamp));
  return date.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

/** Convert outcome enum to display label for RF activity text. */
export function formatOutcomeLabel(outcome) {
  switch (outcome) {
    case 'voicemail': return 'Voicemail';
    case 'connected_positive': return 'Connected (Positive)';
    case 'connected_negative': return 'Connected (Negative)';
    default: return null;
  }
}

/** Get the tail end of a transcript (roughly last minute of conversation). */
export function extractTranscriptTail(text, maxChars = TRANSCRIPT_TAIL_CHARS) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

/** For connected_positive calls, extract action items from the tail of the transcript using a lightweight model. */
export async function extractActionItems(transcriptText, env) {
  const tail = extractTranscriptTail(transcriptText);
  if (!tail) return null;

  try {
    const response = await env.AI.run(ACTION_ITEMS_MODEL, {
      messages: [
        { role: 'system', content: ACTION_ITEMS_PROMPT },
        { role: 'user', content: tail }
      ]
    });

    const raw = response.response;
    const text = (typeof raw === 'object' && raw !== null) ? JSON.stringify(raw) : String(raw || '');
    const trimmed = text.trim();
    return trimmed || null;
  } catch (error) {
    console.error({ message: `[ColdCall] Action items extraction failed: ${error.message}`, source: 'cold-call', step: 'action_items' });
    return null;
  }
}

/** For connected_negative calls, extract a short summary of what the candidate raised from the tail of the transcript using a lightweight model. */
export async function extractNegativeCallNotes(transcriptText, env) {
  const tail = extractTranscriptTail(transcriptText);
  if (!tail) return null;

  try {
    const response = await env.AI.run(ACTION_ITEMS_MODEL, {
      messages: [
        { role: 'system', content: NEGATIVE_NOTES_PROMPT },
        { role: 'user', content: tail }
      ]
    });

    const raw = response.response;
    const text = (typeof raw === 'object' && raw !== null) ? JSON.stringify(raw) : String(raw || '');
    const trimmed = text.trim();
    return trimmed || null;
  } catch (error) {
    console.error({ message: `[ColdCall] Negative-call notes extraction failed: ${error.message}`, source: 'cold-call', step: 'negative_notes' });
    return null;
  }
}

// --- API functions ---

export async function fetchCallTranscript(callId, env) {
  const dialpadApiKey = env.DIALPAD_API_KEY;
  const dialpadBaseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';

  if (!dialpadApiKey) {
    throw new Error('DIALPAD_API_KEY environment variable is required');
  }

  const response = await fetch(`${dialpadBaseUrl}/transcripts/${callId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${dialpadApiKey}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dialpad transcript API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

export async function classifyColdCall(transcriptText, env, callState) {
  const truncated = truncateTranscript(transcriptText);

  if (!truncated) {
    return { is_cold_call: false, outcome: null, reasoning: 'No transcript text available' };
  }

  // Only pass a call-type hint when state='transcription' — that's Dialpad's
  // dedicated voicemail webhook, so we know for sure. For 'call_transcription'
  // Dialpad fires the same event for live calls AND for outbound calls that
  // went to voicemail (especially with non-English answering machines), so
  // pinning "Connected call" actively misleads the classifier. Let the LLM
  // judge from content per the OUTCOME rules in the system prompt.
  const userMessage = callState === 'transcription'
    ? `Call type: Voicemail\n\nTranscript:\n\n${truncated}`
    : `Transcript:\n\n${truncated}`;

  const response = await env.AI.run(AI_MODEL, {
    messages: [
      { role: 'system', content: COLD_CALL_SYSTEM_PROMPT },
      { role: 'user', content: userMessage }
    ]
  });

  try {
    const raw = response.response;

    // Workers AI may return response as already-parsed object or as a string
    let parsed;
    if (raw && typeof raw === 'object') {
      parsed = raw;
    } else {
      const text = raw || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error({ message: `[ColdCall] LLM response not parseable: ${text.substring(0, 200)}`, source: 'cold-call' });
        return { is_cold_call: false, outcome: null, reasoning: 'LLM response could not be parsed' };
      }
      parsed = JSON.parse(jsonMatch[0]);
    }

    if (typeof parsed.is_cold_call !== 'boolean') {
      console.error({ message: `[ColdCall] LLM JSON missing is_cold_call field: ${JSON.stringify(parsed).substring(0, 200)}`, source: 'cold-call' });
      return { is_cold_call: false, outcome: null, reasoning: 'LLM response missing is_cold_call field' };
    }

    const outcome = parsed.is_cold_call && VALID_OUTCOMES.includes(parsed.outcome) ? parsed.outcome : null;
    return { is_cold_call: parsed.is_cold_call, outcome, reasoning: parsed.reasoning || '' };
  } catch (err) {
    console.error({ message: `[ColdCall] JSON parse failed: ${JSON.stringify(response.response).substring(0, 200)}`, source: 'cold-call' });
    return { is_cold_call: false, outcome: null, reasoning: 'LLM response could not be parsed' };
  }
}

/**
 * Process a Dialpad call event and track cold calls on RF.
 * Returns { processed: bool, isColdCall: bool, outcome: string|null, reason: string }
 */
export async function processCallEvent(payload, env) {
  const state = payload.state;
  const callId = payload.call_id;
  const contactId = payload.contact?.id;
  const contactName = payload.contact?.name;

  console.log({
    message: `[ColdCall] processing call_id=${callId}`,
    source: 'cold-call',
    step: 'enter',
    callId,
    state,
    direction: payload.direction,
    contactId,
    contactName,
    targetId: payload.target?.id,
    targetName: payload.target?.name,
    dateStarted: payload.date_started,
    hasTranscriptionText: !!payload.transcription_text,
  });

  // --- Pre-LLM filters ---

  if (!isMonitoredDialpadUser(payload.target?.id)) {
    console.log({ message: `[ColdCall] skipped: not a monitored target user (target=${payload.target?.id})`, source: 'cold-call', step: 'filter', callId });
    return { processed: false, isColdCall: false, outcome: null, reason: 'not target user' };
  }

  if (!isOutboundCall(payload.direction)) {
    console.log({ message: `[ColdCall] skipped: inbound call`, source: 'cold-call', step: 'filter', callId });
    return { processed: false, isColdCall: false, outcome: null, reason: 'not outbound' };
  }

  const rfCandidateId = extractRFIdFromDialpadContact(contactId);
  if (!rfCandidateId) {
    console.log({ message: `[ColdCall] skipped: no RF candidate ID (contact=${contactId})`, source: 'cold-call', step: 'filter', callId, contactId });
    return { processed: false, isColdCall: false, outcome: null, reason: 'no RF candidate' };
  }

  console.log({ message: `[ColdCall] matched RF candidate=${rfCandidateId}`, source: 'cold-call', step: 'match', callId, rfCandidateId, contactName });

  // Dedup — set BEFORE expensive operations to prevent retry storms hitting AI
  const dedupeKey = `coldcall:${callId}`;
  const alreadyProcessed = await env.SYNC_STATE.get(dedupeKey);
  if (alreadyProcessed) {
    console.log({ message: `[ColdCall] skipped: already processed (dedup key exists)`, source: 'cold-call', step: 'dedup', callId });
    return { processed: false, isColdCall: false, outcome: null, reason: 'already processed' };
  }
  await env.SYNC_STATE.put(dedupeKey, 'true', { expirationTtl: 300 });
  console.log({ message: `[ColdCall] dedup key set`, source: 'cold-call', step: 'dedup', callId });

  // --- Get transcript ---

  let transcriptText = '';

  if (state === 'transcription') {
    transcriptText = payload.transcription_text || '';
    console.log({ message: `[ColdCall] transcript source=voicemail_payload (${transcriptText.length} chars)`, source: 'cold-call', step: 'transcript', callId, transcriptLength: transcriptText.length });
  } else if (state === 'call_transcription') {
    try {
      const transcript = await fetchCallTranscript(callId, env);
      transcriptText = typeof transcript === 'string'
        ? transcript
        : (transcript.text || transcript.transcription || JSON.stringify(transcript));
      console.log({ message: `[ColdCall] transcript source=dialpad_api (${transcriptText.length} chars)`, source: 'cold-call', step: 'transcript', callId, transcriptLength: transcriptText.length });
    } catch (error) {
      console.error({ message: `[ColdCall] transcript fetch failed: ${error.message}`, source: 'cold-call', step: 'transcript', callId });
      return { processed: false, isColdCall: false, outcome: null, reason: 'transcript fetch failed' };
    }
  }

  if (!transcriptText) {
    console.log({ message: `[ColdCall] skipped: no transcript text available`, source: 'cold-call', step: 'transcript', callId, state });
    return { processed: false, isColdCall: false, outcome: null, reason: 'no transcript text' };
  }

  // --- LLM classification ---

  let classification;
  try {
    classification = await classifyColdCall(transcriptText, env, state);
    console.log({
      message: `[ColdCall] classified: is_cold_call=${classification.is_cold_call} outcome=${classification.outcome} — "${classification.reasoning}"`,
      source: 'cold-call',
      step: 'classify',
      callId,
      rfCandidateId,
      contactName,
      isColdCall: classification.is_cold_call,
      outcome: classification.outcome,
      reasoning: classification.reasoning,
    });
  } catch (error) {
    console.error({ message: `[ColdCall] AI classification failed: ${error.message}`, source: 'cold-call', step: 'classify', callId });
    return { processed: false, isColdCall: false, outcome: null, reason: 'AI classification error' };
  }

  if (!classification.is_cold_call) {
    return { processed: true, isColdCall: false, outcome: null, reason: classification.reasoning };
  }

  // --- Cold call detected: fetch candidate, then write activity + tag/source update ---

  // RF /candidate/update REPLACES arrays, so we must read existing tags first
  // and send back the full merged set. Synchronous chain: any failure aborts —
  // we'd rather lose an event than risk silently wiping tags or duplicating writes.
  let candidate;
  try {
    candidate = await getRFCandidate(rfCandidateId, env);
  } catch (error) {
    console.error({ message: `[ColdCall] candidate fetch failed: ${error.message}`, source: 'cold-call', step: 'fetch_candidate', callId, rfCandidateId });
    return { processed: true, isColdCall: true, outcome: classification.outcome, reason: `classified as cold call but candidate fetch failed: ${error.message}` };
  }

  const existingTags = candidate?.tags;
  const mergedTags = mergeTag(existingTags, COLD_CALL_TAG);
  console.log({
    message: `[ColdCall] tags read: existing=${JSON.stringify(existingTags)} merged=${JSON.stringify(mergedTags)}`,
    source: 'cold-call',
    step: 'tags_read',
    callId,
    rfCandidateId,
    existingTags,
    mergedTags,
  });

  const callTimestamp = payload.date_started || payload.event_timestamp || Date.now();
  const activityTime = formatActivityTime(callTimestamp);
  const outcomeLabel = formatOutcomeLabel(classification.outcome);
  let activityText = outcomeLabel
    ? `Cold call with ${contactName || 'Unknown'} — ${outcomeLabel}`
    : `Cold call with ${contactName || 'Unknown'}`;

  // For connected calls, extract a short bullet-point summary from the tail of
  // the transcript using the cheap model. Positive calls get "Next steps",
  // negative calls get "Notes" (general candidate context, not action items).
  if (classification.outcome === 'connected_positive') {
    const actionItems = await extractActionItems(transcriptText, env);
    if (actionItems) {
      activityText += `\n\nNext steps:\n${actionItems}`;
      console.log({ message: `[ColdCall] action items extracted`, source: 'cold-call', step: 'action_items', callId });
    }
  } else if (classification.outcome === 'connected_negative') {
    const notes = await extractNegativeCallNotes(transcriptText, env);
    if (notes) {
      activityText += `\n\nNotes:\n${notes}`;
      console.log({ message: `[ColdCall] negative-call notes extracted`, source: 'cold-call', step: 'negative_notes', callId });
    }
  }

  const activityUserId = getRFUserIdByDialpadId(payload.target?.id);
  // RF's activity_text only honours <br> for line breaks; bare \n collapses
  // to a space at render time. Convert just before sending.
  const formattedActivityText = addHtmlLineBreaks(activityText);

  try {
    await createRFCustomActivity({
      activity_text: formattedActivityText,
      activity_time: activityTime,
      activity_type_id: COLD_CALL_ACTIVITY_TYPE_ID,
      activity_user_id: activityUserId,
      associated_entities: { candidates: [parseInt(rfCandidateId, 10)] },
      mentions: []
    }, env);

    await updateRFCandidate(rfCandidateId, { source: 'Cold Call', tags: mergedTags }, env);

    console.log({
      message: `[ColdCall] RF updated: activity="${formattedActivityText}" + source=Cold Call + tags=${JSON.stringify(mergedTags)}`,
      source: 'cold-call',
      step: 'rf_update',
      callId,
      rfCandidateId,
      contactName,
      activityText: formattedActivityText,
      outcome: classification.outcome,
      tags: mergedTags,
      activityUserId,
    });
  } catch (error) {
    console.error({ message: `[ColdCall] RF update failed: ${error.message}`, source: 'cold-call', step: 'rf_update', callId, rfCandidateId });
    return { processed: true, isColdCall: true, outcome: classification.outcome, reason: `classified as cold call but RF update failed: ${error.message}` };
  }

  // For connected calls (positive or negative), progress the candidate from
  // Sourced → Replied on jobs[0] (the most recently-touched job).
  // Voicemails don't qualify — no actual reply happened. We deliberately do
  // NOT scan later jobs: if jobs[0] is already past Sourced or closed, we
  // skip rather than risk moving the wrong job. The added_to_job_by filter
  // was dropped — the LinkedIn extension adds candidates via the API, not
  // as a user, so that field doesn't carry the recruiter's RF user ID.
  if (classification.outcome === 'connected_positive' || classification.outcome === 'connected_negative') {
    try {
      const moveResult = await moveJobsToStage(rfCandidateId, candidate, {
        currentStage: 'Sourced',
        targetStage: 'Replied',
        userId: activityUserId,
      }, env);
      console.log({
        message: `[ColdCall] stage move: moved=${moveResult.moved} jobs=${JSON.stringify(moveResult.jobIds)}`,
        source: 'cold-call',
        step: 'stage_move',
        callId,
        rfCandidateId,
        moved: moveResult.moved,
        jobIds: moveResult.jobIds,
        activityUserId,
      });
    } catch (error) {
      console.error({ message: `[ColdCall] stage move failed: ${error.message}`, source: 'cold-call', step: 'stage_move', callId, rfCandidateId });
      return { processed: true, isColdCall: true, outcome: classification.outcome, reason: `classified as cold call but stage move failed: ${error.message}` };
    }
  }

  return { processed: true, isColdCall: true, outcome: classification.outcome, reason: classification.reasoning };
}

/**
 * Map an RF activity object (from /candidate/activity/list) to the shape the
 * extension's /candidate-details route expects. Only valid for cold-call
 * activities (type.id === 1002).
 *
 * Description extraction: the activity text is built as
 *   "Cold call with X — Outcome<br>\n<br>\n<body>"
 * with addHtmlLineBreaks. We split on the first <br>\n<br>\n to peel the
 * header and return the body as plain text (stripping remaining <br> tags).
 */
export function parseColdCallActivity(activity) {
  const text = typeof activity?.text === 'string' ? activity.text : '';

  // Outcome via regex on the header
  let outcome = null;
  const m = text.match(/—\s*(Voicemail|Connected)/);
  if (m) {
    outcome = m[1] === 'Voicemail' ? 'voicemail' : 'connected';
  }

  // Description = text after the first double-<br>; strip remaining <br>
  let description = '';
  const splitIndex = text.indexOf('<br>\n<br>\n');
  if (splitIndex >= 0) {
    description = text.slice(splitIndex + '<br>\n<br>\n'.length);
    description = description.replace(/<br>\n?/g, '\n').trim();
  }

  // Defensive: invalid timestamps would crash toISOString(); prefer null over crash.
  let createdAt = null;
  if (activity.time) {
    const d = new Date(activity.time);
    if (!Number.isNaN(d.getTime())) {
      createdAt = d.toISOString();
    }
  }

  return {
    id: activity.activity_id,
    type: 'cold_call',
    name: 'Cold call',
    description,
    createdAt,
    outcome,
  };
}

