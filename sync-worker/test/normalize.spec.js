import { describe, it, expect } from 'vitest';
import { toCandidateRow, toCandidateJobRows } from '../src/normalize.js';

const sample = {
  id: 42,
  first_name: 'Jerry', last_name: 'Smith', name: 'Jerry Smith',
  primary_email: 'jerry@example.com',
  emails: ['jerry@example.com'],
  phone_numbers: [{ phone_number: '+447700900000' }],
  linkedin_profile: 'https://www.linkedin.com/in/jerry-smith',
  current_title: 'Engineer', current_organization: 'Acme',
  added_time: '2026-01-01T00:00:00Z',
  last_updated: '2026-05-05T10:00:00Z',
  last_activity_at: '2026-05-04T00:00:00Z',
  lead_owner: { id: 900001 },
  custom_fields: [],
  // These should be excluded from body:
  activities: [{ id: 1 }],
  notes: [{ id: 2 }],
  experience: [{ company: 'Old Corp' }],
  education: [{ school: 'MIT' }],
  files: [{ name: 'cv.pdf' }],
  jobs: [
    {
      job_id: 100, job_name: 'Eng 1', stage_id: 5, stage_name: 'Sourced',
      stage_moved: '2026-05-04T00:00:00Z',
      added_to_job: '2026-05-01T00:00:00Z',
      added_to_job_by: { id: 900001 },
      disqualified: false,
    },
    {
      job_id: 101, job_name: 'Eng 2', stage_id: 9, stage_name: 'Hired',
      disqualified: true, disqualification_reason: 'Hired elsewhere',
    },
  ],
};

describe('normalize', () => {
  it('toCandidateRow extracts indexed columns + curated body', () => {
    const row = toCandidateRow(sample);
    expect(row.id).toBe(42);
    expect(row.name).toBe('Jerry Smith');
    expect(row.primary_email).toBe('jerry@example.com');
    expect(row.linkedin_profile).toBe('jerry-smith');
    expect(row.lead_owner_id).toBe(900001);
    expect(row.last_updated).toBe('2026-05-05T10:00:00Z');
    expect(row.current_organization).toBe('Acme');
    expect(row.current_title).toBe('Engineer');
    expect(row.added_time).toBe('2026-01-01T00:00:00Z');
    expect(row.last_activity_at).toBe('2026-05-04T00:00:00Z');
    expect(typeof row.cached_at).toBe('string');
    // body is valid JSON
    const body = JSON.parse(row.body);
    // heavy keys excluded
    expect(body.activities).toBeUndefined();
    expect(body.notes).toBeUndefined();
    expect(body.experience).toBeUndefined();
    expect(body.education).toBeUndefined();
    expect(body.files).toBeUndefined();
    // curated keys preserved
    expect(body.jobs.length).toBe(2);
    expect(body.emails).toEqual(['jerry@example.com']);
    expect(body.phone_numbers).toEqual([{ phone_number: '+447700900000' }]);
  });

  it('toCandidateJobRows produces one row per job', () => {
    const rows = toCandidateJobRows(sample);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      candidate_id: 42, job_id: 100, stage_name: 'Sourced',
      added_to_job_by_id: 900001, disqualified: 0,
    });
    expect(rows[1]).toMatchObject({
      candidate_id: 42, job_id: 101, stage_name: 'Hired',
      disqualified: 1, disqualification_reason: 'Hired elsewhere',
    });
  });

  it('linkedin slug normalisation strips protocol + trailing slash', () => {
    const row = toCandidateRow({ ...sample, linkedin_profile: 'http://www.linkedin.com/in/foo-bar/' });
    expect(row.linkedin_profile).toBe('foo-bar');
  });

  it('handles candidate with no jobs', () => {
    const rows = toCandidateJobRows({ ...sample, jobs: [] });
    expect(rows).toEqual([]);
  });

  // Edge cases
  it('handles missing jobs array (undefined)', () => {
    const rf = { ...sample };
    delete rf.jobs;
    const rows = toCandidateJobRows(rf);
    expect(rows).toEqual([]);
  });

  it('normalises pub linkedin URLs', () => {
    const row = toCandidateRow({ ...sample, linkedin_profile: 'https://www.linkedin.com/pub/jane-doe/12/345/678/' });
    expect(row.linkedin_profile).toBe('jane-doe');
  });

  it('returns null linkedin_profile when no URL provided', () => {
    const row = toCandidateRow({ ...sample, linkedin_profile: null });
    expect(row.linkedin_profile).toBeNull();
  });

  it('falls back to first_name + last_name when name is missing', () => {
    const row = toCandidateRow({ ...sample, name: undefined });
    expect(row.name).toBe('Jerry Smith');
  });

  it('returns null lead_owner_id when lead_owner is missing', () => {
    const row = toCandidateRow({ ...sample, lead_owner: undefined });
    expect(row.lead_owner_id).toBeNull();
  });

  it('lowercases primary_email', () => {
    const row = toCandidateRow({ ...sample, primary_email: 'Jerry@Example.COM' });
    expect(row.primary_email).toBe('jerry@example.com');
  });

  it('returns null primary_email when missing', () => {
    const row = toCandidateRow({ ...sample, primary_email: undefined });
    expect(row.primary_email).toBeNull();
  });

  it('job row nulls missing optional fields', () => {
    const rf = {
      ...sample,
      jobs: [{ job_id: 200, disqualified: false }],
    };
    const rows = toCandidateJobRows(rf);
    expect(rows[0].stage_id).toBeNull();
    expect(rows[0].stage_name).toBeNull();
    expect(rows[0].stage_moved).toBeNull();
    expect(rows[0].added_to_job).toBeNull();
    expect(rows[0].added_to_job_by_id).toBeNull();
    expect(rows[0].disqualification_reason).toBeNull();
  });
});
