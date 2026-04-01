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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import worker from '../src';

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
		expect(dialpadCalls.length).toBe(2);

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
		expect(dialpadCalls.length).toBe(2);

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
		expect(dialpadCalls.length).toBe(2);

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
		expect(dialpadCalls.length).toBe(2);
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
		expect(dialpadCalls.length).toBe(2);
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
		expect(dialpadCalls.length).toBe(2);
	});
});


// ---------------------------------------------------------------------------
// Krisp → RF (meeting notes)
// ---------------------------------------------------------------------------

describe('E2E: Krisp → RF (meeting notes)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('adds meeting notes to RF candidate via email lookup', async () => {
		const calls = mockFetch([
			rfAddNoteRoute(),
		]);

		// Pre-seed email cache
		await env.SYNC_STATE.put('email:candidate@example.com', '12345');

		// Clear any previous dedup key
		await env.SYNC_STATE.delete('krisp:meeting-001');

		const krispPayload = {
			event: 'summary_generated',
			data: {
				meeting: {
					id: 'meeting-001',
					title: 'Call with Tony',
					url: 'https://krisp.ai/meeting/001',
					start_date: '2026-03-30T14:00:00Z',
					duration: 1800,
					participants: [
						{ email: 'owner@example.com', name: 'Joel Haines' },
						{ email: 'candidate@example.com', name: 'Tony R' },
					],
				},
				content: [
					{ title: 'Summary', body: 'Discussed the role at Eon.io.' },
					{ title: 'Action Items', body: 'Send CV by Friday.' },
				],
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

		// Note should have been posted to RF
		const noteCalls = findCalls(calls, '/candidate/notes/add');
		expect(noteCalls.length).toBe(1);

		// Dedup flag should now be set
		const dedup = await env.SYNC_STATE.get('krisp:meeting-001');
		expect(dedup).toBe('true');
	});

	it('skips duplicate meeting (dedup flag already set)', async () => {
		const calls = mockFetch([]);

		// Pre-seed dedup flag
		await env.SYNC_STATE.put('krisp:meeting-002', 'true');

		const krispPayload = {
			event: 'summary_generated',
			data: {
				meeting: { id: 'meeting-002', title: 'Duplicate' },
				content: [{ title: 'Summary', body: 'test' }],
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
			event: 'summary_generated',
			data: {
				meeting: {
					id: 'meeting-003',
					title: 'Call',
					url: 'https://krisp.ai/meeting/003',
					start_date: '2026-03-30T14:00:00Z',
					duration: 900,
					participants: [
						{ email: 'owner@example.com', name: 'Joel' },
						{ email: 'tony@new.com', name: 'Tony' },
					],
				},
				content: [{ title: 'Summary', description: 'Great call.' }],
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
});


// ---------------------------------------------------------------------------
// Apollo webhook → phone delivery
// ---------------------------------------------------------------------------

describe('E2E: Apollo webhook (phone delivery)', () => {
	afterEach(() => { globalThis.fetch = originalFetch; });

	it('delivers phone from Apollo to Dialpad and updates cache', async () => {
		const fullCandidate = buildFullRFCandidate({
			email: [{ email: 'tony@example.com', is_primary: 1 }],
			phone_number: [],
		});

		const calls = mockFetch([
			rfGetCandidateRoute(fullCandidate),
			dialpadContactRoute(),
		]);

		// Pre-seed the enrichment context (set during initial enrichment)
		await env.SYNC_STATE.put('apollo_enrich:12345', JSON.stringify({
			apolloPersonId: 'apollo-123',
			correctedLinkedIn: null,
			timestamp: new Date().toISOString(),
		}), { expirationTtl: 900 });

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

		// RF candidate should be fetched for current data
		const rfGetCalls = findCalls(calls, '/candidate/get');
		expect(rfGetCalls.length).toBe(1);

		// Dialpad GET + PATCH should be called, PATCH body has the phone
		const dialpadCalls = findCalls(calls, 'dialpad.com');
		expect(dialpadCalls.length).toBe(2);
		const dialpadBody = JSON.parse(dialpadCalls[1].opts.body);
		expect(dialpadBody.phones).toContain('+15555550100');

		// Cache should be updated with phone
		const cached = await env.SYNC_STATE.get('candidate:12345');
		expect(cached).not.toBeNull();
		const cachedData = JSON.parse(cached);
		expect(cachedData.phone_number).toBeDefined();
	});

	it('returns 200 silently when enrichment context expired', async () => {
		const calls = mockFetch([]);

		// No enrichment context in KV (expired)

		const apolloWebhookPayload = {
			people: [{ id: 'apollo-456', status: 'success', phone_numbers: [{ sanitized_number: '+15555550100', status_cd: 'valid_number' }] }],
		};

		const request = new Request(
			`http://example.com/webhook/apollo?token=${env.APOLLO_WEBHOOK_SECRET}&rfId=99999`,
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

		// Nothing should be called
		expect(calls.length).toBe(0);
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

	it('defers processing when contact is unassociated phone number', async () => {
		const calls = mockFetch([]);

		const callPayload = {
			call_id: 'call-002',
			target: { id: 8000000000000001 },
			contact: {
				id: 'some-random-contact-id',  // No RF ID
				name: '(650) 521-2531',  // Phone number as name
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

		// Should have stored pending cold call in KV by phone
		const pending = await env.SYNC_STATE.get('pending_coldcall:6505550125');
		expect(pending).not.toBeNull();
		const pendingData = JSON.parse(pending);
		expect(pendingData.call_id).toBe('call-002');
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
			body: JSON.stringify({ event: 'summary_generated' }),
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
		expect(dialpadCalls.length).toBe(2);
	});
});
