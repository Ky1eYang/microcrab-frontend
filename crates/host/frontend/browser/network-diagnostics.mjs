// Browser networking has one diagnostic owner. Only trusted policy faults are
// forwarded verbatim; native exception text and URL paths may contain secrets.
const encoder = new TextEncoder();
function bounded(value, bytes) {
  let result = '';
  for (const character of value) {
    if (encoder.encode(result + character).byteLength > bytes) break;
    result += character;
  }
  return result;
}
export function browserHttpFailure(error, request, signal) {
  const known = ['denied', 'unsupported', 'invalid_request', 'limit', 'cancelled'];
  if (known.includes(error?.code)) return { code: error.code, message: bounded(String(error.message), 512) };
  let origin = '[invalid destination]';
  try {
    const url = new URL(request?.url);
    if (url.protocol === 'https:' || url.protocol === 'http:') origin = bounded(url.origin, 160);
  } catch { /* An invalid envelope has no safe destination to display. */ }
  const rawMethod = String(request?.method ?? 'GET');
  const method = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawMethod) && rawMethod.length <= 32 ? rawMethod : '[method omitted]';
  const cancelled = signal?.aborted;
  const detail = cancelled ? 'cancelled by the request owner' : 'failed; the browser withheld the cause (CORS, TLS, DNS or redirect rejection cannot be distinguished without further evidence)';
  return { code: cancelled ? 'cancelled' : 'io', message: bounded(`Browser HTTP ${method} ${origin} [path omitted] ${detail}`, 512) };
}
