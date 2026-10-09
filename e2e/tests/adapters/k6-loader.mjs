import { URL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'k6') {
    return {
      url: new URL('./k6-core.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (specifier === 'k6/http') {
    return {
      url: new URL('./k6-http.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (specifier === 'k6/metrics') {
    return {
      url: new URL('./k6-metrics.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (specifier === 'k6/data') {
    return {
      url: new URL('./k6-data.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
