import { describe, it, expect, vi } from 'vitest';

const setAttributeMock = vi.fn();
const recordExceptionMock = vi.fn();
const endMock = vi.fn();
const setStatusMock = vi.fn();
const span = {
  setAttribute: setAttributeMock,
  recordException: recordExceptionMock,
  setStatus: setStatusMock,
  end: endMock,
};
const startActiveSpanMock = vi.fn(async (name, opts, fn) => fn(span));

vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: () => ({ startActiveSpan: startActiveSpanMock }) },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

import { runAI } from '../../src/lib/ai-instrument.js';

describe('runAI', () => {
  it('starts an ai.run span with ai.model + ai.input.shape + ai.request.body', async () => {
    setAttributeMock.mockClear();
    const env = { AI: { run: vi.fn(async () => ({ response: 'hi' })) } };
    await runAI(env, '@cf/meta/llama-3.1-8b-instruct', { messages: [{ role: 'user', content: 'hi' }] });
    expect(startActiveSpanMock).toHaveBeenCalled();
    const [name, opts] = startActiveSpanMock.mock.calls[0];
    expect(name).toBe('ai.run');
    expect(opts.attributes['ai.model']).toBe('@cf/meta/llama-3.1-8b-instruct');
    expect(opts.attributes['ai.input.shape']).toBe('chat(1)');
    expect(opts.attributes['ai.request.body']).toContain('"role":"user"');
  });

  it('stamps ai.tokens.input/output from OpenAI-style usage if present', async () => {
    setAttributeMock.mockClear();
    const env = {
      AI: {
        run: vi.fn(async () => ({
          response: 'hi',
          usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
        })),
      },
    };
    await runAI(env, 'model', { prompt: 'hi' });
    expect(setAttributeMock).toHaveBeenCalledWith('ai.tokens.input', 12);
    expect(setAttributeMock).toHaveBeenCalledWith('ai.tokens.output', 34);
    expect(setAttributeMock).toHaveBeenCalledWith('ai.tokens.total', 46);
  });

  it('stamps ai.tokens.input/output from Anthropic-style usage (input_tokens/output_tokens)', async () => {
    setAttributeMock.mockClear();
    const env = {
      AI: {
        run: vi.fn(async () => ({
          response: 'hi',
          usage: { input_tokens: 12, output_tokens: 34 },  // no total_tokens
        })),
      },
    };
    await runAI(env, 'model', { prompt: 'hi' });
    expect(setAttributeMock).toHaveBeenCalledWith('ai.tokens.input', 12);
    expect(setAttributeMock).toHaveBeenCalledWith('ai.tokens.output', 34);
    expect(setAttributeMock).toHaveBeenCalledWith('ai.tokens.total', 46);  // computed
  });

  it('stamps ai.response.body truncated to 32KB', async () => {
    setAttributeMock.mockClear();
    const huge = { response: 'x'.repeat(40 * 1024) };
    const env = { AI: { run: vi.fn(async () => huge) } };
    await runAI(env, 'model', { prompt: 'hi' });
    const respCall = setAttributeMock.mock.calls.find(([k]) => k === 'ai.response.body');
    expect(respCall).toBeDefined();
    expect(respCall[1].length).toBeLessThanOrEqual(32 * 1024 + 60);
    expect(respCall[1]).toMatch(/truncated, original \d+ bytes/);
  });

  it('stamps ai.duration_ms', async () => {
    setAttributeMock.mockClear();
    const env = { AI: { run: vi.fn(async () => ({ response: 'hi' })) } };
    await runAI(env, 'model', { prompt: 'hi' });
    const duration = setAttributeMock.mock.calls.find(([k]) => k === 'ai.duration_ms');
    expect(duration).toBeDefined();
    expect(typeof duration[1]).toBe('number');
  });

  it('records exception and rethrows on AI.run error', async () => {
    recordExceptionMock.mockClear();
    setStatusMock.mockClear();
    endMock.mockClear();
    const env = { AI: { run: vi.fn(async () => { throw new Error('AI exploded'); }) } };
    await expect(runAI(env, 'model', { prompt: 'hi' })).rejects.toThrow('AI exploded');
    expect(recordExceptionMock).toHaveBeenCalled();
    expect(setStatusMock).toHaveBeenCalledWith(expect.objectContaining({ code: 2 }));
    expect(endMock).toHaveBeenCalled();
  });

  it('describes input shape for chat / prompt / text', async () => {
    const env = { AI: { run: vi.fn(async () => ({})) } };
    await runAI(env, 'model', { messages: [1, 2, 3] });
    expect(startActiveSpanMock.mock.calls.at(-1)[1].attributes['ai.input.shape']).toBe('chat(3)');
    await runAI(env, 'model', { prompt: 'abcdef' });
    expect(startActiveSpanMock.mock.calls.at(-1)[1].attributes['ai.input.shape']).toBe('prompt(6c)');
    await runAI(env, 'model', { text: 'abc' });
    expect(startActiveSpanMock.mock.calls.at(-1)[1].attributes['ai.input.shape']).toBe('text(3c)');
  });

  it('refuses streaming-mode calls', async () => {
    const env = { AI: { run: vi.fn() } };
    await expect(runAI(env, 'model', { prompt: 'hi' }, { stream: true })).rejects.toThrow(/streaming/);
  });
});
