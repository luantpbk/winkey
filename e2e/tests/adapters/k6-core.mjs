export let lastFailedMessage = null;
export let sleepCalls = [];

export function sleep(seconds) {
  sleepCalls.push(seconds);
}

export function fail(message) {
  lastFailedMessage = message;
  const err = new Error(message || 'k6 fail() called');
  err.name = 'K6FailError';
  throw err;
}

export function check() {
  return true;
}

export function group(name, fn) {
  return fn();
}

export function resetCoreState() {
  lastFailedMessage = null;
  sleepCalls = [];
}
