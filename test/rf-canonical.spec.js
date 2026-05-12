import { describe, it, expect } from 'vitest';
import { canonicalizeRFCandidate } from '../src/rf-canonical.js';

/**
 * Wire shape captured from the live RF /candidate/get response for Jane Doe
 * (id 49243) — see LD trace 6374ff8a0fd93cb7d2844cb4b6322851. Keys that don't
 * affect canonicalisation are trimmed for readability.
 */
const RAW_RF_JERRY = {
  id: 49243,
  name: 'Jane Doe',
  first_name: 'Jerry',
  last_name: 'Kara',
  email: ['jerry@example.com'],
  phone_number: ['+14795550144'],
  current_organization: 'Snowflake',
  current_designation: 'Technical Account Manager ',
  linkedin_profile: 'jane-doe-9142771',
  jobs: [
    {
      job_id: 973,
      name: 'Technical Customer Success Manager',
      title: 'Technical Customer Success Manager',
      client_company_name: 'Eon.io',
      stage_name: 'Hired',
    },
  ],
};

describe('canonicalizeRFCandidate', () => {
  it('aliases RF wire fields to canonical MCP names', () => {
    const c = canonicalizeRFCandidate(RAW_RF_JERRY);
    expect(c.primary_email).toBe('jerry@example.com');
    expect(c.emails).toEqual(['jerry@example.com']);
    expect(c.phone_numbers).toEqual(['+14795550144']);
    expect(c.current_title).toBe('Technical Account Manager ');
    expect(c.jobs[0].job_name).toBe('Technical Customer Success Manager');
  });

  it('preserves the original raw RF fields verbatim', () => {
    const c = canonicalizeRFCandidate(RAW_RF_JERRY);
    expect(c.email).toEqual(['jerry@example.com']);
    expect(c.phone_number).toEqual(['+14795550144']);
    expect(c.current_designation).toBe('Technical Account Manager ');
    expect(c.jobs[0].name).toBe('Technical Customer Success Manager');
  });

  it('is idempotent on already-canonical input (test-mock shape)', () => {
    const canonical = {
      id: 42,
      name: 'Jerry Smith',
      primary_email: 'jerry@x.com',
      phone_numbers: ['+15551234567'],
      current_title: 'Software Engineer',
      jobs: [{ job_name: 'Eng', client_company_name: 'Acme', stage_name: 'Sourced' }],
    };
    const c = canonicalizeRFCandidate(canonical);
    expect(c.primary_email).toBe('jerry@x.com');
    expect(c.phone_numbers).toEqual(['+15551234567']);
    expect(c.current_title).toBe('Software Engineer');
    expect(c.jobs[0].job_name).toBe('Eng');
    // primary_email NOT overwritten, no stray current_designation injected.
    expect(c.current_designation).toBeUndefined();
  });

  it('never overwrites pre-existing canonical fields', () => {
    const mixed = {
      id: 1,
      email: ['raw@x.com'],
      primary_email: 'canonical@x.com',
      current_title: 'Existing Title',
      current_designation: 'Raw Title',
    };
    const c = canonicalizeRFCandidate(mixed);
    expect(c.primary_email).toBe('canonical@x.com');
    expect(c.current_title).toBe('Existing Title');
  });

  it('extracts emails from update-shaped objects ({value, is_primary})', () => {
    const rf = {
      id: 1,
      email: [
        { value: 'first@x.com', is_primary: 1 },
        { value: 'second@x.com', is_primary: 0 },
      ],
    };
    const c = canonicalizeRFCandidate(rf);
    expect(c.primary_email).toBe('first@x.com');
    expect(c.emails).toEqual(['first@x.com', 'second@x.com']);
  });

  it('extracts emails from older list/get-shaped objects ({email, type})', () => {
    const rf = {
      id: 1,
      email: [{ email: 'first@x.com', type: 'work' }],
    };
    const c = canonicalizeRFCandidate(rf);
    expect(c.primary_email).toBe('first@x.com');
    expect(c.emails).toEqual(['first@x.com']);
  });

  it('handles a bare-string email field (no array)', () => {
    const rf = { id: 1, email: 'lone@x.com' };
    const c = canonicalizeRFCandidate(rf);
    expect(c.primary_email).toBe('lone@x.com');
    // No emails[] synthesised — only an array source produces emails[].
    expect(c.emails).toBeUndefined();
  });

  it('handles a bare-string phone_number field (no array)', () => {
    const rf = { id: 1, phone_number: '+19785551212' };
    const c = canonicalizeRFCandidate(rf);
    expect(c.phone_numbers).toEqual(['+19785551212']);
  });

  it('falls back jobs[].name → jobs[].title → null for missing job_name', () => {
    const rf = {
      id: 1,
      jobs: [
        { job_id: 1, name: 'From Name' },
        { job_id: 2, title: 'From Title' },
        { job_id: 3 }, // no name / title — left without job_name
      ],
    };
    const c = canonicalizeRFCandidate(rf);
    expect(c.jobs[0].job_name).toBe('From Name');
    expect(c.jobs[1].job_name).toBe('From Title');
    expect(c.jobs[2].job_name).toBeUndefined();
  });

  it('drops empty arrays without inventing canonical fields', () => {
    const rf = { id: 1, email: [], phone_number: [] };
    const c = canonicalizeRFCandidate(rf);
    expect(c.primary_email).toBeUndefined();
    expect(c.emails).toBeUndefined();
    expect(c.phone_numbers).toBeUndefined();
  });

  it('returns non-object input unchanged', () => {
    expect(canonicalizeRFCandidate(null)).toBeNull();
    expect(canonicalizeRFCandidate(undefined)).toBeUndefined();
    expect(canonicalizeRFCandidate('string')).toBe('string');
    expect(canonicalizeRFCandidate(42)).toBe(42);
    const arr = [1, 2];
    expect(canonicalizeRFCandidate(arr)).toBe(arr);
  });

  it('does not mutate the input object', () => {
    const rf = { id: 1, email: ['a@x.com'], current_designation: 'T' };
    const before = JSON.stringify(rf);
    canonicalizeRFCandidate(rf);
    expect(JSON.stringify(rf)).toBe(before);
  });
});
