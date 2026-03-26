/**
 * Enrichment Orchestration
 *
 * Determines if a candidate is Joel's, and orchestrates Apollo enrichment
 * (LinkedIn lookup → fallback search → phone reveal).
 */

import { enrichPerson, searchPeople, verifyApolloMatch, scoreSearchResults } from './apollo-client.js';
import { updateRFCandidate, addRFCandidateNote } from './rf-client.js';

const JOEL_RF_USER_ID = 900001;

/**
 * Check if any job on the candidate was added by Joel.
 *
 * @param {Object} fullCandidate - Full candidate object from GET /candidate/get (includes jobs array)
 * @returns {boolean}
 */
export function isJoelCandidate(fullCandidate) {
	const jobs = fullCandidate?.jobs;
	if (!Array.isArray(jobs) || jobs.length === 0) return false;
	return jobs.some(job => job.added_to_job_by?.id === JOEL_RF_USER_ID);
}

/**
 * Build the Apollo webhook callback URL for phone reveal.
 *
 * @param {string|number} rfCandidateId
 * @param {Object} env
 * @returns {string}
 */
function buildApolloWebhookUrl(rfCandidateId, env) {
	const base = env.WORKER_URL || 'https://rf-dialpad-sync-dev.example-account.workers.dev';
	return `${base}/webhook/apollo?token=${encodeURIComponent(env.APOLLO_WEBHOOK_SECRET)}&rfId=${rfCandidateId}`;
}

/**
 * Orchestrate Apollo enrichment for an RF candidate.
 *
 * @param {Object} candidate - Cached/webhook candidate record (has linkedin_profile, phone_number string, first_name, last_name, current_organization, current_title)
 * @param {Object} fullCandidate - Full candidate from GET /candidate/get (has phone_number array)
 * @param {Object} env - Worker env with APOLLO_API_KEY, APOLLO_WEBHOOK_SECRET, SYNC_STATE KV, etc.
 * @returns {Promise<{ enriched: boolean, correctedLinkedIn?: string, phoneRequested?: boolean, apolloPersonId?: string, reason?: string }>}
 */
export async function enrichCandidate(candidate, fullCandidate, env) {
	const rfId = candidate.id || fullCandidate?.id;

	// Step 0: Dedup check
	const existing = await env.SYNC_STATE.get(`apollo_enrich:${rfId}`);
	if (existing) {
		return { enriched: false, reason: 'already_attempted' };
	}

	// Step 1: Phone check — skip if candidate already has a phone number
	if (candidate.phone_number && typeof candidate.phone_number === 'string' && candidate.phone_number.trim() !== '') {
		return { enriched: false, reason: 'phone_exists' };
	}
	if (Array.isArray(fullCandidate?.phone_number) && fullCandidate.phone_number.length > 0) {
		return { enriched: false, reason: 'phone_exists' };
	}

	let apolloPerson = null;
	let correctedLinkedIn = undefined;

	// Step 2: Enrich via LinkedIn
	if (candidate.linkedin_profile) {
		apolloPerson = await enrichPerson({ linkedin_url: candidate.linkedin_profile }, {}, env);
	}

	if (apolloPerson) {
		// Step 3: Verify match
		const verification = verifyApolloMatch(apolloPerson, candidate);
		if (!verification.match) {
			// Mismatch — go to fallback search (step 5)
			apolloPerson = await fallbackSearch(candidate, env);
			if (apolloPerson) {
				if (apolloPerson.linkedin_url) {
					correctedLinkedIn = apolloPerson.linkedin_url;
				}
			} else {
				// No match found — add RF note and return
				await safeAddNote(rfId, env);
				return { enriched: false, reason: 'search_no_match' };
			}
		}
	} else {
		// Step 4: No person from LinkedIn — try name+org enrichment
		if (candidate.first_name && candidate.last_name && candidate.current_organization) {
			apolloPerson = await enrichPerson({
				first_name: candidate.first_name,
				last_name: candidate.last_name,
				organization_name: candidate.current_organization,
			}, {}, env);
		}

		if (apolloPerson) {
			if (apolloPerson.linkedin_url) {
				correctedLinkedIn = apolloPerson.linkedin_url;
			}
		} else {
			// No match — add RF note and return
			await safeAddNote(rfId, env);
			return { enriched: false, reason: 'no_apollo_match' };
		}
	}

	// Step 6: Phone reveal
	const webhookUrl = buildApolloWebhookUrl(rfId, env);
	await enrichPerson(
		{ id: apolloPerson.id },
		{ reveal_phone_number: true, webhook_url: webhookUrl },
		env
	);

	// Step 7: Update RF if LinkedIn was corrected
	if (correctedLinkedIn) {
		try {
			await updateRFCandidate(rfId, { linkedin_profile: correctedLinkedIn }, env);
		} catch (err) {
			console.error({ message: `Failed to update RF LinkedIn for ${rfId}: ${err.message}`, source: 'enrichment' });
		}
	}

	// Step 8: Store KV dedup flag
	await env.SYNC_STATE.put(`apollo_enrich:${rfId}`, JSON.stringify({
		apolloPersonId: apolloPerson.id,
		correctedLinkedIn,
		timestamp: new Date().toISOString(),
	}), { expirationTtl: 900 });

	// Step 9: Return
	return {
		enriched: true,
		correctedLinkedIn,
		phoneRequested: true,
		apolloPersonId: apolloPerson.id,
	};
}

/**
 * Fallback search when Apollo LinkedIn lookup returns a mismatched person.
 * Searches by name + org keywords, scores results, and enriches best match.
 *
 * @param {Object} candidate - RF candidate
 * @param {Object} env
 * @returns {Promise<Object|null>} Apollo person or null
 */
async function fallbackSearch(candidate, env) {
	const keywords = `${candidate.first_name} ${candidate.current_organization}`;
	const results = await searchPeople({
		q_keywords: keywords,
		person_titles: [candidate.current_title],
		include_similar_titles: false,
	}, env);

	const best = scoreSearchResults(results, candidate);
	if (!best) return null;

	// Enrich the best match to get the full profile
	const fullPerson = await enrichPerson({ id: best.id }, {}, env);
	return fullPerson;
}

/**
 * Safely add a failure note to an RF candidate. Swallows errors.
 */
async function safeAddNote(rfId, env) {
	try {
		await addRFCandidateNote(
			rfId,
			'<p>Apollo enrichment failed — LinkedIn profile likely incorrect. Manual review needed.</p>',
			env
		);
	} catch (err) {
		console.error({ message: `Failed to add RF note for ${rfId}: ${err.message}`, source: 'enrichment' });
	}
}
