/**
 * Enrichment Orchestration
 *
 * Determines if a candidate is Joel's, and orchestrates Apollo enrichment
 * (LinkedIn lookup → fallback search → phone reveal).
 */

import { enrichPerson, searchPeople, verifyApolloMatch, filterSearchResults, scoreEnrichedCandidate } from './apollo-client.js';
import { updateRFCandidate } from './rf-client.js';
import { patchDialpadContact } from './dialpad-client.js';
import { makeAsyncCallbackUrl } from './lib/trace-link.js';

function log(data) {
	console.log({ source: 'enrichment', ...data });
}

function logError(data) {
	console.error({ source: 'enrichment', ...data });
}

/**
 * Check if any job on the candidate was added by Joel.
 *
 * Joel's RF user id is passed in by the caller (resolved from the D1
 * users table, the source of truth) — this keeps the function pure / sync
 * and avoids duplicating the constant in source code.
 *
 * @param {Object} fullCandidate - Full candidate object from GET /candidate/get (includes jobs array)
 * @param {number} joelRfUserId - Joel's RF user id, looked up via getUserByFirstName(env, 'Joel')
 * @returns {boolean}
 */
export function isJoelCandidate(fullCandidate, joelRfUserId) {
	const jobs = fullCandidate?.jobs;
	if (!Array.isArray(jobs) || jobs.length === 0) return false;
	return jobs.some(job => job.added_to_job_by?.id === joelRfUserId);
}

/**
 * Build the Apollo webhook callback URL for phone reveal.
 *
 * @param {string|number} rfCandidateId
 * @param {Object} env
 * @returns {string}
 */
export function buildApolloWebhookUrl(rfCandidateId, env) {
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
	const candidateLabel = `rfId=${rfId} "${candidate.first_name} ${candidate.last_name}"`;

	log({ message: `[enrich] start ${candidateLabel}`, rfId, linkedin: candidate.linkedin_profile || null, org: candidate.current_organization || null, title: candidate.current_title || null });

	// Step 0: Dedup check
	const existing = await env.SYNC_STATE.get(`apollo_enrich:${rfId}`);
	if (existing) {
		log({ message: `[enrich] skip: already attempted ${candidateLabel}`, rfId });
		return { enriched: false, reason: 'already_attempted' };
	}

	// Step 1: Phone check — skip if candidate already has a phone number
	if (candidate.phone_number && typeof candidate.phone_number === 'string' && candidate.phone_number.trim() !== '') {
		log({ message: `[enrich] skip: phone exists (webhook string) ${candidateLabel}`, rfId, phone: candidate.phone_number });
		return { enriched: false, reason: 'phone_exists' };
	}
	if (Array.isArray(fullCandidate?.phone_number) && fullCandidate.phone_number.length > 0) {
		log({ message: `[enrich] skip: phone exists (RF array) ${candidateLabel}`, rfId, phoneCount: fullCandidate.phone_number.length });
		return { enriched: false, reason: 'phone_exists' };
	}

	let apolloPerson = null;
	let correctedLinkedIn = undefined;

	// Step 2: Enrich via LinkedIn
	if (candidate.linkedin_profile) {
		apolloPerson = await enrichPerson({ linkedin_url: candidate.linkedin_profile }, {}, env);

		if (!apolloPerson) {
			log({ message: `[enrich] LinkedIn lookup returned no person`, rfId });
		}
	} else {
		log({ message: `[enrich] no LinkedIn URL on candidate`, rfId });
	}

	if (apolloPerson) {
		// Step 3: Verify match
		const verification = verifyApolloMatch(apolloPerson, candidate);
		if (!verification.match) {
			log({
				message: `[enrich] verification FAILED — falling back to search`,
				rfId,
				reasons: verification.reasons,
			});
			apolloPerson = await fallbackSearch(candidate, fullCandidate, rfId, env);
			if (apolloPerson) {
				if (apolloPerson.linkedin_url) {
					correctedLinkedIn = apolloPerson.linkedin_url;
				}
				log({ message: `[enrich] fallback found match: apolloId=${apolloPerson.id}`, rfId, correctedLinkedIn: correctedLinkedIn || null });
			} else {
				log({ message: `[enrich] fallback search found no match — adding RF note`, rfId });
				await safeAddNote(rfId, env);
				return { enriched: false, reason: 'search_no_match' };
			}
		} else {
			log({ message: `[enrich] verification passed`, rfId });
		}
	} else {
		// Step 4: No person from LinkedIn — try name+org enrichment
		if (candidate.first_name && candidate.last_name && candidate.current_organization) {
			log({ message: `[enrich] trying name+org lookup: "${candidate.first_name} ${candidate.last_name}" @ "${candidate.current_organization}"`, rfId });
			apolloPerson = await enrichPerson({
				first_name: candidate.first_name,
				last_name: candidate.last_name,
				organization_name: candidate.current_organization,
			}, {}, env);

			if (apolloPerson) {
				if (apolloPerson.linkedin_url) {
					correctedLinkedIn = apolloPerson.linkedin_url;
				}
			} else {
				log({ message: `[enrich] name+org lookup returned no person — adding RF note`, rfId });
				await safeAddNote(rfId, env);
				return { enriched: false, reason: 'no_apollo_match' };
			}
		} else {
			log({ message: `[enrich] skip name+org: missing fields (first=${candidate.first_name}, last=${candidate.last_name}, org=${candidate.current_organization})`, rfId });
			await safeAddNote(rfId, env);
			return { enriched: false, reason: 'no_apollo_match' };
		}
	}

	// Step 6: Phone reveal
	const webhookUrl = makeAsyncCallbackUrl(buildApolloWebhookUrl(rfId, env), {});
	await enrichPerson(
		{ id: apolloPerson.id },
		{ reveal_phone_number: true, webhook_url: webhookUrl },
		env
	);

	// Step 7: Update RF + Dialpad if LinkedIn was corrected
	if (correctedLinkedIn) {
		try {
			await updateRFCandidate(rfId, { linkedin_profile: correctedLinkedIn }, env);
		} catch (err) {
			logError({ message: `[enrich] failed to update RF LinkedIn: ${err.message}`, rfId });
		}

		// Patch Dialpad contact with ONLY the corrected LinkedIn — nothing else
		try {
			await patchDialpadContact(rfId, { urls: [correctedLinkedIn] }, env);
		} catch (err) {
			logError({ message: `[enrich] failed to patch Dialpad LinkedIn: ${err.message}`, rfId });
		}
	}

	// Step 8: Store KV dedup flag
	await env.SYNC_STATE.put(`apollo_enrich:${rfId}`, JSON.stringify({
		apolloPersonId: apolloPerson.id,
		correctedLinkedIn,
		timestamp: new Date().toISOString(),
	}), { expirationTtl: 900 });

	log({ message: `[enrich] complete — phone reveal requested`, rfId, apolloPersonId: apolloPerson.id, correctedLinkedIn: correctedLinkedIn || null });

	return {
		enriched: true,
		correctedLinkedIn,
		phoneRequested: true,
		apolloPersonId: apolloPerson.id,
	};
}

/**
 * Fallback search when Apollo LinkedIn lookup returns a mismatched person.
 * Uses People Search (free) as a pre-filter, then enriches individual results (paid)
 * and scores them against full RF candidate data.
 *
 * @param {Object} candidate - RF candidate (webhook payload)
 * @param {Object} fullCandidate - Full RF candidate from getRFCandidate() GET API
 * @param {string|number} rfId - RF candidate ID (for logging)
 * @param {Object} env
 * @returns {Promise<Object|null>} Apollo person or null
 */
async function fallbackSearch(candidate, fullCandidate, rfId, env) {
	const rfFirst = (candidate.first_name || '').trim();
	const rfLast = (candidate.last_name || '').trim();
	const isSingleCharLast = /^[a-zA-Z]\.?$/.test(rfLast);

	// Build search keywords — include last name when not single-char
	const namePart = isSingleCharLast ? rfFirst : `${rfFirst} ${rfLast}`;
	const keywords = `${namePart} ${(candidate.current_organization || '').trim()}`;

	const results = await searchPeople({
		q_keywords: keywords,
		person_titles: [(candidate.current_title || '').trim()],
		include_similar_titles: false,
	}, env);

	// Pre-filter: first name match, last_name_obfuscated letter check, cap at 5
	const filtered = filterSearchResults(results, candidate);
	log({
		message: `[fallback] after pre-filter: ${filtered.length} candidates`,
		rfId,
		filtered: filtered.map(r => ({ id: r.id, name: `${r.first_name} ${r.last_name_obfuscated || '?'}`, org: r.organization?.name || 'N/A' })),
	});

	if (filtered.length === 0) {
		log({ message: `[fallback] no candidates passed pre-filter`, rfId });
		return null;
	}

	// Enrich each result and score against full RF candidate data
	const scored = [];
	for (const searchResult of filtered) {
		const enriched = await enrichPerson({ id: searchResult.id }, {}, env);
		if (!enriched) {
			log({ message: `[fallback] enrich failed for apolloId=${searchResult.id}`, rfId });
			continue;
		}

		const result = scoreEnrichedCandidate(enriched, fullCandidate);
		log({
			message: `[fallback] scored "${enriched.first_name} ${enriched.last_name}" @ "${enriched.organization?.name || 'N/A'}": passed=${result.passed} confidence=${result.confidence}%`,
			rfId,
			apolloId: enriched.id,
			passed: result.passed,
			confidence: result.confidence,
			score: result.score,
			maxPossible: result.maxPossible,
			gateFailures: result.gateFailures,
			matches: result.matches,
			mismatches: result.mismatches,
		});

		if (result.passed) {
			scored.push({ person: enriched, ...result });
		}
	}

	if (scored.length === 0) {
		log({ message: `[fallback] no candidates passed gates`, rfId });
		return null;
	}

	// Single gate-passing result — accept (gates are strong enough)
	if (scored.length === 1) {
		log({ message: `[fallback] single match: apolloId=${scored[0].person.id} confidence=${scored[0].confidence}%`, rfId });
		return scored[0].person;
	}

	// Multiple gate-passing results — pick best confidence, check for ambiguity
	scored.sort((a, b) => b.confidence - a.confidence);

	// Ambiguity: top 2 have same confidence → can't distinguish
	if (scored[0].confidence === scored[1].confidence) {
		log({
			message: `[fallback] ambiguous: top 2 tied at ${scored[0].confidence}%`,
			rfId,
			candidates: scored.slice(0, 2).map(s => ({ apolloId: s.person.id, name: `${s.person.first_name} ${s.person.last_name}`, confidence: s.confidence })),
		});
		return null;
	}

	// Require 60% confidence when disambiguating multiple results
	if (scored[0].confidence < 60) {
		log({ message: `[fallback] best confidence ${scored[0].confidence}% < 60% threshold`, rfId, apolloId: scored[0].person.id });
		return null;
	}

	log({ message: `[fallback] winner: apolloId=${scored[0].person.id} confidence=${scored[0].confidence}%`, rfId });
	return scored[0].person;
}

/**
 * STUBBED 2026-05-10. The underlying `addRFCandidateNote` RF client helper
 * was repurposed for the new MCP write-tool surface, which requires explicit
 * `createdBy` attribution. The Apollo-enrichment-failure note path historically
 * inherited a hardcoded Joel attribution, which is the wrong long-term answer
 * (probably should be the candidate's lead owner). Apollo enrichment failures
 * are rare; the callers below still invoke this stub so the flow continues
 * without crashing, but no note is posted.
 *
 * TODO: refactor with proper attribution, or remove the call sites entirely.
 */
async function safeAddNote(rfId, env) {
	logError({ message: `[enrich] safeAddNote STUBBED — would have posted Apollo failure note`, rfId });
}
