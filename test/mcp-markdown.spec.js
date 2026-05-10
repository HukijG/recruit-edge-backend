import { describe, it, expect } from 'vitest';
import { mdToHtml } from '../src/mcp/markdown.js';

describe('mdToHtml', () => {
  it('renders bold and italic', () => {
    const html = mdToHtml('**bold** and *italic*');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders a bare newline inside a paragraph as <br> (breaks:true)', () => {
    const html = mdToHtml('line one\nline two');
    expect(html).toMatch(/line one<br\s*\/?>\s*line two/);
  });

  it('renders a bullet list', () => {
    const html = mdToHtml('* first\n* second');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<li>second</li>');
  });

  it('renders an autolinked URL (gfm:true)', () => {
    const html = mdToHtml('See https://example.com for details');
    expect(html).toContain('<a href="https://example.com">');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(mdToHtml('   \n  ')).toBe('');
  });

  it('returns empty string for null or undefined input', () => {
    expect(mdToHtml(null)).toBe('');
    expect(mdToHtml(undefined)).toBe('');
  });
});
