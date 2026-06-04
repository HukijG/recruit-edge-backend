/**
 * End-to-end tests for the full candidate pipeline.
 *
 * These tests exercise the actual middleware flow through worker.fetch(),
 * with external APIs (RF, Dialpad, Apollo) mocked via globalThis.fetch
 * and Workers AI mocked where needed.
 *
 * KV (SYNC_STATE) uses the real test binding from cloudflare:test.
 */

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { ensureAccessJwksFixture, mintAccessJwt } from './helpers/access-jwt-mint.js';
import { _resetCacheForTests } from '../src/users.js';
import worker from '../src';

beforeAll(async () => {
	await ensureAccessJwksFixture();
});

beforeEach(async () => {
	await applyUsersMigration(env);
	_resetCacheForTests();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

/** Route-based mock for globalThis.fetch — intercepts external API calls */
function mockFetch(routes) {
	const calls = [];
	globalThis.fetch = async (url, opts) => {
		const urlStr = typeof url === 'string' ? url : url.toString();
		calls.push({ url: urlStr, opts });
		for (const route of routes) {
			if (urlStr.includes(route.match)) {
				if (typeof route.response === 'function') {
					return route.response(urlStr, opts);
				}
				return new Response(JSON.stringify(route.response), {
					status: route.status || 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}
		console.warn(`[mock] Unmocked fetch: ${urlStr}`);
		return new Response(JSON.stringify({ error: 'unmocked' }), { status: 500 });
	};
	return calls;
}

/** Build an RF webhook payload (matching real RF webhook structure) */
function buildRFWebhookPayload(candidateOverrides = {}) {
	return {
		event_time: '2026-03-30T15:08:04+0000',
		candidate: {
			id: 12345,
			rf_link: 'https://recruiterflow.com/prospect/12345',
			name: 'Jane Doe',
			first_name: 'Tony',
			last_name: 'Doe',
			email: 'tony@example.com',
			phone_number: '',
			current_organization: 'Datadog',
			current_title: 'Premier Support Engineer 3',
			location: {
				name: 'Winchendon, Massachusetts, United States',
				city: 'Winchendon',
				state: 'Massachusetts',
				country: 'United States',
			},
			linkedin_profile: 'https://www.linkedin.com/in/jane-doe-000000000',
			lead_owner: { name: 'Joel Haines', email: 'owner@example.com' },
			added_by: { name: 'Joel Haines', email: 'owner@example.com' },
			source: 'LinkedIn',
			tags: '',
			skills: '',
			...candidateOverrides,
		},
		job: {
			id: 980,
			name: 'Senior Support Engineer',
			title: 'Senior Support Engineer',
			company: { name: 'Eon.io', id: 6325 },
		},
		from_stage: 'Sourced',
		to_stage: 'Sourced',
	};
}

/** Build a full RF candidate GET response (matching real getRFCandidate structure) */
function buildFullRFCandidate(overrides = {}) {
	return {
		id: 12345,
		first_name: 'Tony',
		last_name: 'Doe',
		name: 'Jane Doe',
		current_organization: 'Datadog',
		current_designation: 'Premier Support Engineer 3',
		linkedin_profile: 'https://www.linkedin.com/in/jane-doe-000000000',
		email: [],
		phone_number: [],
		location: {
			city: 'Winchendon',
			state: 'Massachusetts',
			country: 'United States',
		},
		education: [
			{ school: 'Worcester Polytechnic Institute', degree: 'B.S.', specialization: 'Computer Science' },
		],
		experience: [
			{ designation: 'Premier Support Engineer 3', organization: 'Datadog', rank: 1 },
			{ designation: 'Support Engineer', organization: 'PTC', rank: 2 },
		],
		jobs: [
			{
				job_id: 980,
				stage_name: 'Sourced',
				stage_moved: '2026-03-30T15:08:04+0000',
				added_to_job_by: { id: 900001, name: 'Joel Haines' },
				stages: [
					{ id: 17985, name: 'Sourced', rank: 1 },
					{ id: 17986, name: 'Applied', rank: 2 },
					{ id: 17987, name: 'Replied', rank: 3 },
					{ id: 17988, name: 'Replied (Cold)', rank: 4 },
					{ id: 17989, name: 'Call Booked', rank: 5 },
				],
			},
		],
		...overrides,
	};
}

/** Create a valid HS256 JWT for Dialpad webhook auth */
async function createDialpadJWT(payload) {
	const secret = new TextEncoder().encode(env.DIALPAD_WEBHOOK_SECRET);
	return await new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256' })
		.sign(secret);
}

/** Standard RF API route that returns a full candidate for GET /candidate/get */
function rfGetCandidateRoute(fullCandidate) {
	return {
		match: '/candidate/get',
		response: { candidate: fullCandidate },
	};
}

/** Standard RF API route that succeeds for POST /candidate/update */
function rfUpdateCandidateRoute() {
	return {
		match: '/candidate/update',
		response: { success: true },
	};
}

/** Standard RF API route for POST /candidate/notes/add */
function rfAddNoteRoute() {
	return {
		match: '/candidate/notes/add',
		response: { success: true },
	};
}

/** Standard RF API route for POST /candidate/search */
function rfSearchRoute(candidates = []) {
	return {
		match: '/candidate/search',
		response: candidates,
	};
}

/** Standard RF API route for POST /candidate/move-to-stage */
function rfMoveStageRoute() {
	return {
		match: '/candidate/move-to-stage',
		response: { success: true },
	};
}

/** Standard Dialpad API route that succeeds for PUT /contacts */
function dialpadContactRoute() {
	return {
		match: 'dialpad.com/api/v2/contacts',
		response: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF12345' },
	};
}

/** Get fetch calls matching a URL pattern */
function findCalls(calls, pattern) {
	return calls.filter(c => c.url.includes(pattern));
}


// ---------------------------------------------------------------------------
// RF → Dialpad: Created event (no enrichment — not Joel's candidate)
// ---------------------------------------------------------------------------

describe('E2E: RF → Dialpad (Created, not Joel candidate)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('syncs candidate to Dialpad and caches when not Joel candidate', async () => {
		const fullCandidate = buildFullRFCandidate({
			jobs: [{
				job_id: 980,
				stage_name: 'Sourced',
				stage_moved: '2026-03-30T15:08:04+0000',
				added_to_job_by: { id: 999999, name: 'Other User' },
				stages: [{ id: 17985, name: 'Sourced', rank: 1 }],
			}],
		});

		const calls = mockFetch([
			rfGetCandidateRoute(fullCandidate),
			dialpadContactRoute(),
		]);

		const payload = buildRFWebhookPayload();
		const request = new Request('http://example.com/webhook/recruiterflow', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-RF-Webhook-Token': env.RF_WEBHOOK_SECRET,
				'RF-Event-Type': 'Created',
			},
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Dialpad GET + PATCH should have been called
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(1);

		// Apollo should NOT have been called (not Joel's candidate)
		const apolloCalls = findCalls(calls, 'apollo.io');
		expect(apolloCalls.length).toBe(0);

		// Cache should be populated
		const cached = await env.SYNC_STATE.get('candidate:12345');
		expect(cached).not.toBeNull();
		const cachedData = JSON.parse(cached);
		expect(cachedData.first_name).toBe('Tony');

		// Debounce flag should be set
		const debounce = await env.SYNC_STATE.get('sync:RF12345');
		expect(debounce).toBe('true');
	});
});


// ---------------------------------------------------------------------------
// RF → Dialpad: Created event + Apollo enrichment (Joel's candidate)
// ---------------------------------------------------------------------------

describe('E2E: RF → Dialpad (Created, Joel candidate, enrichment)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('enriches Joel candidate via Apollo before Dialpad sync', async () => {
		const fullCandidate = buildFullRFCandidate({ phone_number: [] });

		const apolloPerson = {
			id: 'apollo-123',
			first_name: 'Tony',
			last_name: 'Doe',
			title: 'Premier Support Engineer 3',
			linkedin_url: 'https://www.linkedin.com/in/jane-doe-000000000',
			organization: { name: 'Datadog' },
		};

		const calls = mockFetch([
			rfGetCandidateRoute(fullCandidate),
			{
				match: 'apollo.io/api/v1/people/match',
				response: (url, opts) => {
					const body = JSON.parse(opts.body);
					return new Response(JSON.stringify({ person: apolloPerson }), { status: 200 });
				},
			},
			dialpadContactRoute(),
		]);

		const payload = buildRFWebhookPayload({ phone_number: '' });
		const request = new Request('http://example.com/webhook/recruiterflow', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-RF-Webhook-Token': env.RF_WEBHOOK_SECRET,
				'RF-Event-Type': 'Created',
			},
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Apollo enrichment should have been called (at least LinkedIn lookup + phone reveal)
		const apolloCalls = findCalls(calls, 'apollo.io');
		expect(apolloCalls.length).toBeGreaterThanOrEqual(2);

		// Dialpad GET + PATCH should be called
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(1);

		// Enrichment dedup KV should be set
		const enrichKey = await env.SYNC_STATE.get('apollo_enrich:12345');
		expect(enrichKey).not.toBeNull();
	});

	it('skips enrichment when candidate already has phone number', async () => {
		const fullCandidate = buildFullRFCandidate({
			phone_number: ['+15555550100'],
		});

		const calls = mockFetch([
			rfGetCandidateRoute(fullCandidate),
			dialpadContactRoute(),
		]);

		const payload = buildRFWebhookPayload({ phone_number: '+15555550100' });
		const request = new Request('http://example.com/webhook/recruiterflow', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-RF-Webhook-Token': env.RF_WEBHOOK_SECRET,
				'RF-Event-Type': 'Created',
			},
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Apollo should NOT be called — phone already exists
		const apolloCalls = findCalls(calls, 'apollo.io');
		expect(apolloCalls.length).toBe(0);
	});
});


// ---------------------------------------------------------------------------
// RF → Dialpad: Updated event (no enrichment)
// ---------------------------------------------------------------------------

describe('E2E: RF → Dialpad (Updated)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('syncs Updated event to Dialpad without enrichment', async () => {
		const calls = mockFetch([
			dialpadContactRoute(),
		]);

		const payload = buildRFWebhookPayload();
		const request = new Request('http://example.com/webhook/recruiterflow', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-RF-Webhook-Token': env.RF_WEBHOOK_SECRET,
				'RF-Event-Type': 'Updated',
			},
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Dialpad GET + PATCH called
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(1);

		// Apollo NOT called (Updated, not Created)
		const apolloCalls = findCalls(calls, 'apollo.io');
		expect(apolloCalls.length).toBe(0);

		// No RF API calls needed for Updated (no enrichment)
		const rfGetCalls = findCalls(calls, '/candidate/get');
		expect(rfGetCalls.length).toBe(0);
	});
});


// ---------------------------------------------------------------------------
// RF → Dialpad: Validation skip (missing required fields)
// ---------------------------------------------------------------------------

describe('E2E: RF → Dialpad (validation skip)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('caches candidate but skips Dialpad when missing org/title', async () => {
		const calls = mockFetch([]);

		const payload = buildRFWebhookPayload({
			current_organization: '',
			current_title: '',
		});

		const request = new Request('http://example.com/webhook/recruiterflow', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-RF-Webhook-Token': env.RF_WEBHOOK_SECRET,
				'RF-Event-Type': 'Updated',
			},
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Dialpad should NOT be called
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(0);

		// Candidate should still be cached
		const cached = await env.SYNC_STATE.get('candidate:12345');
		expect(cached).not.toBeNull();
	});
});


// ---------------------------------------------------------------------------
// Manual RF webhook → Dialpad (always enriches)
// ---------------------------------------------------------------------------

describe('E2E: Manual RF webhook', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('always enriches on manual webhook regardless of ownership', async () => {
		const fullCandidate = buildFullRFCandidate({
			phone_number: [],
			jobs: [{
				job_id: 980,
				stage_name: 'Sourced',
				added_to_job_by: { id: 999999, name: 'Other User' },
				stages: [],
			}],
		});

		const apolloPerson = {
			id: 'apollo-456',
			first_name: 'Tony',
			last_name: 'Doe',
			title: 'Premier Support Engineer 3',
			linkedin_url: 'https://www.linkedin.com/in/jane-doe-000000000',
			organization: { name: 'Datadog' },
		};

		const calls = mockFetch([
			rfGetCandidateRoute(fullCandidate),
			{
				match: 'apollo.io/api/v1/people/match',
				response: { person: apolloPerson },
			},
			dialpadContactRoute(),
		]);

		const candidate = buildRFWebhookPayload({ phone_number: '' }).candidate;
		const request = new Request(
			`http://example.com/webhook/recruiterflow/manual?token=${env.RF_WEBHOOK_SECRET}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(candidate),
			}
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Apollo enrichment should run (manual always enriches)
		const apolloCalls = findCalls(calls, 'apollo.io');
		expect(apolloCalls.length).toBeGreaterThanOrEqual(1);

		// Dialpad GET + PATCH should be called
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(1);
	});
});


// ---------------------------------------------------------------------------
// Dialpad → RF: Updated event (happy path)
// ---------------------------------------------------------------------------

describe('E2E: Dialpad → RF (Updated)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('syncs contact changes from Dialpad to RF', async () => {
		const calls = mockFetch([
			rfUpdateCandidateRoute(),
		]);

		// Pre-seed cache so the handler can merge
		await env.SYNC_STATE.put('candidate:12345', JSON.stringify({
			id: 12345,
			first_name: 'Jane',
			last_name: 'Smith',
			email: 'jane@old.com',
			emails: [],
			phone_number: '',
			linkedin_profile: '',
			current_organization: 'Acme',
			current_title: 'Engineer',
		}));

		// Make sure NO debounce flag exists
		await env.SYNC_STATE.delete('sync:RF12345');

		const dialpadPayload = {
			event: 'Updated',
			contact: {
				id: 'shared_contact_pool_Company:0000000000000000_uid_RF12345',
				display_name: 'Jane Smith',
				first_name: 'Jane',
				last_name: 'Smith',
				phones: ['+15551234567'],
				emails: ['jane@new.com'],
				urls: ['https://linkedin.com/in/janesmith'],
				company_name: 'Acme',
				job_title: 'Engineer',
			},
		};

		const jwt = await createDialpadJWT(dialpadPayload);

		const request = new Request('http://example.com/webhook/dialpad', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${jwt}`,
			},
			body: jwt,
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// RF update should have been called
		const rfCalls = findCalls(calls, '/candidate/update');
		expect(rfCalls.length).toBe(1);

		// Verify the update payload has the new data
		const updateBody = JSON.parse(rfCalls[0].opts.body);
		expect(updateBody.id).toBe(12345);

		// Debounce should now be set (prevent echo back)
		const debounce = await env.SYNC_STATE.get('sync:RF12345');
		expect(debounce).toBe('true');
	});
});


// ---------------------------------------------------------------------------
// Dialpad → RF: Debounced (RF just synced, skip reverse)
// ---------------------------------------------------------------------------

describe('E2E: Dialpad → RF (debounced)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('skips RF update when debounce flag is active', async () => {
		const calls = mockFetch([]);

		// Pre-seed debounce flag (simulates RF→Dialpad sync just happened)
		await env.SYNC_STATE.put('sync:RF12345', 'true', { expirationTtl: 60 });

		const dialpadPayload = {
			event: 'Updated',
			contact: {
				id: 'shared_contact_pool_Company:0000000000000000_uid_RF12345',
				display_name: 'Jane Smith',
				first_name: 'Jane',
				last_name: 'Smith',
				phones: ['+15551234567'],
				emails: ['jane@new.com'],
				urls: [],
			},
		};

		const jwt = await createDialpadJWT(dialpadPayload);

		const request = new Request('http://example.com/webhook/dialpad', {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${jwt}` },
			body: jwt,
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// RF update should NOT have been called
		const rfCalls = findCalls(calls, '/candidate/update');
		expect(rfCalls.length).toBe(0);
	});
});


// ---------------------------------------------------------------------------
// Dialpad → RF: Created event (ignored)
// ---------------------------------------------------------------------------

describe('E2E: Dialpad → RF (Created ignored)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('ignores Dialpad Created events (echo of RF sync)', async () => {
		const calls = mockFetch([]);

		const dialpadPayload = {
			event: 'Created',
			contact: {
				id: 'shared_contact_pool_Company:0000000000000000_uid_RF12345',
				display_name: 'Jane Smith',
			},
		};

		const jwt = await createDialpadJWT(dialpadPayload);

		const request = new Request('http://example.com/webhook/dialpad', {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${jwt}` },
			body: jwt,
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Nothing should be called
		expect(calls.length).toBe(0);
	});
});


// ---------------------------------------------------------------------------
// Calendar → RF + Dialpad (full E2E with LinkedIn cache lookup)
// ---------------------------------------------------------------------------

describe('E2E: Calendar → RF + Dialpad', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('merges email, moves stage, upserts Dialpad on booking event', async () => {
		const fullCandidate = buildFullRFCandidate({
			email: [{ email: 'tony@personal.com', is_primary: 1 }],
			phone_number: [],
		});

		const calls = mockFetch([
			rfGetCandidateRoute(fullCandidate),
			rfUpdateCandidateRoute(),
			rfMoveStageRoute(),
			dialpadContactRoute(),
		]);

		// Pre-seed LinkedIn cache entry
		await env.SYNC_STATE.put(
			'linkedin:linkedin.com/in/jane-doe-000000000',
			'12345'
		);

		const calendarPayload = {
			event_id: 'cal-123',
			event_title: 'Call with Tony',
			event_start: '2026-03-31T14:00:00Z',
			attendee_email: 'tony@work.com',
			attendee_name: 'Jane Doe',
			linkedin_answer: 'https://www.linkedin.com/in/jane-doe-000000000',
			phone_number: '+15555550100',
		};

		const request = new Request('http://example.com/webhook/calendar', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Calendar-Webhook-Token': env.CALENDAR_WEBHOOK_SECRET,
			},
			body: JSON.stringify(calendarPayload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// RF candidate should be fetched
		const rfGetCalls = findCalls(calls, '/candidate/get');
		expect(rfGetCalls.length).toBe(1);

		// RF update called (new email + phone merge)
		const rfUpdateCalls = findCalls(calls, '/candidate/update');
		expect(rfUpdateCalls.length).toBe(1);
		const updateBody = JSON.parse(rfUpdateCalls[0].opts.body);
		// Should include merged emails (existing + new)
		expect(updateBody.email.length).toBe(2);
		expect(updateBody.email[1].email).toBe('tony@work.com');
		// Should include phone
		expect(updateBody.phone_number.length).toBe(1);

		// Stage movement should be called (candidate is in Sourced)
		const moveCalls = findCalls(calls, '/candidate/move-to-stage');
		expect(moveCalls.length).toBe(1);

		// Dialpad GET + PATCH should be called
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(1);
	});

	it('matches via LinkedIn cache when linkedin_answer lacks protocol', async () => {
		// Reclaim form input where the candidate typed a protocol-less
		// LinkedIn URL (e.g. "Linkedin.com/in/foo"). Should still resolve to
		// the same cached candidate as the full https://www.linkedin.com/... form.
		const fullCandidate = buildFullRFCandidate({
			email: [{ email: 'tony@personal.com', is_primary: 1 }],
			phone_number: [],
		});

		const calls = mockFetch([
			rfGetCandidateRoute(fullCandidate),
			rfUpdateCandidateRoute(),
			rfMoveStageRoute(),
			dialpadContactRoute(),
		]);

		await env.SYNC_STATE.put(
			'linkedin:linkedin.com/in/jane-doe-000000000',
			'12345'
		);

		const calendarPayload = {
			event_id: 'cal-456',
			event_title: 'Call with Tony',
			event_start: '2026-03-31T14:00:00Z',
			attendee_email: 'tony@work.com',
			attendee_name: 'Tony',
			linkedin_answer: 'Linkedin.com/in/jane-doe-000000000',
			phone_number: '+15555550100',
		};

		const request = new Request('http://example.com/webhook/calendar', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Calendar-Webhook-Token': env.CALENDAR_WEBHOOK_SECRET,
			},
			body: JSON.stringify(calendarPayload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Cache hit → RF GET to read current candidate
		const rfGetCalls = findCalls(calls, '/candidate/get');
		expect(rfGetCalls.length).toBe(1);

		// RF update + stage move + Dialpad upsert all run
		const rfUpdateCalls = findCalls(calls, '/candidate/update');
		expect(rfUpdateCalls.length).toBe(1);
		const moveCalls = findCalls(calls, '/candidate/move-to-stage');
		expect(moveCalls.length).toBe(1);
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(1);
	});

	it('skips when no candidate found via any lookup tier', async () => {
		const calls = mockFetch([
			rfSearchRoute([]), // LinkedIn search returns nothing
		]);

		const calendarPayload = {
			attendee_email: 'unknown@example.com',
			attendee_name: 'Unknown Person',
			linkedin_answer: 'https://www.linkedin.com/in/nobody-here',
		};

		const request = new Request('http://example.com/webhook/calendar', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Calendar-Webhook-Token': env.CALENDAR_WEBHOOK_SECRET,
			},
			body: JSON.stringify(calendarPayload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// No RF update or Dialpad calls
		const rfUpdateCalls = findCalls(calls, '/candidate/update');
		expect(rfUpdateCalls.length).toBe(0);
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(0);
	});

	it('finds candidate via email cache when LinkedIn not provided', async () => {
		const fullCandidate = buildFullRFCandidate({
			email: [{ email: 'tony@cached.com', is_primary: 1 }],
		});

		const calls = mockFetch([
			rfGetCandidateRoute(fullCandidate),
			rfMoveStageRoute(),
			dialpadContactRoute(),
		]);

		// Pre-seed email cache
		await env.SYNC_STATE.put('email:tony@cached.com', '12345');

		const calendarPayload = {
			attendee_email: 'tony@cached.com',
			attendee_name: 'Jane Doe',
		};

		const request = new Request('http://example.com/webhook/calendar', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Calendar-Webhook-Token': env.CALENDAR_WEBHOOK_SECRET,
			},
			body: JSON.stringify(calendarPayload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Should have found candidate and called RF GET
		const rfGetCalls = findCalls(calls, '/candidate/get');
		expect(rfGetCalls.length).toBe(1);

		// Dialpad GET + PATCH should run
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(1);
	});
});


// ---------------------------------------------------------------------------
// Krisp → RF (meeting notes)
// ---------------------------------------------------------------------------

describe('E2E: Krisp → RF (meeting notes)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('adds meeting notes to RF candidate via email lookup, attributed to the consultant', async () => {
		const calls = mockFetch([
			rfAddNoteRoute(),
		]);

		// Pre-seed email cache
		await env.SYNC_STATE.put('email:candidate@example.com', '12345');

		// Clear any previous dedup key
		await env.SYNC_STATE.delete('krisp:meeting-001');

		const krispPayload = {
			event: 'note_generated',
			data: {
				meeting: {
					id: 'meeting-001',
					title: 'Call with Tony',
					url: 'https://krisp.ai/meeting/001',
					start_date: '2026-03-30T14:00:00Z',
					duration: 1800,
					participants: [
						// Joel resolves via krisp_emails (0004) → consultant; candidate does not.
						{ email: 'owner@example.com', id: 'acct-1', first_name: 'Joel', last_name: 'Haines' },
						{ email: 'candidate@example.com', id: null, first_name: null, last_name: null },
					],
				},
				raw_content: '## **Summary**\n\n- Discussed the role at Eon.io.\n\n## **Action Items**\n\n- Send CV by Friday.',
			},
		};

		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Krisp-Webhook-Token': env.KRISP_WEBHOOK_SECRET,
			},
			body: JSON.stringify(krispPayload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Note should have been posted to RF, attributed to Joel (rf_user_id 900001).
		const noteCalls = findCalls(calls, '/candidate/notes/add');
		expect(noteCalls.length).toBe(1);
		const noteBody = JSON.parse(noteCalls[0].opts.body);
		expect(noteBody.created_by).toBe(900001);
		expect(noteBody.id).toBe(12345);

		// Dedup flag should now be set
		const dedup = await env.SYNC_STATE.get('krisp:meeting-001');
		expect(dedup).toBe('true');
	});

	it('returns 500 and does NOT write the dedup flag when the RF note post fails', async () => {
		const calls = mockFetch([
			{ match: '/candidate/notes/add', response: { error: 'rf boom' }, status: 502 },
		]);

		await env.SYNC_STATE.put('email:candidate@example.com', '12345');
		await env.SYNC_STATE.delete('krisp:meeting-fail');

		const krispPayload = {
			event: 'note_generated',
			data: {
				meeting: {
					id: 'meeting-fail',
					title: 'Call with Tony',
					url: 'https://krisp.ai/meeting/fail',
					start_date: '2026-03-30T14:00:00Z',
					duration: 1800,
					participants: [
						{ email: 'owner@example.com', id: 'acct-1', first_name: 'Joel' },
						{ email: 'candidate@example.com', id: null, first_name: null },
					],
				},
				raw_content: '## **Summary**\n\n- Discussed the role.',
			},
		};

		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Krisp-Webhook-Token': env.KRISP_WEBHOOK_SECRET,
			},
			body: JSON.stringify(krispPayload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// Note post threw → handler's catch returns 500 so Krisp retries.
		expect(response.status).toBe(500);
		// Dedup flag must NOT be written (at-least-once: the retry re-attempts).
		const dedup = await env.SYNC_STATE.get('krisp:meeting-fail');
		expect(dedup).toBeNull();
	});

	it('skips duplicate meeting (dedup flag already set)', async () => {
		const calls = mockFetch([]);

		// Pre-seed dedup flag
		await env.SYNC_STATE.put('krisp:meeting-002', 'true');

		const krispPayload = {
			event: 'note_generated',
			data: {
				meeting: { id: 'meeting-002', title: 'Duplicate' },
				raw_content: '## **Summary**\n\n- test',
			},
		};

		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Krisp-Webhook-Token': env.KRISP_WEBHOOK_SECRET,
			},
			body: JSON.stringify(krispPayload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// No RF calls should be made
		expect(calls.length).toBe(0);
	});

	it('searches RF by email when not in cache', async () => {
		const searchResult = {
			id: 12345,
			first_name: 'Tony',
			last_name: 'Doe',
			email: [{ email: 'tony@new.com', is_primary: 1 }],
		};

		const calls = mockFetch([
			rfSearchRoute([searchResult]),
			rfAddNoteRoute(),
		]);

		// No email cache pre-seeded — should fall through to search
		await env.SYNC_STATE.delete('email:tony@new.com');

		const krispPayload = {
			event: 'note_generated',
			data: {
				meeting: {
					id: 'meeting-003',
					title: 'Call',
					url: 'https://krisp.ai/meeting/003',
					start_date: '2026-03-30T14:00:00Z',
					duration: 900,
					participants: [
						{ email: 'owner@example.com', id: 'acct-1', first_name: 'Joel', last_name: 'Haines' },
						{ email: 'tony@new.com', id: null, first_name: null, last_name: null },
					],
				},
				raw_content: '## **Summary**\n\n- Great call.',
			},
		};

		await env.SYNC_STATE.delete('krisp:meeting-003');

		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Krisp-Webhook-Token': env.KRISP_WEBHOOK_SECRET,
			},
			body: JSON.stringify(krispPayload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// RF search should have been called
		const searchCalls = findCalls(calls, '/candidate/search');
		expect(searchCalls.length).toBe(1);

		// Note should have been posted
		const noteCalls = findCalls(calls, '/candidate/notes/add');
		expect(noteCalls.length).toBe(1);
	});

	it('attributes the note to the owner (Joel) when no consultant resolves', async () => {
		const calls = mockFetch([
			rfAddNoteRoute(),
		]);

		await env.SYNC_STATE.put('email:candidate@example.com', '12345');
		await env.SYNC_STATE.delete('krisp:meeting-unreg');

		const krispPayload = {
			event: 'note_generated',
			data: {
				meeting: {
					id: 'meeting-unreg',
					title: 'Call hosted by an unregistered consultant',
					url: 'https://krisp.ai/meeting/unreg',
					start_date: '2026-03-30T14:00:00Z',
					duration: 1800,
					participants: [
						// Consultant: account-holder shape (id/first_name) but email NOT registered.
						{ email: 'unregistered.consultant@krisp.example', id: 'acct-9', first_name: 'Alice', last_name: 'X' },
						// Candidate: guest shape.
						{ email: 'candidate@example.com', id: null, first_name: null, last_name: null },
					],
				},
				raw_content: '## **Summary**\n\n- Discussed the role.',
			},
		};

		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Krisp-Webhook-Token': env.KRISP_WEBHOOK_SECRET,
			},
			body: JSON.stringify(krispPayload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Note posted to the candidate, attributed to the owner (Joel, 900001) via fallback.
		const noteCalls = findCalls(calls, '/candidate/notes/add');
		expect(noteCalls.length).toBe(1);
		const noteBody = JSON.parse(noteCalls[0].opts.body);
		expect(noteBody.created_by).toBe(900001);
		expect(noteBody.id).toBe(12345);
	});
});


// ---------------------------------------------------------------------------
// Apollo webhook → phone delivery
// ---------------------------------------------------------------------------

describe('E2E: Apollo webhook (phone delivery)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('delivers phone from Apollo to RF + Dialpad and updates cache', async () => {
		const calls = mockFetch([
			rfGetCandidateRoute(buildFullRFCandidate({ phone_number: [] })),
			rfUpdateCandidateRoute(),
			dialpadContactRoute(),
		]);

		// Pre-seed the enrichment context (set during initial enrichment)
		await env.SYNC_STATE.put('apollo_enrich:12345', JSON.stringify({
			apolloPersonId: 'apollo-123',
			correctedLinkedIn: null,
			timestamp: new Date().toISOString(),
		}), { expirationTtl: 900 });

		// Pre-seed cache so the handler can update it
		await env.SYNC_STATE.put('candidate:12345', JSON.stringify({
			id: 12345,
			first_name: 'Tony',
			last_name: 'Doe',
			current_organization: 'Datadog',
			current_title: 'Premier Support Engineer 3',
			linkedin_profile: 'https://www.linkedin.com/in/jane-doe-000000000',
			email: 'tony@example.com',
			phone_number: '',
		}));

		const apolloWebhookPayload = {
			people: [{
				id: 'apollo-123',
				status: 'success',
				phone_numbers: [
					{ sanitized_number: '+15555550100', status_cd: 'valid_number', raw_number: '(978) 555-0146' },
				],
			}],
		};

		const request = new Request(
			`http://example.com/webhook/apollo?token=${env.APOLLO_WEBHOOK_SECRET}&rfId=12345`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(apolloWebhookPayload),
			}
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// RF should be called: GET (to merge phones) + UPDATE (with merged phone array)
		const rfCalls = findCalls(calls, 'recruiterflow.com');
		const rfGetCalls = rfCalls.filter(c => c.url.includes('/candidate/get'));
		const rfUpdateCalls = rfCalls.filter(c => c.url.includes('/candidate/update'));
		expect(rfGetCalls.length).toBe(1);
		expect(rfUpdateCalls.length).toBe(1);
		const rfUpdateBody = JSON.parse(rfUpdateCalls[0].opts.body);
		expect(rfUpdateBody.phone_number).toEqual([{ phone_number: '+15555550100', type: 1 }]);

		// Dialpad PATCH should only contain the phone — nothing else
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(1);
		const dialpadBody = JSON.parse(dialpadCalls[0].opts.body);
		expect(dialpadBody).toEqual({ phones: ['+15555550100'] });

		// Cache should be updated with phone
		const cached = await env.SYNC_STATE.get('candidate:12345');
		expect(cached).not.toBeNull();
		const cachedData = JSON.parse(cached);
		expect(cachedData.phone_number).toBe('+15555550100');
	});

	it('delivers the phone even when the enrichment context is gone (late Apollo delivery)', async () => {
		// Regression (rfId 52662, 2026-06-03): Apollo's phone-reveal webhook is delivered
		// asynchronously with an unbounded lag (observed ~45min) — long after the short-lived
		// apollo_enrich:* request flag has expired. The phone MUST still be written to RF +
		// Dialpad; delivery is never gated on that flag.
		const calls = mockFetch([
			rfGetCandidateRoute(buildFullRFCandidate({ phone_number: [] })),
			rfUpdateCandidateRoute(),
			dialpadContactRoute(),
		]);

		// Make the "context absent" precondition explicit so it holds regardless of any KV
		// state left by earlier tests (SYNC_STATE is the shared real binding).
		await env.SYNC_STATE.delete('apollo_enrich:12345');

		const apolloWebhookPayload = {
			people: [{
				id: 'apollo-456',
				status: 'success',
				phone_numbers: [{ sanitized_number: '+15555550100', status_cd: 'valid_number', raw_number: '(978) 555-0146' }],
			}],
		};

		const request = new Request(
			`http://example.com/webhook/apollo?token=${env.APOLLO_WEBHOOK_SECRET}&rfId=12345`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(apolloWebhookPayload),
			}
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// RF GET (merge) + UPDATE (new phone) both happen despite no pending context
		const rfUpdateCalls = findCalls(calls, 'recruiterflow.com').filter(c => c.url.includes('/candidate/update'));
		expect(rfUpdateCalls.length).toBe(1);
		expect(JSON.parse(rfUpdateCalls[0].opts.body).phone_number).toEqual([{ phone_number: '+15555550100', type: 1 }]);

		// Dialpad PATCH carries only the phone
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(1);
		expect(JSON.parse(dialpadCalls[0].opts.body)).toEqual({ phones: ['+15555550100'] });
	});

	it('returns 200 when no valid phone numbers in payload', async () => {
		const calls = mockFetch([]);

		await env.SYNC_STATE.put('apollo_enrich:12345', JSON.stringify({
			apolloPersonId: 'apollo-123',
		}), { expirationTtl: 900 });

		const apolloWebhookPayload = {
			people: [{ id: 'apollo-123', status: 'success', phone_numbers: [{ sanitized_number: '+10000000000', status_cd: 'invalid_number' }] }],
		};

		const request = new Request(
			`http://example.com/webhook/apollo?token=${env.APOLLO_WEBHOOK_SECRET}&rfId=12345`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(apolloWebhookPayload),
			}
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// No Dialpad or RF calls
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(0);
	});
});


// ---------------------------------------------------------------------------
// Dialpad Calls → Cold call detection
// ---------------------------------------------------------------------------

describe('E2E: Dialpad Calls (cold call detection)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('detects cold call and creates RF activity', async () => {
		const calls = mockFetch([
			{
				match: '/custom-activity/create',
				response: { success: true },
			},
			rfUpdateCandidateRoute(),
		]);

		// Clear dedup
		await env.SYNC_STATE.delete('coldcall:call-001');

		const callPayload = {
			call_id: 'call-001',
			target: { id: 8000000000000001 },  // Joel's Dialpad ID
			contact: {
				id: 'shared_contact_pool_Company:0000000000000000_uid_RF12345',
				name: 'Jane Doe',
			},
			direction: 'outbound',
			state: 'transcription',
			transcription_text: 'Hi Tony, this is Joel from Cognatio Solutions calling about the Senior Support Engineer position...',
			date_started: 1711814884,
			duration: 120,
		};

		const jwt = await createDialpadJWT(callPayload);

		const request = new Request('http://example.com/webhook/dialpad/calls', {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${jwt}` },
			body: jwt,
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Dedup flag should be set (before AI call)
		const dedup = await env.SYNC_STATE.get('coldcall:call-001');
		expect(dedup).toBe('true');
	});

	it('skips call when contact has no RF ID', async () => {
		const calls = mockFetch([]);

		const callPayload = {
			call_id: 'call-002',
			target: { id: 8000000000000001 },
			contact: {
				id: 'some-random-contact-id',  // No RF ID
				name: '(650) 521-2531',
			},
			direction: 'outbound',
			state: 'transcription',
			transcription_text: 'Left a voicemail...',
			date_started: 1711814884,
		};

		const jwt = await createDialpadJWT(callPayload);

		const request = new Request('http://example.com/webhook/dialpad/calls', {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${jwt}` },
			body: jwt,
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// No external calls — just skipped
		expect(calls.length).toBe(0);
	});

	it('skips non-Joel calls', async () => {
		const calls = mockFetch([]);

		const callPayload = {
			call_id: 'call-003',
			target: { id: 9999999999 },  // Not Joel
			contact: { id: 'uid_RF12345', name: 'Tony' },
			direction: 'outbound',
			state: 'transcription',
			transcription_text: 'test',
		};

		const jwt = await createDialpadJWT(callPayload);

		const request = new Request('http://example.com/webhook/dialpad/calls', {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${jwt}` },
			body: jwt,
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// No external calls
		expect(calls.length).toBe(0);
	});

	it('skips inbound calls', async () => {
		const calls = mockFetch([]);

		const callPayload = {
			call_id: 'call-004',
			target: { id: 8000000000000001 },
			contact: { id: 'uid_RF12345', name: 'Tony' },
			direction: 'inbound',
			state: 'transcription',
			transcription_text: 'test',
		};

		const jwt = await createDialpadJWT(callPayload);

		const request = new Request('http://example.com/webhook/dialpad/calls', {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${jwt}` },
			body: jwt,
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(calls.length).toBe(0);
	});

	it('skips duplicate calls via dedup flag', async () => {
		const calls = mockFetch([]);

		// Pre-seed dedup flag
		await env.SYNC_STATE.put('coldcall:call-005', 'true');

		const callPayload = {
			call_id: 'call-005',
			target: { id: 8000000000000001 },
			contact: {
				id: 'shared_contact_pool_Company:0000000000000000_uid_RF12345',
				name: 'Tony',
			},
			direction: 'outbound',
			state: 'transcription',
			transcription_text: 'test',
		};

		const jwt = await createDialpadJWT(callPayload);

		const request = new Request('http://example.com/webhook/dialpad/calls', {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${jwt}` },
			body: jwt,
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// No AI or RF calls (dedup skipped)
		expect(calls.length).toBe(0);
	});
});


// ---------------------------------------------------------------------------
// Loop prevention: RF→Dialpad→RF cycle
// ---------------------------------------------------------------------------

describe('E2E: Loop prevention', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('RF sync sets debounce that blocks Dialpad reverse sync', async () => {
		// Step 1: RF Created webhook → Dialpad
		const calls1 = mockFetch([
			dialpadContactRoute(),
		]);

		const payload = buildRFWebhookPayload();
		const rfRequest = new Request('http://example.com/webhook/recruiterflow', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-RF-Webhook-Token': env.RF_WEBHOOK_SECRET,
				'RF-Event-Type': 'Updated',
			},
			body: JSON.stringify(payload),
		});

		const ctx1 = createExecutionContext();
		await worker.fetch(rfRequest, env, ctx1);
		await waitOnExecutionContext(ctx1);

		// Debounce should be set after RF sync
		const debounce = await env.SYNC_STATE.get('sync:RF12345');
		expect(debounce).toBe('true');

		// Step 2: Dialpad Updated webhook (the echo) → should be blocked
		const calls2 = mockFetch([]);

		const dialpadPayload = {
			event: 'Updated',
			contact: {
				id: 'shared_contact_pool_Company:0000000000000000_uid_RF12345',
				display_name: 'Jane Doe',
				phones: ['+15555550100'],
				emails: [],
				urls: [],
			},
		};

		const jwt = await createDialpadJWT(dialpadPayload);

		const dialpadRequest = new Request('http://example.com/webhook/dialpad', {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${jwt}` },
			body: jwt,
		});

		const ctx2 = createExecutionContext();
		await worker.fetch(dialpadRequest, env, ctx2);
		await waitOnExecutionContext(ctx2);

		// RF update should NOT be called — debounce blocked it
		const rfUpdateCalls = findCalls(calls2, '/candidate/update');
		expect(rfUpdateCalls.length).toBe(0);
	});
});


// ---------------------------------------------------------------------------
// Auth failures across all endpoints
// ---------------------------------------------------------------------------

describe('E2E: Auth failures', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('RF webhook: 401 with wrong token', async () => {
		const request = new Request('http://example.com/webhook/recruiterflow', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-RF-Webhook-Token': 'wrong-token',
				'RF-Event-Type': 'Created',
			},
			body: JSON.stringify(buildRFWebhookPayload()),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('Calendar webhook: 401 with wrong token', async () => {
		const request = new Request('http://example.com/webhook/calendar', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Calendar-Webhook-Token': 'wrong-token',
			},
			body: JSON.stringify({ attendee_email: 'test@test.com' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('Krisp webhook: 401 with wrong token', async () => {
		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Krisp-Webhook-Token': 'wrong-token',
			},
			body: JSON.stringify({ event: 'note_generated' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('Dialpad webhook: 401 with invalid JWT', async () => {
		const request = new Request('http://example.com/webhook/dialpad', {
			method: 'POST',
			headers: { 'Authorization': 'Bearer invalid-jwt-token' },
			body: 'invalid-jwt-token',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('Apollo webhook: 401 with wrong token', async () => {
		const request = new Request(
			'http://example.com/webhook/apollo?token=wrong&rfId=123',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			}
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('Dialpad calls webhook: 401 with invalid JWT', async () => {
		const request = new Request('http://example.com/webhook/dialpad/calls', {
			method: 'POST',
			headers: { 'Authorization': 'Bearer garbage' },
			body: 'garbage',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});
});


// ---------------------------------------------------------------------------
// Enrichment resilience: Apollo failure doesn't block Dialpad sync
// ---------------------------------------------------------------------------

describe('E2E: Enrichment resilience', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('Dialpad sync proceeds even when Apollo enrichment fails', async () => {
		const fullCandidate = buildFullRFCandidate({ phone_number: [] });

		const calls = mockFetch([
			rfGetCandidateRoute(fullCandidate),
			{
				match: 'apollo.io',
				status: 500,
				response: { error: 'Apollo is down' },
			},
			dialpadContactRoute(),
		]);

		const payload = buildRFWebhookPayload({ phone_number: '' });
		const request = new Request('http://example.com/webhook/recruiterflow', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-RF-Webhook-Token': env.RF_WEBHOOK_SECRET,
				'RF-Event-Type': 'Created',
			},
			body: JSON.stringify(payload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);

		// Apollo was called and failed
		const apolloCalls = findCalls(calls, 'apollo.io');
		expect(apolloCalls.length).toBeGreaterThanOrEqual(1);

		// Dialpad GET + PATCH should STILL be called (enrichment failure is non-fatal)
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(1);
	});
});

describe('E2E: /candidates with consultantFirstName', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('sets lead_owner_id to the consultant rfUserId when adding a new candidate', async () => {
		const calls = mockFetch([
			{ match: '/candidate/search', response: [] }, // RF search returns no match → create
			{ match: '/candidate/add', response: { data: { id: 99001 } } },
			{ match: 'dialpad.com/api/v2/contacts', response: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF99001' } },
			{ match: 'apollo.io/api/v1/people/match', response: { person: null } },
			{ match: '/job/list', response: [] },
		]);

		const request = new Request('http://example.com/candidates', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				candidates: [{
					linkedinUrl: 'https://www.linkedin.com/in/test-person-12345',
					fullName: 'Test Person',
					experience: [{ title: 'Engineer', company: 'Acme', startYear: 2020, isCurrent: true }],
				}],
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const addCalls = findCalls(calls, '/candidate/add');
		expect(addCalls).toHaveLength(1);
		const addBody = JSON.parse(addCalls[0].opts.body);
		expect(addBody.lead_owner_id).toBe(900001);
	});

	it('omits lead_owner_id when consultantFirstName is unknown', async () => {
		const calls = mockFetch([
			{ match: '/candidate/search', response: [] },
			{ match: '/candidate/add', response: { data: { id: 99002 } } },
			{ match: 'dialpad.com/api/v2/contacts', response: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF99002' } },
			{ match: 'apollo.io/api/v1/people/match', response: { person: null } },
			{ match: '/job/list', response: [] },
		]);

		const request = new Request('http://example.com/candidates', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Nobody',
				candidates: [{
					linkedinUrl: 'https://www.linkedin.com/in/test-person-2',
					fullName: 'Test Person Two',
					experience: [{ title: 'Engineer', company: 'Acme', startYear: 2020, isCurrent: true }],
				}],
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const addCalls = findCalls(calls, '/candidate/add');
		const addBody = JSON.parse(addCalls[0].opts.body);
		expect(addBody).not.toHaveProperty('lead_owner_id');
	});

	it('does NOT set lead_owner_id when the candidate already exists in RF', async () => {
		const existingCandidate = buildFullRFCandidate({ id: 99003, linkedin_profile: 'https://www.linkedin.com/in/test-existing-person' });
		const calls = mockFetch([
			{ match: '/candidate/search', response: [existingCandidate] }, // RF search returns a match
			{ match: '/candidate/get', response: { candidate: existingCandidate } },
			{ match: 'dialpad.com/api/v2/contacts', response: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF99003' } },
			{ match: 'apollo.io/api/v1/people/match', response: { person: null } },
			{ match: '/job/list', response: [] },
		]);

		const request = new Request('http://example.com/candidates', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				candidates: [{
					linkedinUrl: 'https://www.linkedin.com/in/test-existing-person',
					fullName: 'Existing Person',
					experience: [{ title: 'Engineer', company: 'Acme', startYear: 2020, isCurrent: true }],
				}],
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		// /candidate/add should NOT be called (existing candidate path)
		expect(findCalls(calls, '/candidate/add')).toHaveLength(0);
	});
});

describe('E2E: /candidates — JWT auth', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('routes lead_owner_id to the JWT email, ignoring body consultantFirstName', async () => {
		// Sabotage: body asks for Alice (rfUserId=900002), JWT identifies Joel
		// (rfUserId=900001). Worker MUST attribute the create to Joel per the
		// JWT, NOT Alice per the body.
		const calls = mockFetch([
			{ match: '/candidate/search', response: [] }, // RF search returns no match → create
			{ match: '/candidate/add', response: { data: { id: 99100 } } },
			{ match: 'dialpad.com/api/v2/contacts', response: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF99100' } },
			{ match: 'apollo.io/api/v1/people/match', response: { person: null } },
			{ match: '/job/list', response: [] },
		]);

		const jwt = await mintAccessJwt(env, { email: 'joel@test.local' });
		const request = new Request('http://example.com/candidates', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${jwt}`,
			},
			body: JSON.stringify({
				consultantFirstName: 'Alice', // sabotage attempt — MUST be ignored
				candidates: [{
					linkedinUrl: 'https://www.linkedin.com/in/jwt-test-person-99100',
					fullName: 'JWT Test Person',
					experience: [{ title: 'Engineer', company: 'Acme', startYear: 2020, isCurrent: true }],
				}],
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const addCalls = findCalls(calls, '/candidate/add');
		expect(addCalls).toHaveLength(1);
		const addBody = JSON.parse(addCalls[0].opts.body);
		// 900001 = Joel's rfUserId (from JWT); 900002 = Alice's (from body).
		// Asserting 900001 proves the JWT identity won over the body field.
		expect(addBody.lead_owner_id).toBe(900001);
	});
});

describe('E2E: /candidates/add-to-job with consultantFirstName', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('writes consultant_id custom field after successful add-to-job', async () => {
		const calls = mockFetch([
			{ match: '/candidate/add-to-job', response: { success: true } },
			{ match: '/job-candidate/custom-field/value/update', response: { success: true } },
		]);

		const request = new Request('http://example.com/candidates/add-to-job', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				rfIds: [50000],
				jobId: 999,
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const customFieldCalls = findCalls(calls, '/job-candidate/custom-field/value/update');
		expect(customFieldCalls).toHaveLength(1);
		const body = JSON.parse(customFieldCalls[0].opts.body);
		expect(body).toEqual({
			candidate_id: 50000,
			job_id: 999,
			custom_fields: [{ id: 16, value: 900001 }],
		});

		const json = await response.json();
		expect(json.results[0].status).toBe('added');
	});

	it('warms KV cache with the consultant value on success', async () => {
		mockFetch([
			{ match: '/candidate/add-to-job', response: { success: true } },
			{ match: '/job-candidate/custom-field/value/update', response: { success: true } },
		]);

		const request = new Request('http://example.com/candidates/add-to-job', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				rfIds: [50001],
				jobId: 1001,
			}),
		});
		const ctx = createExecutionContext();
		await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		const { getCachedConsultantForJobLink } = await import('../src/cache.js');
		expect(await getCachedConsultantForJobLink(50001, 1001, env)).toBe(900001);
	});

	it('does NOT make the second call when consultantFirstName is missing', async () => {
		const calls = mockFetch([
			{ match: '/candidate/add-to-job', response: { success: true } },
		]);

		const request = new Request('http://example.com/candidates/add-to-job', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				rfIds: [50002],
				jobId: 999,
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(findCalls(calls, '/job-candidate/custom-field/value/update')).toHaveLength(0);
	});

	it('marks consultantWriteFailed=true when the second call fails, but still returns added', async () => {
		mockFetch([
			{ match: '/candidate/add-to-job', response: { success: true } },
			{ match: '/job-candidate/custom-field/value/update', response: 'broken', status: 500 },
		]);

		const request = new Request('http://example.com/candidates/add-to-job', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				rfIds: [50003],
				jobId: 999,
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		const json = await response.json();
		expect(json.results[0].status).toBe('added');
		expect(json.results[0].consultantWriteFailed).toBe(true);
	});

	it('writes consultant_id even when add returned already_in_job (re-add reattributes + warms cache)', async () => {
		const calls = mockFetch([
			// RF returns 400 with the "already in pipeline" message → existing handler treats as already_in_job
			{ match: '/candidate/add-to-job', response: { error: 'Candidate is already in this job pipeline' }, status: 400 },
			{ match: '/job-candidate/custom-field/value/update', response: { success: true } },
		]);

		const request = new Request('http://example.com/candidates/add-to-job', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				rfIds: [50004],
				jobId: 999,
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.results[0].status).toBe('already_in_job');

		// The consultant_id custom field should still be written, and the KV cache warmed.
		const customFieldCalls = findCalls(calls, '/job-candidate/custom-field/value/update');
		expect(customFieldCalls).toHaveLength(1);
		const body = JSON.parse(customFieldCalls[0].opts.body);
		expect(body).toEqual({
			candidate_id: 50004,
			job_id: 999,
			custom_fields: [{ id: 16, value: 900001 }],
		});

		const { getCachedConsultantForJobLink } = await import('../src/cache.js');
		expect(await getCachedConsultantForJobLink(50004, 999, env)).toBe(900001);
	});
});

describe('E2E: /candidate-mark-invalid', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('returns 401 without X-Extension-Token', async () => {
		const request = new Request('http://example.com/candidate-mark-invalid', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ rfId: 12345, consultantFirstName: 'Joel' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('appends "Number Invalid" tag and POSTs /candidate/update', async () => {
		const calls = mockFetch([
			rfGetCandidateRoute(buildFullRFCandidate({ id: 12345, tags: ['Active'] })),
			rfUpdateCandidateRoute(),
		]);

		const request = new Request('http://example.com/candidate-mark-invalid', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({ rfId: 12345, consultantFirstName: 'Joel' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });

		const updateCalls = findCalls(calls, '/candidate/update');
		expect(updateCalls).toHaveLength(1);
		const body = JSON.parse(updateCalls[0].opts.body);
		expect(body).toEqual({ id: 12345, tags: ['Active', 'Number Invalid'] });
	});

	it('is idempotent: when tag already present, returns 200 with no /candidate/update call', async () => {
		const calls = mockFetch([
			rfGetCandidateRoute(buildFullRFCandidate({ id: 12345, tags: ['Active', 'Number Invalid'] })),
		]);

		const request = new Request('http://example.com/candidate-mark-invalid', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({ rfId: 12345, consultantFirstName: 'Joel' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(findCalls(calls, '/candidate/update')).toHaveLength(0);
	});

	it('returns 400 when rfId is missing', async () => {
		const request = new Request('http://example.com/candidate-mark-invalid', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({ consultantFirstName: 'Joel' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});
});

describe('E2E: /candidate-details', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('returns 401 without X-Extension-Token', async () => {
		const request = new Request('http://example.com/candidate-details', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ profileUrl: 'https://www.linkedin.com/in/foo' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 404 when no RF candidate matches the LinkedIn URL', async () => {
		mockFetch([
			{ match: '/candidate/search', response: [] },
		]);

		const request = new Request('http://example.com/candidate-details', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				profileUrl: 'https://www.linkedin.com/in/nonexistent-person',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		const json = await response.json();
		expect(json.error).toMatch(/not found/i);
	});

	it('returns full details with picked job, normalized phone, and cold-call activities', async () => {
		const fullCandidate = buildFullRFCandidate({
			id: 80001,
			linkedin_profile: 'https://www.linkedin.com/in/robert-fisher-123',
			first_name: 'Joseph',
			last_name: 'Knosp',
			name: 'Robert Fisher',
			phone_number: [{ phone_number: '5551234567', type: 1 }],
			jobs: [{
				job_id: 996,
				is_open: true,
				stage_name: 'Replied',
				stage_moved: '2026-04-29T00:00:00Z',
				name: 'Senior Data Engineer',
				company: { name: 'Acme Inc' },
				stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }],
				added_to_job_by: { id: 900001, name: 'Joel Haines' },
			}],
		});

		const { cacheConsultantForJobLink } = await import('../src/cache.js');
		await cacheConsultantForJobLink(80001, 996, 900001, env);

		mockFetch([
			rfSearchRoute([fullCandidate]),
			rfGetCandidateRoute(fullCandidate),
			{ match: '/candidate/activity/list', response: {
				data: [
					// DESC by time as RF returns
					{
						activity_id: 9912,
						type: { id: 1002, name: 'Cold Call' },
						time: '2026-04-29T16:05:00+00:00',
						text: 'Cold call with Robert Fisher — Connected (Positive)<br>\n<br>\nNext steps:<br>\n• Send follow-up.',
						is_custom: true,
					},
					{
						activity_id: 9821,
						type: { id: 1002, name: 'Cold Call' },
						time: '2026-04-22T14:33:00+00:00',
						text: 'Cold call with Robert Fisher — Voicemail',
						is_custom: true,
					},
					// Non-cold-call entry that should be filtered out
					{
						activity_id: 9999,
						type: { id: 9, name: 'Added to job' },
						time: '2026-04-21T00:00:00+00:00',
						text: 'System added',
						is_custom: false,
					},
				],
				total_items: 3,
			} },
		]);

		const request = new Request('http://example.com/candidate-details', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				profileUrl: 'https://www.linkedin.com/in/robert-fisher-123',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.rfId).toBe(80001);
		expect(json.fullName).toBe('Robert Fisher');
		expect(json.phoneNumber).toBe('+15551234567');
		expect(json.job).toEqual({
			title: 'Senior Data Engineer',
			company: 'Acme Inc',
			stage: 'Replied',
		});
		expect(json.activities).toHaveLength(2); // ASC, only cold calls
		expect(json.activities[0].id).toBe(9821); // older first
		expect(json.activities[0].outcome).toBe('voicemail');
		expect(json.activities[1].id).toBe(9912);
		expect(json.activities[1].outcome).toBe('connected');
		expect(json.activities[1].description).toBe('Next steps:\n• Send follow-up.');
	});

	it('returns null phoneNumber when phone_number array is empty', async () => {
		const fullCandidate = buildFullRFCandidate({
			id: 80002,
			linkedin_profile: 'https://www.linkedin.com/in/no-phone',
			phone_number: [],
			jobs: [],
		});

		mockFetch([
			rfSearchRoute([fullCandidate]),
			rfGetCandidateRoute(fullCandidate),
			{ match: '/candidate/activity/list', response: { data: [], total_items: 0 } },
		]);

		const request = new Request('http://example.com/candidate-details', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				profileUrl: 'https://www.linkedin.com/in/no-phone',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		const json = await response.json();
		expect(json.phoneNumber).toBeNull();
		expect(json.job).toBeNull();
		expect(json.activities).toEqual([]);
	});
});

describe('E2E: /candidate-details — JWT auth', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('returns 200 with Joel\'s picked job under JWT, ignoring body consultantFirstName', async () => {
		// Sabotage: body asks for Alice (rfUserId=900002), JWT identifies Joel
		// (rfUserId=900001). Worker MUST pick Joel's job per the JWT, NOT
		// Alice's per the body. Two open jobs on the candidate — Job A is
		// Joel's, Job B is Alice's. The KV consultant cache is pre-populated
		// so pickConsultantJob resolves without falling through to RF.
		//
		// Job B (Alice's) appears FIRST in candidate.jobs AND has a more
		// recent stage_moved — meaning every "non-identity" path
		// (raw jobs[0], stage-moved-desc-without-match) would return Job B.
		// Asserting Job A's title proves the JWT identity drove the pick.
		const JOB_A_ID = 8810; // Joel's job
		const JOB_B_ID = 8811; // Alice's job
		const JOB_A_TITLE = 'Senior Backend Engineer';
		const JOB_B_TITLE = 'Staff Frontend Engineer';
		const fullCandidate = buildFullRFCandidate({
			id: 80100,
			linkedin_profile: 'https://www.linkedin.com/in/jwt-details-person',
			first_name: 'JWT',
			last_name: 'Details',
			name: 'JWT Details',
			phone_number: [{ phone_number: '5559876543', type: 1 }],
			jobs: [
				{
					// Job B — Alice's, listed FIRST + more recent stage_moved
					// so it would win every fallback path.
					job_id: JOB_B_ID,
					is_open: true,
					name: JOB_B_TITLE,
					company: { name: 'Acme Inc' },
					stage_name: 'Replied',
					stage_moved: '2026-05-01T12:00:00+00:00',
					added_to_job_by: { id: 900002, name: 'Alice Tester' },
					stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }],
				},
				{
					// Job A — Joel's. Only picked if the JWT identity drives
					// the resolver.
					job_id: JOB_A_ID,
					is_open: true,
					name: JOB_A_TITLE,
					company: { name: 'Acme Inc' },
					stage_name: 'Sourced',
					stage_moved: '2026-04-15T08:00:00+00:00',
					added_to_job_by: { id: 900001, name: 'Joel Haines' },
					stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }],
				},
			],
		});

		// Pre-populate the consultant cache for both job-candidate links so
		// pickConsultantJob resolves entirely from KV (no RF fallback fetch).
		const { cacheConsultantForJobLink } = await import('../src/cache.js');
		await cacheConsultantForJobLink(80100, JOB_A_ID, 900001, env); // Joel
		await cacheConsultantForJobLink(80100, JOB_B_ID, 900002, env); // Alice

		mockFetch([
			rfSearchRoute([fullCandidate]),
			rfGetCandidateRoute(fullCandidate),
			{ match: '/candidate/activity/list', response: { data: [], total_items: 0 } },
		]);

		const jwt = await mintAccessJwt(env, { email: 'joel@test.local' });
		const request = new Request('http://example.com/candidate-details', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${jwt}`,
			},
			body: JSON.stringify({
				consultantFirstName: 'Alice', // sabotage — MUST be ignored
				profileUrl: 'https://www.linkedin.com/in/jwt-details-person',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		// Response shape matches legacy path.
		expect(json.rfId).toBe(80100);
		expect(json.fullName).toBe('JWT Details');
		expect(json.phoneNumber).toBe('+15559876543');
		expect(json.activities).toEqual([]);
		// Discriminator: Joel's job MUST be picked, NOT Alice's. If the body
		// firstName had won, json.job.title would equal JOB_B_TITLE.
		expect(json.job).toEqual({
			title: JOB_A_TITLE,
			company: 'Acme Inc',
			stage: 'Sourced',
		});
	});
});


// ---------------------------------------------------------------------------
// E2E: /dialpad-user-context — fetch caller-IDs for the consultant's picker
// ---------------------------------------------------------------------------

describe('E2E: /dialpad-user-context', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('returns 401 without X-Extension-Token', async () => {
		const request = new Request('http://example.com/dialpad-user-context', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ consultantFirstName: 'Joel' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 403 ok=false when consultantFirstName is unknown', async () => {
		const request = new Request('http://example.com/dialpad-user-context', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({ consultantFirstName: 'Nobody' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(typeof json.error).toBe('string');
	});

	it('returns 400 ok=false when consultantFirstName is missing entirely', async () => {
		const request = new Request('http://example.com/dialpad-user-context', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json.ok).toBe(false);
	});

	it('returns callerIds with opaque round-trippable aliases and no plaintext numbers', async () => {
		const calls = mockFetch([
			{
				match: '/users/8000000000000001/caller_id',
				response: {
					caller_id: '+14155551212',
					phone_numbers: ['+14155551212', '+447700900123'],
					office_main_line: '+14155551216',
					groups: [{ caller_id: '+14155551215', display_name: 'Sales Team' }],
				},
			},
		]);

		const request = new Request('http://example.com/dialpad-user-context', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({ consultantFirstName: 'Joel' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();

		expect(Array.isArray(json.callerIds)).toBe(true);
		// office_main_line is intentionally skipped, so the upstream's
		// 4 candidate numbers collapse to 3 in the response.
		expect(json.callerIds).toHaveLength(3);

		// Order: phone_numbers, groups (office_main_line is dropped)
		expect(json.callerIds[0]).toMatchObject({ country: 'US', label: 'My number', isDefault: true });
		expect(json.callerIds[1]).toMatchObject({ country: 'UK', label: 'My number' });
		expect(json.callerIds[1].isDefault).toBeUndefined();
		expect(json.callerIds[2]).toMatchObject({ country: 'US', label: 'Sales Team' });

		// No "Office main line" entry leaked through
		expect(json.callerIds.find(c => c.label === 'Office main line')).toBeUndefined();

		// At most one default
		expect(json.callerIds.filter(c => c.isDefault).length).toBe(1);

		// No plaintext phone numbers anywhere in the body — including the
		// office_main_line number, which the worker now drops entirely.
		const responseStr = JSON.stringify(json);
		expect(responseStr).not.toContain('+14155551212');
		expect(responseStr).not.toContain('+447700900123');
		expect(responseStr).not.toContain('+14155551216');
		expect(responseStr).not.toContain('+14155551215');

		// Aliases are server-decodable
		const { verifyCallerIdAlias } = await import('../src/dialpad-aliases.js');
		expect(await verifyCallerIdAlias(json.callerIds[0].aliasId, env)).toBe('+14155551212');
		expect(await verifyCallerIdAlias(json.callerIds[1].aliasId, env)).toBe('+447700900123');
		expect(await verifyCallerIdAlias(json.callerIds[2].aliasId, env)).toBe('+14155551215');

		// Hit the right Dialpad URL exactly once with the consultant's Dialpad user ID
		const dpCalls = findCalls(calls, '/users/8000000000000001/caller_id');
		expect(dpCalls).toHaveLength(1);
	});

	it('returns 502 ok=false when Dialpad caller_id lookup fails', async () => {
		mockFetch([
			{ match: '/users/8000000000000001/caller_id', status: 500, response: 'oops' },
		]);

		const request = new Request('http://example.com/dialpad-user-context', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({ consultantFirstName: 'Joel' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
		const json = await response.json();
		expect(json.ok).toBe(false);
	});
});


// ---------------------------------------------------------------------------
// E2E: /dialpad-call — initiate a call via Dialpad with the picked caller-ID
// ---------------------------------------------------------------------------

describe('E2E: /dialpad-call', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	async function makeAlias(number) {
		const { signCallerIdAlias } = await import('../src/dialpad-aliases.js');
		return signCallerIdAlias(number, env);
	}

	function dialpadCall({ phoneNumber, callerAliasId, consultantFirstName = 'Joel' }) {
		return new Request('http://example.com/dialpad-call', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({ consultantFirstName, phoneNumber, callerAliasId }),
		});
	}

	it('returns 401 without X-Extension-Token', async () => {
		const request = new Request('http://example.com/dialpad-call', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 403 ok=false when consultantFirstName is unknown', async () => {
		const alias = await makeAlias('+14155551212');
		const request = new Request('http://example.com/dialpad-call', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Nobody',
				phoneNumber: '+14155551212',
				callerAliasId: alias,
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
		const json = await response.json();
		expect(json.ok).toBe(false);
	});

	it('returns 400 ok=false when phoneNumber is missing', async () => {
		const alias = await makeAlias('+14155551212');
		const request = new Request('http://example.com/dialpad-call', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				callerAliasId: alias,
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.error).toMatch(/phone/i);
	});

	it('returns 400 ok=false when callerAliasId is missing', async () => {
		const request = new Request('http://example.com/dialpad-call', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				phoneNumber: '+14155551212',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.error).toMatch(/caller/i);
	});

	it('returns 400 ok=false when callerAliasId is invalid / forged', async () => {
		const request = new Request('http://example.com/dialpad-call', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				phoneNumber: '+14155551212',
				callerAliasId: 'totally-fake-alias',
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.error).toMatch(/caller/i);
	});

	it('POSTs initiate_call with phone_number + outbound_caller_id (no device_id) and returns ok=true', async () => {
		const alias = await makeAlias('+14155551212');
		const calls = mockFetch([
			{
				match: '/users/8000000000000001/initiate_call',
				response: { device: { id: 'native-1', type: 'native' } },
			},
		]);

		const request = new Request('http://example.com/dialpad-call', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				phoneNumber: '+447700900123',
				callerAliasId: alias,
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);

		const callCalls = findCalls(calls, '/users/8000000000000001/initiate_call');
		expect(callCalls).toHaveLength(1);
		const body = JSON.parse(callCalls[0].opts.body);
		expect(body.phone_number).toBe('+447700900123');
		expect(body.outbound_caller_id).toBe('+14155551212');
		// Per user clarification — Dialpad auto-rings eligible devices when no device_id is given.
		expect(body.device_id).toBeUndefined();

		// Bearer auth on the upstream call
		expect(callCalls[0].opts.headers.Authorization).toMatch(/^Bearer /);
	});

	it('returns 502 ok=false when Dialpad rejects the call (and surfaces upstream message)', async () => {
		const alias = await makeAlias('+14155551212');
		mockFetch([
			{
				match: '/users/8000000000000001/initiate_call',
				status: 400,
				response: { error: 'No active autocallable device' },
			},
		]);

		const request = new Request('http://example.com/dialpad-call', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify({
				consultantFirstName: 'Joel',
				phoneNumber: '+447700900123',
				callerAliasId: alias,
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.error).toMatch(/Dialpad/i);
	});

	it('returns 429 with reason=rate_limit + Retry-After after 5 calls in the same window', async () => {
		const alias = await makeAlias('+14155551212');
		mockFetch([
			{
				match: '/users/8000000000000001/initiate_call',
				response: { device: { id: 'native-1', type: 'native' } },
			},
		]);

		// Use 5 distinct destinations for the first 5 calls so the dedup
		// window doesn't fire — this isolates the rate-limit check.
		for (let i = 0; i < 5; i++) {
			const ctx = createExecutionContext();
			const phoneNumber = `+1415555${(1000 + i).toString()}`;
			const response = await worker.fetch(dialpadCall({ phoneNumber, callerAliasId: alias }), env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(200);
		}

		// 6th call (different number again, so it's not dedup) should be capped.
		const ctx6 = createExecutionContext();
		const blocked = await worker.fetch(
			dialpadCall({ phoneNumber: '+14155556666', callerAliasId: alias }),
			env, ctx6,
		);
		await waitOnExecutionContext(ctx6);
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get('Retry-After')).toMatch(/^\d+$/);
		const json = await blocked.json();
		expect(json.ok).toBe(false);
		expect(json.reason).toBe('rate_limit');
		expect(json.retryAfterSec).toBeGreaterThan(0);
		expect(json.error).toMatch(/rate limit/i);
	});

	it('returns 429 with reason=duplicate when the same number is dialled twice within 3s', async () => {
		const alias = await makeAlias('+14155551212');
		mockFetch([
			{
				match: '/users/8000000000000001/initiate_call',
				response: { device: { id: 'native-1', type: 'native' } },
			},
		]);

		// First call goes through.
		const ctx1 = createExecutionContext();
		const r1 = await worker.fetch(
			dialpadCall({ phoneNumber: '+14155557777', callerAliasId: alias }),
			env, ctx1,
		);
		await waitOnExecutionContext(ctx1);
		expect(r1.status).toBe(200);

		// Immediate retry to same number → blocked as duplicate.
		const ctx2 = createExecutionContext();
		const r2 = await worker.fetch(
			dialpadCall({ phoneNumber: '+14155557777', callerAliasId: alias }),
			env, ctx2,
		);
		await waitOnExecutionContext(ctx2);
		expect(r2.status).toBe(429);
		const json = await r2.json();
		expect(json.ok).toBe(false);
		expect(json.reason).toBe('duplicate');
		expect(json.retryAfterSec).toBeGreaterThanOrEqual(1);
		expect(json.retryAfterSec).toBeLessThanOrEqual(3);
		expect(json.error).toMatch(/just dialled/i);
	});

	it('does NOT consume budget when the call is denied (state is unchanged on failure)', async () => {
		const alias = await makeAlias('+14155551212');
		mockFetch([
			{
				match: '/users/8000000000000001/initiate_call',
				response: { device: { id: 'native-1', type: 'native' } },
			},
		]);

		// Burn the budget with 5 distinct numbers.
		for (let i = 0; i < 5; i++) {
			const ctx = createExecutionContext();
			await worker.fetch(
				dialpadCall({ phoneNumber: `+1415555${(2000 + i).toString()}`, callerAliasId: alias }),
				env, ctx,
			);
			await waitOnExecutionContext(ctx);
		}

		// 6th gets blocked.
		const ctx6 = createExecutionContext();
		const blocked = await worker.fetch(
			dialpadCall({ phoneNumber: '+14155558888', callerAliasId: alias }),
			env, ctx6,
		);
		await waitOnExecutionContext(ctx6);
		expect(blocked.status).toBe(429);

		// 7th attempt (also blocked, since state is unchanged) — confirms the
		// 6th attempt did NOT push the oldest entry off and free up a slot.
		const ctx7 = createExecutionContext();
		const stillBlocked = await worker.fetch(
			dialpadCall({ phoneNumber: '+14155559999', callerAliasId: alias }),
			env, ctx7,
		);
		await waitOnExecutionContext(ctx7);
		expect(stillBlocked.status).toBe(429);
	});
});


// ---------------------------------------------------------------------------
// E2E: /dialpad-sms — send an SMS to a candidate via Dialpad.
// ---------------------------------------------------------------------------

describe('E2E: /dialpad-sms', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	async function makeAlias(number) {
		const { signCallerIdAlias } = await import('../src/dialpad-aliases.js');
		return signCallerIdAlias(number, env);
	}

	function dialpadSms(body) {
		return new Request('http://example.com/dialpad-sms', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Extension-Token': env.LINKEDIN_EXTENSION_SECRET,
			},
			body: JSON.stringify(body),
		});
	}

	it('returns 401 without X-Extension-Token', async () => {
		const request = new Request('http://example.com/dialpad-sms', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 403 ok=false when consultantFirstName is unknown', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(dialpadSms({
			consultantFirstName: 'Nobody',
			phoneNumber: '+14155551212',
			text: 'Hello',
		}), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.error).toMatch(/consultant/i);
	});

	it('returns 400 ok=false when phoneNumber is missing', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(dialpadSms({
			consultantFirstName: 'Joel',
			text: 'Hi',
		}), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json.error).toMatch(/phone/i);
	});

	it('returns 400 ok=false when phoneNumber is malformed', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(dialpadSms({
			consultantFirstName: 'Joel',
			phoneNumber: 'not-a-number',
			text: 'Hi',
		}), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json.error).toMatch(/invalid phone/i);
	});

	it('returns 400 ok=false when text is empty / whitespace-only', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(dialpadSms({
			consultantFirstName: 'Joel',
			phoneNumber: '+14155551212',
			text: '   \n  ',
		}), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json.error).toMatch(/empty message/i);
	});

	it('returns 400 ok=false when callerAliasId is invalid / forged', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(dialpadSms({
			consultantFirstName: 'Joel',
			phoneNumber: '+14155551212',
			text: 'Hi',
			callerAliasId: 'forged-alias',
		}), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json.error).toMatch(/caller/i);
	});

	it('POSTs /api/v2/sms with verbatim text + decoded from_number, returns ok=true', async () => {
		const alias = await makeAlias('+14155551212');
		const calls = mockFetch([
			{
				match: '/api/v2/sms',
				response: { id: 'sms-1004', message_status: 'pending' },
			},
		]);

		const text = "Hi John,\n\nI'm reaching out because…\n\nLet me know!\n\nJoel";
		const ctx = createExecutionContext();
		const response = await worker.fetch(dialpadSms({
			consultantFirstName: 'Joel',
			phoneNumber: '+447700900123',
			callerAliasId: alias,
			text,
		}), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.messageId).toBe('sms-1004');

		const smsCalls = findCalls(calls, '/api/v2/sms');
		expect(smsCalls).toHaveLength(1);
		const body = JSON.parse(smsCalls[0].opts.body);
		expect(body.user_id).toBe('8000000000000001');
		expect(body.to_numbers).toEqual(['+447700900123']);
		expect(body.from_number).toBe('+14155551212');
		// Critical: text is sent verbatim, no trim or normalisation.
		expect(body.text).toBe(text);
		expect(body.infer_country_code).toBe(false);

		expect(smsCalls[0].opts.headers.Authorization).toMatch(/^Bearer /);
	});

	it('omits from_number when callerAliasId is not provided (Dialpad default)', async () => {
		const calls = mockFetch([
			{ match: '/api/v2/sms', response: { id: 'sms-2', message_status: 'pending' } },
		]);

		const ctx = createExecutionContext();
		const response = await worker.fetch(dialpadSms({
			consultantFirstName: 'Joel',
			phoneNumber: '+14155551212',
			text: 'Hi',
		}), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = JSON.parse(findCalls(calls, '/api/v2/sms')[0].opts.body);
		expect(body).not.toHaveProperty('from_number');
	});

	it('returns 502 ok=false when Dialpad rejects the SMS (and surfaces upstream message)', async () => {
		const alias = await makeAlias('+14155551212');
		mockFetch([
			{
				match: '/api/v2/sms',
				status: 400,
				response: { error: 'Invalid destination' },
			},
		]);

		const ctx = createExecutionContext();
		const response = await worker.fetch(dialpadSms({
			consultantFirstName: 'Joel',
			phoneNumber: '+14155551212',
			callerAliasId: alias,
			text: 'Hi',
		}), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(502);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.error).toMatch(/Dialpad rejected the message/i);
		expect(json.error).toMatch(/Invalid destination/);
	});

	it('preserves leading and trailing whitespace in the message body', async () => {
		const calls = mockFetch([
			{ match: '/api/v2/sms', response: { id: 'sms-3' } },
		]);

		const text = '  hi there  '; // deliberately weird
		const ctx = createExecutionContext();
		await worker.fetch(dialpadSms({
			consultantFirstName: 'Joel',
			phoneNumber: '+14155551212',
			text,
		}), env, ctx);
		await waitOnExecutionContext(ctx);

		const body = JSON.parse(findCalls(calls, '/api/v2/sms')[0].opts.body);
		expect(body.text).toBe(text); // verbatim, not trimmed
	});
});

