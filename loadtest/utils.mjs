export function resolveUrl(relativeUrl, baseUrl) {
  if (!relativeUrl) return baseUrl;
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl;
  }
  if (relativeUrl.startsWith('/')) {
    const match = baseUrl.match(/^(https?:\/\/[^/]+)/);
    const origin = match ? match[1] : '';
    return origin + relativeUrl;
  }
  const lastSlash = baseUrl.lastIndexOf('/');
  if (lastSlash !== -1) {
    return baseUrl.substring(0, lastSlash + 1) + relativeUrl;
  }
  return baseUrl + '/' + relativeUrl;
}
