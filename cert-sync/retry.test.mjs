import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultRetry, retryDependency, validateRetry, connectionUnavailable} from './retry.mjs';

test('transient dependency outage uses six attempts and exact bounded delays', async () => {
  let calls = 0; const waits = [];
  await assert.rejects(retryDependency(async () => { calls++; throw Object.assign(new Error('offline'), {code: 'ECONNREFUSED'}); },
    {wait: async ms => waits.push(ms)}), {code: 'dependency-retries-exhausted', attempts: 6});
  assert.equal(calls, 6); assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
});
test('success resets the next retry episode and preserves the max delay', async () => {
  const policy = {...defaultRetry, attempts: 9}; const waits = []; let calls = 0;
  const operation = async () => { if (++calls % 9) throw Object.assign(new Error('offline'), {code: 'source-503'}); return 'verified'; };
  for (let i = 0; i < 2; i++) assert.equal(await retryDependency(operation, {policy, wait: async ms => waits.push(ms)}), 'verified');
  assert.deepEqual(waits.slice(0, 8), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(waits[8], 1000);
});
test('authorization, TLS, certificate and state failures are not retried', async () => {
  for (const code of ['source-401', 'source-403', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'invalid-certificate', 'client-state-invalid']) {
    let calls = 0;
    await assert.rejects(retryDependency(async () => { calls++; throw Object.assign(new Error(code), {code}); }, {wait: async () => assert.fail('fatal retry')}), {code});
    assert.equal(calls, 1);
  }
});
test('termination interrupts backoff instead of starting another attempt', async () => {
  const stop = new AbortController(); let calls = 0;
  await assert.rejects(retryDependency(async () => { calls++; throw Object.assign(new Error('offline'), {code: 'ECONNRESET'}); },
    {signal: stop.signal, onRetry: () => stop.abort()}), {name: 'AbortError'});
  assert.equal(calls, 1);
});
test('invalid policies are rejected before any dependency call', async () => {
  for (const policy of [{...defaultRetry, attempts: 0}, {...defaultRetry, attempts: 21}, {...defaultRetry, initialDelayMillis: 0}]) {
    await assert.rejects(retryDependency(() => assert.fail('invalid policy executed'), {policy}), {code: 'invalid-retry-policy'});
  }
  assert.equal(connectionUnavailable({code: 'EAI_AGAIN'}), true);
  assert.equal(connectionUnavailable({code: 'ENOTFOUND'}), false);
  assert.deepEqual(validateRetry(defaultRetry), defaultRetry);
});
