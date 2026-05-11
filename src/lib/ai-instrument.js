import { trace, SpanStatusCode } from '@opentelemetry/api';

const MAX_AI_BODY_BYTES = 32 * 1024;

export async function runAI(env, modelName, input, options) {
  if (options && options.stream === true) {
    throw new Error('runAI: streaming-mode AI calls are not instrumented in v3; add support if needed.');
  }
  const tracer = trace.getTracer('ai-instrument');
  return await tracer.startActiveSpan(
    'ai.run',
    {
      attributes: {
        'ai.model': modelName,
        'ai.input.shape': describeInputShape(input),
        'ai.request.body': truncate(safeStringify(input || {})),
      },
    },
    async (span) => {
      const t0 = Date.now();
      try {
        const result = await env.AI.run(modelName, input, options);
        const duration = Date.now() - t0;
        span.setAttribute('ai.duration_ms', duration);
        if (result && typeof result === 'object') {
          if (result.usage && typeof result.usage === 'object') {
            const u = result.usage;
            // OpenAI-style models surface as prompt_tokens/completion_tokens;
            // Anthropic-style as input_tokens/output_tokens. CF hosts both.
            const inputTokens = typeof u.prompt_tokens === 'number' ? u.prompt_tokens
                        : typeof u.input_tokens === 'number' ? u.input_tokens
                        : null;
            const outputTokens = typeof u.completion_tokens === 'number' ? u.completion_tokens
                         : typeof u.output_tokens === 'number' ? u.output_tokens
                         : null;
            if (inputTokens !== null) span.setAttribute('ai.tokens.input', inputTokens);
            if (outputTokens !== null) span.setAttribute('ai.tokens.output', outputTokens);
            if (typeof u.total_tokens === 'number') span.setAttribute('ai.tokens.total', u.total_tokens);
            else if (inputTokens !== null && outputTokens !== null) span.setAttribute('ai.tokens.total', inputTokens + outputTokens);
          }
          span.setAttribute('ai.response.body', truncate(safeStringify(result)));
        }
        return result;
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || err) });
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

function describeInputShape(input) {
  if (!input || typeof input !== 'object') return 'unknown';
  if (Array.isArray(input.messages)) return `chat(${input.messages.length})`;
  if (typeof input.prompt === 'string') return `prompt(${input.prompt.length}c)`;
  if (typeof input.text === 'string') return `text(${input.text.length}c)`;
  return Object.keys(input).join(',');
}

function truncate(text) {
  if (text.length <= MAX_AI_BODY_BYTES) return text;
  return text.slice(0, MAX_AI_BODY_BYTES) + `…[truncated, original ${text.length} bytes]`;
}

function safeStringify(o) {
  try { return JSON.stringify(o); }
  catch { return String(o); }
}
