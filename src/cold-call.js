/**
 * Cold Call Detection Module
 *
 * Classifies Dialpad call transcripts as cold calls using Cloudflare Workers AI,
 * and logs detected cold calls as RF custom activities.
 */

import { extractRFIdFromDialpadContact, updateRFCandidate, createRFCustomActivity } from './rf-client.js';

// --- Constants ---

const JOEL_DIALPAD_USER_ID = '8000000000000001';
const JOEL_RF_USER_ID = 900001;
const COLD_CALL_ACTIVITY_TYPE_ID = 1002;
const TRANSCRIPT_MAX_CHARS = 5000;
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const COLD_CALL_SYSTEM_PROMPT = `You are a call transcript classifier for a recruiting firm. Determine whether this transcript is from a COLD CALL or not.

A cold call is:
- The first-ever contact with someone who doesn't know the caller
- The caller introduces themselves, their role, and why they are reaching out
- The tone is unfamiliar and formal — not a follow-up, not a scheduled call, not a catch-up
- Could be a connected conversation or a voicemail left for a stranger
- The caller typically mentions reaching out via LinkedIn, a specific job role, or an opportunity

A non-cold call is:
- A conversation with someone the caller has already spoken to
- A scheduled call, follow-up, prep call, or update call
- The tone is familiar — greetings like "Hey, how are you?", "Thanks for booking time", etc.
- Internal calls between colleagues

Respond with ONLY valid JSON, no other text:
{"is_cold_call": true, "reasoning": "one sentence explanation"}
or
{"is_cold_call": false, "reasoning": "one sentence explanation"}`;

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

export async function classifyColdCall(transcriptText, env) {
  const truncated = truncateTranscript(transcriptText);

  if (!truncated) {
    return { is_cold_call: false, reasoning: 'No transcript text available' };
  }

  const response = await env.AI.run(AI_MODEL, {
    messages: [
      { role: 'system', content: COLD_CALL_SYSTEM_PROMPT },
      { role: 'user', content: `Transcript:\n\n${truncated}` }
    ]
  });

  try {
    const text = response.response || '';
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.error({ message: '[ColdCall] LLM response not parseable', source: 'cold-call', raw: text });
      return { is_cold_call: false, reasoning: 'LLM response could not be parsed' };
    }
    return JSON.parse(jsonMatch[0]);
  } catch {
    console.error({ message: '[ColdCall] JSON parse failed', source: 'cold-call', raw: response.response });
    return { is_cold_call: false, reasoning: 'LLM response could not be parsed' };
  }
}

/**
 * Process a Dialpad call event and track cold calls on RF.
 * Returns { processed: bool, isColdCall: bool, reason: string }
 */
export async function processCallEvent(payload, env) {
  const state = payload.state;
  const callId = payload.call_id;

  // --- Pre-LLM filters ---

  if (!isJoelsCall(payload.target?.id)) {
    return { processed: false, isColdCall: false, reason: 'not target user' };
  }

  if (!isOutboundCall(payload.direction)) {
    return { processed: false, isColdCall: false, reason: 'not outbound' };
  }

  const rfCandidateId = extractRFIdFromDialpadContact(payload.contact?.id);
  if (!rfCandidateId) {
    return { processed: false, isColdCall: false, reason: 'no RF candidate' };
  }

  // Dedup
  const dedupeKey = `coldcall:${callId}`;
  const alreadyProcessed = await env.SYNC_STATE.get(dedupeKey);
  if (alreadyProcessed) {
    return { processed: false, isColdCall: false, reason: 'already processed' };
  }

  // --- Get transcript ---

  let transcriptText = '';

  if (state === 'transcription') {
    transcriptText = payload.transcription_text || '';
  } else if (state === 'call_transcription') {
    try {
      const transcript = await fetchCallTranscript(callId, env);
      transcriptText = typeof transcript === 'string'
        ? transcript
        : (transcript.text || transcript.transcription || JSON.stringify(transcript));
    } catch (error) {
      console.error({ message: '[ColdCall] transcript fetch failed', source: 'cold-call', callId, error: error.message });
      return { processed: false, isColdCall: false, reason: 'transcript fetch failed' };
    }
  }

  if (!transcriptText) {
    return { processed: false, isColdCall: false, reason: 'no transcript text' };
  }

  // --- LLM classification ---

  let classification;
  try {
    classification = await classifyColdCall(transcriptText, env);
  } catch (error) {
    console.error({ message: '[ColdCall] AI classification failed', source: 'cold-call', callId, error: error.message });
    await env.SYNC_STATE.put(dedupeKey, 'true', { expirationTtl: 300 });
    return { processed: false, isColdCall: false, reason: 'AI classification error' };
  }

  // Set dedup regardless of result
  await env.SYNC_STATE.put(dedupeKey, 'true', { expirationTtl: 300 });

  if (!classification.is_cold_call) {
    return { processed: true, isColdCall: false, reason: classification.reasoning };
  }

  // --- Cold call detected: update RF ---

  const candidateName = payload.contact?.name || 'Unknown';
  const callTimestamp = payload.date_started || payload.event_timestamp || Date.now();
  const activityTime = formatActivityTime(callTimestamp);

  await createRFCustomActivity({
    activity_text: `Cold call with ${candidateName}`,
    activity_time: activityTime,
    activity_type_id: COLD_CALL_ACTIVITY_TYPE_ID,
    activity_user_id: JOEL_RF_USER_ID,
    associated_entities: { candidates: [parseInt(rfCandidateId, 10)] },
    mentions: []
  }, env);

  await updateRFCandidate(rfCandidateId, { source: 'Cold Call' }, env);

  return { processed: true, isColdCall: true, reason: classification.reasoning };
}
