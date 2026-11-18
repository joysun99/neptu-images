import {join} from 'node:path';
import {protectedRead, atomicWrite} from './certificates.mjs';
import {hash} from './config.mjs';
import {settings, optional, locked} from './store.mjs';
export function traefikRoutes(cfg, policy, client) {
  const name = 'cert-sync-' + cfg.profile, routers = {}, services = {};
  const host = new URL(cfg.publicURL).hostname;
  const tls = {...(cfg.proxy.tlsOptions ? {options: cfg.proxy.tlsOptions} : {}), certResolver: cfg.proxy.resolver};
  services[name] = {loadBalancer: {servers: [{url: cfg.proxy.backendURL}], passHostHeader: true}};
  routers[name + '-console'] = {entryPoints: [cfg.proxy.secureEntryPoint],
    rule: 'Host(`' + host + '`) && (PathPrefix(`/console`) || PathPrefix(`/admin/`) || PathPrefix(`/v1/`) || Path(`/healthz`))',
    priority: 500, service: name, tls};
  if (cfg.role === 'leader') for (const domain of policy.domains) {
    routers[name + '-issue-' + hash(domain).slice(0, 12)] = {entryPoints: [cfg.proxy.secureEntryPoint],
      rule: 'Host(`' + domain + '`) && Path(`/.well-known/neptu/certificate-request`)',
      priority: 1, service: 'noop@internal', tls: {...tls,
        domains: [{main: domain}]}};
  }
  if (cfg.role === 'follower' && client?.phase === 'active' && policy.domains.length) {
    const source = new URL(client.invitation.sourceURL);
    services[name + '-challenge'] = {loadBalancer: {servers: [{url: 'http://' + source.hostname + ':80'}], passHostHeader: true}};
    routers[name + '-challenge'] = {entryPoints: [cfg.proxy.webEntryPoint],
      rule: '(' + policy.domains.map(d => 'Host(`' + d + '`)').join(' || ') + ') && PathPrefix(`/.well-known/acme-challenge/`)',
      priority: 10000, service: name + '-challenge'};
  }
  return {http: {routers, services}};
}
export async function renderProxy(cfg) {
  if (cfg.proxy.type !== 'traefik') return {adapter: 'files', rendered: false};
  return locked(cfg, async () => { const policy = await settings(cfg), client = await optional(cfg, 'client');
    const target = join(cfg.targetDirectory, 'cert-sync-' + cfg.profile + '-routes.yml');
    const bytes = JSON.stringify(traefikRoutes(cfg, policy, client), null, 2) + '\n';
    let old; try { old = await protectedRead(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old !== bytes) await atomicWrite(target, bytes); return {adapter: 'traefik', rendered: old !== bytes};
  });
}
