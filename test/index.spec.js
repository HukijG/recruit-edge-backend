import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';
import { extractCandidateEmail, formatKrispNotesAsHtml } from '../src/krisp.js';

describe('RF-Dialpad Sync Worker', () => {
	it('/health returns 200 with status message', async () => {
		const request = new Request('http://example.com/health');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('RF-Dialpad Sync Middleware - OK');
	});

	it('unknown routes return 404', async () => {
		const request = new Request('http://example.com/unknown');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Krisp helper unit tests
// ---------------------------------------------------------------------------

describe('extractCandidateEmail', () => {
	it('returns non-Joel email from 2-person participant array', () => {
		const participants = [
			{ email: 'owner@example.com' },
			{ email: 'candidate@example.com' },
		];
		expect(extractCandidateEmail(participants)).toBe('candidate@example.com');
	});

	it('returns null when only Joel is present', () => {
		const participants = [{ email: 'owner@example.com' }];
		expect(extractCandidateEmail(participants)).toBeNull();
	});

	it('returns first non-Joel email in 3+ participant group calls', () => {
		const participants = [
			{ email: 'owner@example.com' },
			{ email: 'first-candidate@example.com' },
			{ email: 'second-person@example.com' },
		];
		expect(extractCandidateEmail(participants)).toBe('first-candidate@example.com');
	});

	it('returns null for empty array', () => {
		expect(extractCandidateEmail([])).toBeNull();
	});

	it('returns null for null input', () => {
		expect(extractCandidateEmail(null)).toBeNull();
	});

	it('returns null for undefined input', () => {
		expect(extractCandidateEmail(undefined)).toBeNull();
	});
});

describe('formatKrispNotesAsHtml', () => {
	const baseMeeting = {
		title: 'Engineering Sync',
		url: 'https://app.krisp.ai/meetings/abc123',
		start_date: '2026-02-10T19:00:00Z',
		duration: 1800, // 30 minutes
	};

	const twoSections = [
		{
			title: '**Key Discussion Points**',
			description: 'Talked about roadmap\nDiscussed hiring priorities',
		},
		{
			title: '**Action Items**',
			description: 'Follow up with candidate\nSchedule next round',
		},
	];

	it('formats a basic meeting with 2 content sections into HTML', () => {
		const html = formatKrispNotesAsHtml(baseMeeting, twoSections);

		// Outline header
		expect(html).toContain('<b>Outline</b>');

		// Meeting title wrapped in <a> tag pointing to Krisp URL
		expect(html).toContain('<a href="https://app.krisp.ai/meetings/abc123">Engineering Sync Call Notes</a>');

		// Duration in minutes
		expect(html).toContain('30m');

		// Section titles rendered as <b> tags, without ** markers
		expect(html).toContain('<b>Key Discussion Points</b>');
		expect(html).toContain('<b>Action Items</b>');
		expect(html).not.toContain('**');

		// Bullet points rendered as <li> tags
		expect(html).toContain('<li>Talked about roadmap</li>');
		expect(html).toContain('<li>Discussed hiring priorities</li>');
		expect(html).toContain('<li>Follow up with candidate</li>');
		expect(html).toContain('<li>Schedule next round</li>');
	});

	it('does not produce empty <li></li> tags from blank lines in descriptions', () => {
		const sectionsWithBlanks = [
			{
				title: 'Notes',
				description: 'First point\n\n\nSecond point\n\n',
			},
		];
		const html = formatKrispNotesAsHtml(baseMeeting, sectionsWithBlanks);

		expect(html).not.toContain('<li></li>');
		expect(html).toContain('<li>First point</li>');
		expect(html).toContain('<li>Second point</li>');
	});

	it('escapes special HTML characters in titles and descriptions', () => {
		const meeting = {
			...baseMeeting,
			title: 'R&D <Team> "Sync"',
			url: 'https://app.krisp.ai/meetings/abc&123',
		};
		const sections = [
			{
				title: 'Q&A Session',
				description: 'Discussed <script> injection & "quotes"',
			},
		];
		const html = formatKrispNotesAsHtml(meeting, sections);

		// Title should have & escaped
		expect(html).toContain('R&amp;D &lt;Team&gt; &quot;Sync&quot; Call Notes');

		// URL should have & escaped in href attribute
		expect(html).toContain('href="https://app.krisp.ai/meetings/abc&amp;123"');

		// Section title should have & escaped
		expect(html).toContain('<b>Q&amp;A Session</b>');

		// Description should have special chars escaped
		expect(html).toContain('&lt;script&gt;');
		expect(html).toContain('&amp;');
		expect(html).toContain('&quot;quotes&quot;');
	});
});

// ---------------------------------------------------------------------------
// Krisp webhook handler tests
// ---------------------------------------------------------------------------

describe('Krisp webhook handler', () => {
	it('returns 401 without auth token', async () => {
		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ event: 'summary_generated' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 401 with wrong auth token', async () => {
		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Krisp-Webhook-Token': 'wrong-secret',
			},
			body: JSON.stringify({ event: 'summary_generated' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('returns 200 and ignores key_points_generated events', async () => {
		const request = new Request('http://example.com/webhook/krisp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Krisp-Webhook-Token': env.KRISP_WEBHOOK_SECRET,
			},
			body: JSON.stringify({ event: 'key_points_generated' }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
	});
});
