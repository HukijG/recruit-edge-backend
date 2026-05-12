import { env } from 'cloudflare:workers';
import { trace } from '@opentelemetry/api';

const REDACT_BODY_FIELD = /^(password|secret|token|api_key|apikey|client_secret|private_key)$/i;
const REDACT_QUERY_PARAM = /secret|token|api[_-]?key|apikey|email|linkedin|phone|attendee_email|attendee_phone/i;
const TEXT_CT_RE = /^(application\/json|text\/|application\/x-www-form-urlencoded)/i;
const MAX_BODY_BYTES = 32 * 1024;

let installed = false;

export function installBodyCapture() {
  // Emergency kill switch — wholesale disables both the fetch wrapper and any body capture.
  // Independent of LOG_NO_BODY (which only suppresses body content while still wrapping fetch).
  if (env && env.OTEL_DISABLED === '1') return;
  if (installed) return;
  installed = true;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async function bodyCapturingFetch(input, init) {
    if (env && env.LOG_NO_BODY === '1') return realFetch(input, init);

    let requestBody = null;
    try { requestBody = await safeReadRequestBody(input, init); } catch { /* swallow */ }

    const response = await realFetch(input, init);

    let responseBody = null;
    try {
      const cloned = response.clone();
      responseBody = await safeReadResponseBody(cloned);
    } catch { /* swallow */ }

    const span = trace.getActiveSpan();
    if (span) {
      try {
        if (requestBody !== null) span.setAttribute('http.request.body', requestBody);
        if (responseBody !== null) span.setAttribute('http.response.body', responseBody);
        const urlString = typeof input === 'string' ? input : (input && input.url) || '';
        if (urlString) span.setAttribute('url.full.redacted', redactQueryParams(urlString));
      } catch { /* never throw on telemetry */ }
    }

    return response;
  };
}

async function safeReadRequestBody(input, init) {
  // The @microlabs proxy normalises (input, init) into a Request and invokes the inner
  // wrapped fetch as fetch(Request, undefined). In that case init?.body is falsy — the
  // body is owned by the Request object. Read it via input.clone().text() instead.
  try {
    if (init && init.body) {
      const ct = (init.headers && getHeader(init.headers, 'content-type')) || '';
      if (!TEXT_CT_RE.test(ct)) return null;
      let text;
      if (typeof init.body === 'string') text = init.body;
      else if (init.body instanceof URLSearchParams) text = init.body.toString();
      else if (typeof init.body.text === 'function') text = await init.body.text();
      else return null;
      return processBody(text);
    }
    if (input && typeof input === 'object' && typeof input.clone === 'function' && typeof input.text === 'function') {
      const ct = (input.headers && typeof input.headers.get === 'function' && input.headers.get('content-type')) || '';
      if (!TEXT_CT_RE.test(ct)) return null;
      const text = await input.clone().text();
      return processBody(text);
    }
  } catch { return null; }
  return null;
}

async function safeReadResponseBody(response) {
  const ct = response.headers.get('content-type') || '';
  if (!TEXT_CT_RE.test(ct)) {
    return JSON.stringify({ 'content-type': ct, 'body.size': Number(response.headers.get('content-length') || 0) });
  }
  return await streamReadWithBudget(response);
}

async function streamReadWithBudget(response) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // Fallback for environments where .body is not a stream — bounded text read.
    try {
      const text = await response.text();
      return processBody(text);
    } catch { return null; }
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let acc = '';
  let totalBytes = 0;
  let overflowed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (!overflowed) {
        acc += decoder.decode(value, { stream: true });
        if (totalBytes > MAX_BODY_BYTES) {
          overflowed = true;
          // Fire-and-forget: awaiting cancel() can deadlock on a tee branch in some
          // runtimes (Node) when the sibling branch is still pending consumption.
          // The cancel signal is enough — release resources opportunistically.
          try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
          break;
        }
      }
    }
    if (!overflowed) acc += decoder.decode();
  } catch {
    try { reader.releaseLock(); } catch { /* ignore */ }
    return null;
  }

  if (!acc) return null;
  if (overflowed) {
    const truncated = acc.length > MAX_BODY_BYTES ? acc.slice(0, MAX_BODY_BYTES) : acc;
    return redactBodyFields(truncated + `…[truncated, original >${MAX_BODY_BYTES} bytes]`);
  }
  return redactBodyFields(acc);
}

function processBody(text) {
  if (!text) return null;
  const truncated = text.length > MAX_BODY_BYTES
    ? text.slice(0, MAX_BODY_BYTES) + `…[truncated, original ${text.length} bytes]`
    : text;
  return redactBodyFields(truncated);
}

function redactBodyFields(text) {
  try {
    const obj = JSON.parse(text);
    return JSON.stringify(redactObj(obj));
  } catch { return text; }
}

function redactObj(o) {
  if (Array.isArray(o)) return o.map(redactObj);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = REDACT_BODY_FIELD.test(k) ? '[REDACTED]' : redactObj(v);
    }
    return out;
  }
  return o;
}

function getHeader(headers, name) {
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found ? found[1] : null;
  }
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
  }
  return null;
}

function redactQueryParams(urlString) {
  try {
    const u = new URL(urlString);
    for (const k of [...u.searchParams.keys()]) {
      if (REDACT_QUERY_PARAM.test(k)) u.searchParams.set(k, '[REDACTED]');
    }
    return u.toString();
  } catch { return urlString; }
}
