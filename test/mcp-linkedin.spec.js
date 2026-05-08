import { describe, it, expect } from 'vitest';
import { toLinkedInUrl, projectWithLinkedIn } from '../src/mcp/linkedin.js';
import { project } from '../src/mcp/projection.js';

describe('toLinkedInUrl', () => {
  it('prepends canonical URL prefix to a bare slug', () => {
    expect(toLinkedInUrl('mike-rider-70371510a')).toBe('https://www.linkedin.com/in/mike-rider-70371510a');
  });
  it('passes a full URL through untouched', () => {
    expect(toLinkedInUrl('https://www.linkedin.com/in/foo'))
      .toBe('https://www.linkedin.com/in/foo');
    expect(toLinkedInUrl('http://linkedin.com/in/bar'))
      .toBe('http://linkedin.com/in/bar');
  });
  it('passes null/undefined/empty through', () => {
    expect(toLinkedInUrl(null)).toBe(null);
    expect(toLinkedInUrl(undefined)).toBe(undefined);
    expect(toLinkedInUrl('')).toBe('');
  });
  it('passes weird shapes (with / or .) through untouched', () => {
    expect(toLinkedInUrl('foo/bar')).toBe('foo/bar');
    expect(toLinkedInUrl('foo.bar')).toBe('foo.bar');
  });
  it('accepts underscore + hyphen + alphanumeric slugs', () => {
    expect(toLinkedInUrl('jane_doe-123')).toBe('https://www.linkedin.com/in/jane_doe-123');
  });
});

describe('projectWithLinkedIn', () => {
  it('normalizes a top-level linkedin_profile', () => {
    const obj = { id: 1, name: 'A', linkedin_profile: 'a-slug' };
    const out = projectWithLinkedIn(obj, ['id', 'name', 'linkedin_profile']);
    expect(out.linkedin_profile).toBe('https://www.linkedin.com/in/a-slug');
  });
  it('does not touch other fields', () => {
    const obj = { id: 1, name: 'A', current_organization: 'a-slug-shaped-string' };
    const out = projectWithLinkedIn(obj, ['id', 'name', 'current_organization']);
    expect(out.current_organization).toBe('a-slug-shaped-string');
  });
  it('normalizes a nested linkedin_profile (hypothetical)', () => {
    const obj = { id: 1, contact: { linkedin_profile: 'nested-slug' } };
    const out = projectWithLinkedIn(obj, ['id', 'contact.linkedin_profile']);
    expect(out.contact.linkedin_profile).toBe('https://www.linkedin.com/in/nested-slug');
  });
  it('preserves null linkedin_profile', () => {
    const obj = { id: 1, linkedin_profile: null };
    const out = projectWithLinkedIn(obj, ['id', 'linkedin_profile']);
    expect(out.linkedin_profile).toBe(null);
  });
});
