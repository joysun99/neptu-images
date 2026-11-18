import {setTimeout as sleep} from 'node:timers/promises';

export const defaultRetry = Object.freeze({attempts: 6, initialDelayMillis: 1000, maxDelayMillis: 30000});
export function validateRetry(policy) {
  if (!policy || !Number.isSafeInteger(policy.attempts) || policy.attempts < 1 || policy.attempts > 20
    || !Number.isSafeInteger(policy.initialDelayMillis) || policy.initialDelayMillis < 1
    || !Number.isSafeInteger(policy.maxDelayMillis) || policy.initialDelayMillis > policy.maxDelayMillis
    || policy.maxDelayMillis > 3600000) throw Object.assign(new Error('invalid-retry-policy'), {code: 'invalid-retry-policy'});
  return policy;
}
export function connectionUnavailable(error) {
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
    'EPIPE', 'source-timeout', 'source-408', 'source-429', 'source-502', 'source-503', 'source-504'].includes(error?.code);
}
export async function retryDependency(operation, {policy = defaultRetry, signal, onRetry = () => {}, wait = sleep} = {}) {
  validateRetry(policy);
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      signal?.throwIfAborted();
      if (!connectionUnavailable(error)) throw error;
      if (attempt === policy.attempts) throw Object.assign(new Error('dependency-retries-exhausted'),
        {code: 'dependency-retries-exhausted', attempts: attempt, cause: error});
      const delayMillis = Math.min(policy.maxDelayMillis, policy.initialDelayMillis * 2 ** (attempt - 1));
      await onRetry({attempt, delayMillis, code: error.code});
      await wait(delayMillis, undefined, {signal});
    }
  }
}
