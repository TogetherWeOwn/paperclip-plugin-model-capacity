/**
 * Byte-capped response body reads. A declared content-length over the cap is
 * refused before any read; a streamed body is read chunk by chunk and
 * cancelled as soon as the running total crosses the cap, so an oversized or
 * endless body never lands in memory whole. Response-like objects without a
 * stream fall back to text() plus a size check.
 */

export class ResponseTooLargeError extends Error {
  constructor(code = 'response-too-large') {
    super(code);
    this.name = 'ResponseTooLargeError';
  }
}

function declaredLength(response) {
  const raw = typeof response?.headers?.get === 'function' ? response.headers.get('content-length') : null;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Body text, or throws ResponseTooLargeError past maxBytes. Other read
 * failures propagate unchanged.
 */
export async function readBoundedText(response, maxBytes, code = 'response-too-large') {
  const declared = declaredLength(response);
  if (declared != null && declared > maxBytes) throw new ResponseTooLargeError(code);
  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(code);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new ResponseTooLargeError(code);
  return text;
}
