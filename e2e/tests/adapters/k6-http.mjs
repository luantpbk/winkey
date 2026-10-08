export let httpCalls = [];
export let mockHttpHandler = null;

export function setMockHttpHandler(fn) {
  mockHttpHandler = fn;
}

export function resetHttpState() {
  httpCalls = [];
  mockHttpHandler = null;
}

function handleRequest(method, url, body, params) {
  const record = { method, url, body, params, timestamp: Date.now() };
  httpCalls.push(record);
  if (mockHttpHandler) {
    const res = mockHttpHandler(record);
    if (res) return res;
  }
  return {
    status: 200,
    body: JSON.stringify({ status: 'ok', items: [] }),
    headers: {},
    timings: { duration: 50 },
  };
}

export default {
  get: (url, params) => handleRequest('GET', url, null, params),
  post: (url, body, params) => handleRequest('POST', url, body, params),
  put: (url, body, params) => handleRequest('PUT', url, body, params),
  del: (url, body, params) => handleRequest('DELETE', url, body, params),
  request: (method, url, body, params) => handleRequest(method, url, body, params),
  batch: (requests) =>
    requests.map(([method, url, body, params]) => handleRequest(method, url, body, params)),
};
