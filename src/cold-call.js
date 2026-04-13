/**
 * Cold Call Detection Module
 *
 * Classifies Dialpad call transcripts as cold calls using Cloudflare Workers AI,
 * determines call outcome (voicemail, connected positive/negative),
 * and logs detected cold calls as RF custom activities.
 */

import { extractRFIdFromDialpadContact, updateRFCandidate, createRFCustomActivity } from './rf-client.js';

// --- Constants ---

const JOEL_DIALPAD_USER_ID = '8000000000000001';
const JOEL_RF_USER_ID = 900001;
const COLD_CALL_ACTIVITY_TYPE_ID = 1002;
const TRANSCRIPT_MAX_CHARS = 5000;
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const VALID_OUTCOMES = ['voicemail', 'connected_positive', 'connected_negative'];
const ACTION_ITEMS_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const TRANSCRIPT_TAIL_CHARS = 1500;

const ACTION_ITEMS_PROMPT = `Extract the key action items and next steps from the end of this cold call transcript. Be very brief — 2-4 bullet points max. Focus on what was agreed: follow-up method (InMail, email, another call), whether the candidate wants more info, any specific topics to discuss next time. If nothing concrete was discussed, say "No specific next steps discussed."

Respond with ONLY the bullet points, no preamble.`;

const COLD_CALL_SYSTEM_PROMPT = `You are a call transcript classifier for a recruiting firm. Analyze this transcript and determine:
1. Whether this is a COLD CALL (first-ever outbound contact with a candidate)
2. If it is a cold call, what was the OUTCOME

COLD CALL definition:
- First-ever contact with someone who doesn't know the caller
- Caller introduces themselves and their role/reason for reaching out
- Unfamiliar, formal tone — not a follow-up, scheduled call, or catch-up
- May be a connected conversation OR a voicemail left for a stranger
- The caller typically mentions reaching out via LinkedIn, a specific job role, or an opportunity

NOT a cold call:
- Conversation with someone already spoken to before
- Scheduled call, follow-up, prep call, or update
- Familiar tone — "Hey, how's it going?", "Thanks for booking time", etc.
- Internal calls between colleagues

OUTCOME (only when is_cold_call is true):
- "voicemail": Caller left a voicemail, no live conversation occurred
- "connected_positive": Candidate engaged, showed interest, was open to hearing more, or agreed to follow up
- "connected_negative": Candidate declined, wasn't interested, was dismissive, or call ended with no engagement

Respond with ONLY valid JSON, no other text:
{"is_cold_call": true, "outcome": "voicemail", "reasoning": "one sentence explanation"}
{"is_cold_call": true, "outcome": "connected_positive", "reasoning": "one sentence explanation"}
{"is_cold_call": true, "outcome": "connected_negative", "reasoning": "one sentence explanation"}
{"is_cold_call": false, "outcome": null, "reasoning": "one sentence explanation"}`;

// --- Pure helpers ---

export function isJoelsCall(targetId) {
  return String(targetId) === JOEL_DIALPAD_USER_ID;
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

  const callTypeHint = callState === 'transcription' ? 'Voicemail' : 'Connected call';
  const userMessage = `Call type: ${callTypeHint}\n\nTranscript:\n\n${truncated}`;

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

  if (!isJoelsCall(payload.target?.id)) {
    console.log({ message: `[ColdCall] skipped: not Joel's call (target=${payload.target?.id})`, source: 'cold-call', step: 'filter', callId });
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

  // --- Cold call detected: update RF ---

  const callTimestamp = payload.date_started || payload.event_timestamp || Date.now();
  const activityTime = formatActivityTime(callTimestamp);
  const outcomeLabel = formatOutcomeLabel(classification.outcome);
  let activityText = outcomeLabel
    ? `Cold call with ${contactName || 'Unknown'} — ${outcomeLabel}`
    : `Cold call with ${contactName || 'Unknown'}`;

  // For positive calls, extract action items from the tail of the transcript
  if (classification.outcome === 'connected_positive') {
    const actionItems = await extractActionItems(transcriptText, env);
    if (actionItems) {
      activityText += `\n\nNext steps:\n${actionItems}`;
      console.log({ message: `[ColdCall] action items extracted`, source: 'cold-call', step: 'action_items', callId });
    }
  }

  try {
    await createRFCustomActivity({
      activity_text: activityText,
      activity_time: activityTime,
      activity_type_id: COLD_CALL_ACTIVITY_TYPE_ID,
      activity_user_id: JOEL_RF_USER_ID,
      associated_entities: { candidates: [parseInt(rfCandidateId, 10)] },
      mentions: []
    }, env);

    await updateRFCandidate(rfCandidateId, { source: 'Cold Call' }, env);

    console.log({
      message: `[ColdCall] RF updated: activity="${activityText}" + source=Cold Call`,
      source: 'cold-call',
      step: 'rf_update',
      callId,
      rfCandidateId,
      contactName,
      activityText,
      outcome: classification.outcome,
    });
  } catch (error) {
    console.error({ message: `[ColdCall] RF update failed: ${error.message}`, source: 'cold-call', step: 'rf_update', callId, rfCandidateId });
    return { processed: true, isColdCall: true, outcome: classification.outcome, reason: `classified as cold call but RF update failed: ${error.message}` };
  }

  return { processed: true, isColdCall: true, outcome: classification.outcome, reason: classification.reasoning };
}

