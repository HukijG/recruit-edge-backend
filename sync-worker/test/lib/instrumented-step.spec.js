import { describe, it, expect, vi } from 'vitest';

const span = {
  setAttribute: vi.fn(),
  recordException: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
};
const startActiveSpanMock = vi.fn(async (name, opts, fn) => fn(span));

vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: () => ({ startActiveSpan: startActiveSpanMock }) },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

import { instrumentedStep } from '../../src/lib/instrumented-step.js';

describe('instrumentedStep', () => {
  it('wraps step.do(name, fn) form and emits a child span', async () => {
    startActiveSpanMock.mockClear();
    const stepInner = {
      do: vi.fn(async (name, fn) => fn()),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
    };
    const wrapped = instrumentedStep(stepInner, 'tracer', 'instance-123');
    await wrapped.do('fetch-data', async () => 'ok');
    expect(startActiveSpanMock).toHaveBeenCalled();
    const [name, opts] = startActiveSpanMock.mock.calls[0];
    expect(name).toBe('step.do:fetch-data');
    expect(opts.attributes['step.name']).toBe('fetch-data');
    expect(opts.attributes['workflow.id']).toBe('instance-123');
    expect(stepInner.do).toHaveBeenCalled();
  });

  it('wraps step.do(name, config, fn) form', async () => {
    startActiveSpanMock.mockClear();
    const stepInner = { do: vi.fn(async (name, config, fn) => fn()) };
    const wrapped = instrumentedStep(stepInner, 'tracer', 'inst');
    const config = { retries: { limit: 3, delay: '5 seconds' } };
    await wrapped.do('fetch-data', config, async () => 'ok');
    expect(startActiveSpanMock).toHaveBeenCalled();
    expect(stepInner.do).toHaveBeenCalled();
  });

  it('records exceptions on the step span', async () => {
    span.recordException.mockClear();
    const stepInner = { do: vi.fn(async (name, fn) => fn()) };
    const wrapped = instrumentedStep(stepInner, 'tracer', 'inst');
    await expect(wrapped.do('failing', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(span.recordException).toHaveBeenCalled();
  });

  it('forwards step.sleep and step.sleepUntil unchanged', async () => {
    const stepInner = {
      do: vi.fn(),
      sleep: vi.fn(async () => 'slept'),
      sleepUntil: vi.fn(async () => 'slept-until'),
    };
    const wrapped = instrumentedStep(stepInner, 'tracer', 'inst');
    await wrapped.sleep('pause', '5 seconds');
    expect(stepInner.sleep).toHaveBeenCalledWith('pause', '5 seconds');
    await wrapped.sleepUntil('wait', new Date(0));
    expect(stepInner.sleepUntil).toHaveBeenCalled();
  });

  it('wraps step.waitForEvent with its own span and propagates event.type', async () => {
    startActiveSpanMock.mockClear();
    const stepInner = {
      do: vi.fn(),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
      waitForEvent: vi.fn(async () => ({ approved: true })),
    };
    const wrapped = instrumentedStep(stepInner, 'tracer', 'inst-1');
    await wrapped.waitForEvent('await-approval', { type: 'manager-approval', timeout: '24 hours' });
    expect(startActiveSpanMock).toHaveBeenCalled();
    const [name, opts] = startActiveSpanMock.mock.calls.at(-1);
    expect(name).toBe('step.waitForEvent:await-approval');
    expect(opts.attributes['step.name']).toBe('await-approval');
    expect(opts.attributes['event.type']).toBe('manager-approval');
    expect(opts.attributes['workflow.id']).toBe('inst-1');
    expect(stepInner.waitForEvent).toHaveBeenCalledWith('await-approval', { type: 'manager-approval', timeout: '24 hours' });
  });
});
