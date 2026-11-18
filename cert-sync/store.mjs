import {randomBytes, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {protectedRead, protectedDirectory, atomicWrite, withLock} from './certificates.mjs';
import {need, fields, domains, domain, hash, id, origin} from './config.mjs';
export const secret = () => randomBytes(32).toString('base64url');
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const file = (cfg, name) => join(cfg.stateDirectory, cfg.profile + '-' + name + '.json');
export async function read(cfg, name) { return JSON.parse(await protectedRead(file(cfg, name), 2 * 1024 * 1024)); }
export async function optional(cfg, name) { try { return await read(cfg, name); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
export async function write(cfg, name, value) { await atomicWrite(file(cfg, name), JSON.stringify(value) + '\n'); }
export const locked = (cfg, callback) => withLock({targetDirectory: cfg.stateDirectory, profile: 'state-' + cfg.profile, writerRetry: cfg.writerRetry}, callback);
export async function settings(cfg) { const s = await read(cfg, 'settings');
  need(s.schemaVersion === 1 && s.role === cfg.role && s.nodeId === cfg.nodeId && s.profile === cfg.profile
    && Number.isSafeInteger(s.revision), 'settings-scope-differs'); domains(s.domains); return s; }
export async function registry(cfg) { need(cfg.role === 'leader', 'leader-required'); const r = await read(cfg, 'registry');
  need(r.schemaVersion === 1 && r.profile === cfg.profile && uuid(r.serviceId)
    && Array.isArray(r.clients) && r.clients.length <= 256 && Array.isArray(r.tokens) && r.tokens.length <= 1024
    && Array.isArray(r.receipts) && r.receipts.length <= 1024, 'registry-invalid'); return r; }
export async function initialize(cfg) {
  for (const directory of [cfg.stateDirectory, cfg.targetDirectory]) { await mkdir(directory, {recursive: true, mode: 0o700}); await protectedDirectory(directory); }
  return locked(cfg, async () => {
    const prior = await optional(cfg, 'settings');
    if (prior) { await settings(cfg); if (cfg.role === 'leader') await registry(cfg); return {initialized: true, existing: true}; }
    if (cfg.role === 'leader') {
      need(!await optional(cfg, 'registry'), 'existing-registry-without-settings');
      await write(cfg, 'registry', {schemaVersion: 1, profile: cfg.profile, serviceId: randomUUID(), tokens: [], clients: [], receipts: []});
    }
    await write(cfg, 'settings', {schemaVersion: 1, role: cfg.role, nodeId: cfg.nodeId, profile: cfg.profile,
      revision: 1, domains: cfg.domains}); return {initialized: true};
  });
}
export async function setDomains(cfg, values, expectedRevision) {
  const next = domains(values); need(!next.includes(new URL(cfg.publicURL).hostname), 'transport-domain-cannot-be-shared');
  return locked(cfg, async () => { const s = await settings(cfg);
    if (expectedRevision !== undefined) need(s.revision === expectedRevision, 'policy-conflict');
    const value = {...s, revision: s.revision + 1, domains: next}; await write(cfg, 'settings', value); return value;
  });
}
export async function createInvitation(cfg, nodeId, values, ttlSeconds = 3600) {
  need(cfg.role === 'leader' && id(nodeId) && Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 86400, 'invalid-invitation');
  const list = domains(values, true);
  return locked(cfg, async () => { const s = await settings(cfg), r = await registry(cfg);
    need(list.every(d => s.domains.includes(d)), 'domain-not-managed');
    need(r.tokens.length < 1024, 'registry-capacity');
    const invitation = {schemaVersion: 1, id: randomUUID(), serviceId: r.serviceId, profile: cfg.profile,
      nodeId, domains: list, sourceURL: cfg.publicURL + '/v1/certificates/' + cfg.profile,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(), token: secret()};
    r.tokens.push({...invitation, token: undefined, tokenSHA256: hash(invitation.token), consumedBy: null});
    await write(cfg, 'registry', r); return invitation;
  });
}
export function invitation(value) {
  fields(value, ['schemaVersion', 'id', 'serviceId', 'profile', 'nodeId', 'domains', 'sourceURL', 'expiresAt', 'token']);
  need(value.schemaVersion === 1 && uuid(value.id) && uuid(value.serviceId) && id(value.nodeId) && id(value.profile)
    && /^[A-Za-z0-9_-]{43}$/.test(value.token) && Number.isFinite(Date.parse(value.expiresAt)), 'invalid-invitation');
  domains(value.domains, true); const u = new URL(value.sourceURL); origin(u.origin);
  need(u.pathname === '/v1/certificates/' + value.profile && !u.search && !u.hash && !u.username && !u.password, 'invalid-source'); return value;
}
export function joinRequest(value) {
  fields(value, ['schemaVersion', 'operationId', 'nodeId', 'credentialSHA256', 'domains', 'invitationId', 'serviceId']);
  need(value.schemaVersion === 1 && uuid(value.operationId) && id(value.nodeId) && uuid(value.invitationId)
    && uuid(value.serviceId) && /^[a-f0-9]{64}$/.test(value.credentialSHA256), 'invalid-join');
  return {schemaVersion: 1, operationId: value.operationId, nodeId: value.nodeId,
    credentialSHA256: value.credentialSHA256, domains: domains(value.domains, true),
    invitationId: value.invitationId, serviceId: value.serviceId};
}
export async function acceptJoin(cfg, value, bootstrapToken) {
  const request = joinRequest(value), digest = hash(JSON.stringify(request));
  return locked(cfg, async () => { const r = await registry(cfg), s = await settings(cfg);
    need(request.serviceId === r.serviceId, 'wrong-leader');
    const saved = r.receipts.find(x => x.operationId === request.operationId);
    if (saved) { const c = r.clients.find(x => x.nodeId === request.nodeId);
      need(saved.requestSHA256 === digest && saved.joinTokenSHA256 === hash(bootstrapToken)
        && c && !c.revoked && c.operationId === request.operationId, 'join-recovery-refused'); return saved.ack; }
    const token = r.tokens.find(x => x.id === request.invitationId && x.tokenSHA256 === hash(bootstrapToken));
    need(token && !token.consumedBy && Date.parse(token.expiresAt) > Date.now()
      && token.nodeId === request.nodeId && request.domains.every(d => token.domains.includes(d) && s.domains.includes(d)), 'join-not-authorized');
    need(!r.clients.some(c => c.nodeId === request.nodeId), 'node-already-registered');
    need(r.clients.length < 256 && r.receipts.length < 1024, 'registry-capacity');
    const ack = {joined: true, serviceId: r.serviceId, nodeId: request.nodeId, operationId: request.operationId,
      requestSHA256: digest, credentialSHA256: request.credentialSHA256};
    r.clients.push({nodeId: request.nodeId, operationId: request.operationId, tokenSHA256: request.credentialSHA256,
      domains: request.domains, revoked: false, joinedAt: new Date().toISOString()});
    token.consumedBy = request.operationId;
    r.receipts.push({operationId: request.operationId, requestSHA256: digest, joinTokenSHA256: hash(bootstrapToken), ack});
    await write(cfg, 'registry', r); return ack;
  });
}
export async function changeClient(cfg, nodeId, values) {
  return locked(cfg, async () => { const r = await registry(cfg), s = await settings(cfg);
    const c = r.clients.find(c => c.nodeId === nodeId); need(c, 'unknown-node');
    if (values === null) c.revoked = true;
    else { const list = domains(values, true); need(!c.revoked && list.every(d => s.domains.includes(d)), 'domain-not-managed'); c.domains = list; }
    await write(cfg, 'registry', r); return {nodeId: c.nodeId, domains: c.domains, revoked: c.revoked};
  });
}
export async function prepareJoin(cfg, incoming) {
  need(cfg.role === 'follower', 'follower-required'); const v = invitation(incoming);
  need(v.nodeId === cfg.nodeId && v.profile === cfg.profile, 'wrong-node');
  need(!v.domains.includes(new URL(cfg.publicURL).hostname), 'transport-domain-cannot-be-shared');
  return locked(cfg, async () => {
    const current = await optional(cfg, 'client');
    if (current) { need(current.invitation.id === v.id && (current.invitation.tokenSHA256 ?? hash(current.invitation.token)) === hash(v.token), 'existing-join-preserved'); return current; }
    const token = secret(); const request = joinRequest({schemaVersion: 1, operationId: randomUUID(), nodeId: cfg.nodeId,
      credentialSHA256: hash(token), domains: v.domains, invitationId: v.id, serviceId: v.serviceId});
    const client = {schemaVersion: 1, nodeId: cfg.nodeId, profile: cfg.profile, phase: 'pending', token, invitation: v, request};
    await write(cfg, 'client', client); const s = await settings(cfg);
    if (!s.domains.length) await write(cfg, 'settings', {...s, revision: s.revision + 1, domains: v.domains});
    return client;
  });
}
export async function finishJoin(cfg, ack) {
  return locked(cfg, async () => { const c = await read(cfg, 'client'); const request = joinRequest(c.request);
    need(ack.joined && ack.serviceId === c.invitation.serviceId && ack.operationId === request.operationId
      && ack.nodeId === cfg.nodeId && ack.credentialSHA256 === hash(c.token)
      && ack.requestSHA256 === hash(JSON.stringify(request)), 'join-ack-differs');
    const active = {...c, phase: 'active', invitation: {...c.invitation, token: undefined, tokenSHA256: c.invitation.tokenSHA256 ?? hash(c.invitation.token)}}; await write(cfg, 'client', active); return active;
  });
}
