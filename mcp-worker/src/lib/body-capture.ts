import { env } from 'cloudflare:workers';
import { trace } from '@opentelemetry/api';

const REDACT_BODY_FIELD = /^(password|secret|token|api_key|apikey|client_secret|private_key)$/i;
const REDACT_QUERY_PARAM = /secret|token|api[_-]?key|apikey/i;
const MAX_BODY_BYTES = 32 * 1024;

let installed = false;

export function installBodyCapture(): void {
  if (installed) return;
  installed = true;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async function bodyCapturingFetch(input: any, init?: any): Promise<Response> {
    if (env && (env as any).LOG_NO_BODY === '1') return realFetch(input, init);

    let requestBody: string | null = null;
    try { requestBody = await safeReadRequestBody(init); } catch { /* swallow */ }

    const response = await realFetch(input, init);

    let responseBody: string | null = null;
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
  } as typeof globalThis.fetch;
}

async function safeReadRequestBody(init: any): Promise<string | null> {
  if (!init || !init.body) return null;
  const ct = (init.headers && getHeader(init.headers, 'content-type')) || '';
  if (!ct.match(/^(application\/json|text\/|application\/x-www-form-urlencoded)/i)) return null;
  let text: string;
  try {
    if (typeof init.body === 'string') text = init.body;
    else if (init.body instanceof URLSearchParams) text = init.body.toString();
    else if (typeof init.body.text === 'function') text = await init.body.text();
    else return null;
  } catch { return null; }
  return processBody(text);
}

async function safeReadResponseBody(response: Response): Promise<string | null> {
  const ct = response.headers.get('content-type') || '';
  if (!ct.match(/^(application\/json|text\/|application\/x-www-form-urlencoded)/i)) {
    return JSON.stringify({ 'content-type': ct, 'body.size': Number(response.headers.get('content-length') || 0) });
  }
  let text: string;
  try { text = await response.text(); } catch { return null; }
  return processBody(text);
}

function processBody(text: string): string | null {
  if (!text) return null;
  const truncated = text.length > MAX_BODY_BYTES
    ? text.slice(0, MAX_BODY_BYTES) + `…[truncated, original ${text.length} bytes]`
    : text;
  return redactBodyFields(truncated);
}

function redactBodyFields(text: string): string {
  try {
    const obj = JSON.parse(text);
    return JSON.stringify(redactObj(obj));
  } catch { return text; }
}

function redactObj(o: any): any {
  if (Array.isArray(o)) return o.map(redactObj);
  if (o && typeof o === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = REDACT_BODY_FIELD.test(k) ? '[REDACTED]' : redactObj(v);
    }
    return out;
  }
  return o;
}

function getHeader(headers: any, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([k]: [string, string]) => k.toLowerCase() === name.toLowerCase());
    return found ? found[1] : null;
  }
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) return v as string;
    }
  }
  return null;
}

function redactQueryParams(urlString: string): string {
  try {
    const u = new URL(urlString);
    for (const k of [...u.searchParams.keys()]) {
      if (REDACT_QUERY_PARAM.test(k)) u.searchParams.set(k, '[REDACTED]');
    }
    return u.toString();
  } catch { return urlString; }
}
