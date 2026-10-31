export function makeFetch(responses = []) {
  const queue = [...responses];
  const calls = [];

  async function fetchImpl(url, init = {}) {
    const stringUrl = String(url);
    calls.push({ url: stringUrl, init });
    const next = queue.shift() ?? { status: 200, body: '', headers: {} };

    if (next.reject) {
      throw next.reject;
    }

    const status = next.status ?? 200;
    const statusText = next.statusText ?? (status === 200 ? 'OK' : status === 202 ? 'Accepted' : 'Error');
    const hasExplicitContentType = Object.keys(next.headers || {}).some(
      (k) => k.toLowerCase() === 'content-type'
    );
    const headers = new Headers(next.headers || {});
    const body = next.body ?? '';
    const response = new Response(body, { status, statusText, headers });
    if (!hasExplicitContentType) {
      response.headers.delete('content-type');
    }
    Object.defineProperty(response, 'url', {
      value: next.url || stringUrl,
      configurable: true
    });
    return response;
  }

  fetchImpl.calls = calls;
  return fetchImpl;
}
