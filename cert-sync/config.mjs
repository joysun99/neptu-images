import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {isAbsolute, resolve} from 'node:path';
import {protectedRead} from './certificates.mjs';
export const hash = value => createHash('sha256').update(value).digest('hex');
export function need(ok, code) { if (!ok) { const error = new Error(code); error.code = code; throw error; } }
export const fields = (value, allowed) => need(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(k => allowed.includes(k)), 'invalid-fields');
export const id = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
export const domain = value => typeof value === 'string' && value.length <= 253 && value.includes('.') && !isIP(value)
  && value.split('.').every(v => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v));
export function domains(value, nonempty = false) { need(Array.isArray(value) && value.length <= 16
  && (!nonempty || value.length > 0) && value.every(domain) && new Set(value).size === value.length, 'invalid-domains'); return [...value].sort(); }
export function path(value) { need(typeof value === 'string' && isAbsolute(value) && value !== '/'
  && resolve(value) === value && !/[\r\n\0,]/.test(value), 'invalid-path'); return value; }
export function integer(v, a, b) { need(Number.isSafeInteger(v) && v >= a && v <= b, 'invalid-number'); }
export function origin(value, protocol = 'https:') { let u; try { u = new URL(value); } catch { need(false, 'invalid-url'); }
  need(u.protocol === protocol && domain(u.hostname) && !u.username && !u.password && !u.search && !u.hash
    && u.pathname === '/', 'invalid-url'); return u.origin; }
export function validateConfig(input) {
  fields(input, ['schemaVersion', 'role', 'nodeId', 'profile', 'domains', 'publicURL', 'stateDirectory', 'targetDirectory',
    'acmeFile', 'adminTokenFile', 'listen', 'port', 'intervalSeconds', 'retrySeconds', 'minimumValiditySeconds',
    'healthMaxAgeSeconds', 'healthMinimumRemainingSeconds', 'sourceCAFile', 'connectAddress', 'proxy']);
  need(input.schemaVersion === 1 && ['leader', 'follower'].includes(input.role) && id(input.nodeId), 'invalid-role-or-node');
  const cfg = {profile: 'shared', domains: [], stateDirectory: '/var/lib/cert-sync', targetDirectory: '/etc/traefik/dynamic',
    acmeFile: '/run/acme/acme.json', adminTokenFile: '/run/secrets/admin-token', listen: '0.0.0.0', port: 8080,
    intervalSeconds: 3600, retrySeconds: 30, minimumValiditySeconds: 86400, healthMaxAgeSeconds: 86400,
    healthMinimumRemainingSeconds: 604800, proxy: {type: 'traefik', backendURL: 'http://cert-sync:8080',
      resolver: 'letsencrypt', webEntryPoint: 'web', secureEntryPoint: 'websecure'}, ...input};
  need(id(cfg.profile) && isIP(cfg.listen), 'invalid-profile-or-listen'); cfg.publicURL = origin(cfg.publicURL);
  cfg.domains = domains(cfg.domains); need(!cfg.domains.includes(new URL(cfg.publicURL).hostname), 'transport-domain-cannot-be-shared');
  for (const key of ['stateDirectory', 'targetDirectory', 'acmeFile', 'adminTokenFile']) path(cfg[key]);
  if (cfg.sourceCAFile) path(cfg.sourceCAFile); if (cfg.connectAddress) need(isIP(cfg.connectAddress), 'invalid-connect-address');
  integer(cfg.port, 1024, 65535); integer(cfg.intervalSeconds, 60, 86400); integer(cfg.retrySeconds, 1, 3600);
  integer(cfg.minimumValiditySeconds, 3600, 2592000); integer(cfg.healthMaxAgeSeconds, cfg.intervalSeconds * 2, 2592000);
  integer(cfg.healthMinimumRemainingSeconds, cfg.minimumValiditySeconds, 7776000);
  fields(cfg.proxy, ['type', 'backendURL', 'resolver', 'webEntryPoint', 'secureEntryPoint']);
  cfg.proxy = {type: 'traefik', backendURL: 'http://cert-sync:8080', resolver: 'letsencrypt', webEntryPoint: 'web', secureEntryPoint: 'websecure', ...cfg.proxy};
  need(['traefik', 'files'].includes(cfg.proxy.type), 'unsupported-proxy');
  const backend = new URL(cfg.proxy.backendURL); need(backend.protocol === 'http:' && backend.pathname === '/' && !backend.username && !backend.password && !backend.search && !backend.hash, 'invalid-backend');
  for (const k of ['resolver', 'webEntryPoint', 'secureEntryPoint']) need(id(cfg.proxy[k]), 'invalid-proxy-name');
  return cfg;
}
export async function loadConfig(file) { return validateConfig(JSON.parse(await protectedRead(file, 65536))); }
