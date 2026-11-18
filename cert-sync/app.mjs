import http from 'node:http';
import https from 'node:https';
import {timingSafeEqual} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {setTimeout as sleep} from 'node:timers/promises';
import {retryDependency} from './retry.mjs';
import * as cert from './certificates.mjs';
import * as store from './store.mjs';
import {need, fields, domains, hash, loadConfig} from './config.mjs';
import {renderProxy} from './proxy.mjs';
import {PAGE, SCRIPT} from './console.mjs';
const flights = new Map();
const safeCode = error => /^[a-zA-Z0-9_-]{1,80}$/.test(error?.code) ? error.code : 'operation-failed';
const tokenShape = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export async function effective(cfg) { return {...cfg, domains: (await store.settings(cfg)).domains}; }
async function client(cfg) { const c = await store.read(cfg, 'client');
  need(c.schemaVersion === 1 && c.nodeId === cfg.nodeId && c.profile === cfg.profile && tokenShape(c.token)
    && ['pending', 'active'].includes(c.phase) && hash(c.token) === c.request.credentialSHA256
    && c.invitation.serviceId === c.request.serviceId, 'client-state-invalid'); return c; }
export async function requestJSON(cfg, url, token, body, options = {}) {
  const endpoint = new URL(url); need(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password, 'https-required');
  const raw = Buffer.from(JSON.stringify(body)), ca = cfg.sourceCAFile ? await cert.protectedRead(cfg.sourceCAFile, 262144) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request({hostname: endpoint.hostname, servername: endpoint.hostname, port: endpoint.port || 443,
      path: endpoint.pathname, method: 'POST', ca, signal: options.signal, rejectUnauthorized: true, minVersion: 'TLSv1.2', agent: false,
      ...(cfg.connectAddress ? {lookup: (_name, options, done) => options.all
        ? done(null, [{address: cfg.connectAddress, family: cfg.connectAddress.includes(':') ? 6 : 4}])
        : done(null, cfg.connectAddress, cfg.connectAddress.includes(':') ? 6 : 4)} : {}),
      headers: {'authorization': 'Bearer ' + token, 'content-type': 'application/json', 'content-length': raw.length}}, res => {
      if (res.statusCode !== 200) { res.resume(); reject(Object.assign(new Error('source-refused'), {code: 'source-' + res.statusCode})); return; }
      const parts = []; let size = 0;
      res.on('data', b => { size += b.length; if (size > 1024 * 1024) res.destroy(new Error('oversized-response')); else parts.push(b); });
      res.on('error', reject); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts))); } catch { reject(new Error('invalid-response')); } });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('source-timeout'), {code: 'source-timeout'})), 30000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(raw);
  });
}
export async function join(cfg, invitation, options = {}) {
  need(cfg.role === 'follower', 'follower-required');
  const c = await store.prepareJoin(cfg, invitation);
  if (c.phase === 'active') return {joined: true, nodeId: c.nodeId, serviceId: c.invitation.serviceId};
  const ack = await requestJSON(cfg, c.invitation.sourceURL.replace('/certificates/', '/join/'), c.invitation.token, c.request, options);
  const active = await store.finishJoin(cfg, ack); await renderProxy(cfg);
  return {joined: true, nodeId: active.nodeId, serviceId: active.invitation.serviceId};
}
export async function syncOnce(cfg, options = {}) {
  const key = cfg.stateDirectory + '/' + cfg.profile;
  if (flights.has(key)) return flights.get(key);
  const task = (async () => {
    need(cfg.role === 'follower', 'follower-required'); let c = await client(cfg);
    if (c.phase === 'pending') { await join(cfg, c.invitation, options); c = await client(cfg); }
    const policy = await store.settings(cfg), current = {...cfg, domains: policy.domains}, revision = policy.revision;
    const value = current.domains.length
      ? await requestJSON(cfg, c.invitation.sourceURL, c.token, {domains: current.domains}, options)
      : {schemaVersion: 1, serviceId: c.invitation.serviceId, certificates: []};
    need(value.serviceId === c.invitation.serviceId, 'wrong-leader');
    await store.locked(cfg, async () => {
      need((await store.settings(cfg)).revision === revision, 'policy-changed');
      const active = await client(cfg); need(active.phase === 'active' && active.request.operationId === c.request.operationId, 'client-changed');
      await cert.publishBundle(value, current, options);
    });
    const result = {event: 'cert-sync-complete', at: new Date().toISOString(), domains: current.domains};
    await store.write(cfg, 'last-sync', result); return result;
  })();
  flights.set(key, task);
  try { return await task; } finally { flights.delete(key); }
}
async function leaderCertificates(cfg, requested, options) {
  const acme = JSON.parse(await cert.protectedRead(cfg.acmeFile, 16 * 1024 * 1024));
  return cert.selectAcmeCertificates(acme, {...cfg, domains: requested}, options);
}
export async function state(cfg, options = {}) {
  const s = await store.settings(cfg), current = {...cfg, domains: s.domains};
  let health = {healthy: false}, certificates = [];
  if (cfg.role === 'leader') {
    await store.registry(cfg);
    for (const host of s.domains) {
      try { const value = await leaderCertificates(cfg, [host], options);
        certificates.push({...cert.metadata(cert.validateBundle(value, {...cfg, domains: [host]}, options))[0], status: 'ready'});
      } catch (error) { certificates.push({host, status: 'pending-or-invalid', code: safeCode(error)}); }
    }
    health = {healthy: certificates.every(c => c.status === 'ready' && Date.parse(c.expiresAt)
      > (options.now ?? Date.now()) + cfg.healthMinimumRemainingSeconds * 1000)};
  } else {
    try { const c = await client(cfg); need(c.phase === 'active', 'join-pending');
      const result = await cert.health(current, options); certificates = result.certificates; health = result;
    } catch (error) { health = {healthy: false, code: safeCode(error)}; }
  }
  const last = await store.optional(cfg, 'last-sync');
  const membership = cfg.role === 'leader'
    ? (await store.registry(cfg)).clients.map(c => ({nodeId: c.nodeId, domains: c.domains, revoked: c.revoked, joinedAt: c.joinedAt}))
    : await store.optional(cfg, 'client').then(c => c ? {phase: c.phase, serviceId: c.invitation.serviceId, sourceURL: c.invitation.sourceURL} : {phase: 'not-joined'});
  return {role: cfg.role, nodeId: cfg.nodeId, profile: cfg.profile, domains: s.domains,
    revision: s.revision, publicURL: cfg.publicURL, proxy: cfg.proxy.type, ...health, certificates, membership, lastSync: last};
}
async function admin(cfg, supplied) {
  const expected = (await cert.protectedRead(cfg.adminTokenFile, 256)).trim();
  need(tokenShape(expected), 'invalid-admin-token');
  return typeof supplied === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(supplied)
    && timingSafeEqual(Buffer.from(hash(supplied.slice(7)), 'hex'), Buffer.from(hash(expected), 'hex'));
}
const bearer = req => { need(typeof req.headers.authorization === 'string'
  && /^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization), 'unauthorized'); return req.headers.authorization.slice(7); };
async function body(req) {
  const parts = []; let size = 0;
  for await (const b of req) { size += b.length; need(size <= 16384, 'request-too-large'); parts.push(b); }
  return JSON.parse(Buffer.concat(parts));
}
export function createServer(cfg, options = {}) {
  let inFlight = 0;
  const server = http.createServer({requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 8192}, async (req, res) => {
    const json = (status, value) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'}); res.end(JSON.stringify(value)); };
    const staticFile = (type, value) => { res.writeHead(200, {'content-type': type, 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff'}); res.end(value); };
    if (req.method === 'GET' && ['/console', '/console/'].includes(req.url)) { staticFile('text/html; charset=utf-8', PAGE); return; }
    if (req.method === 'GET' && req.url === '/console/app.js') { staticFile('text/javascript; charset=utf-8', SCRIPT); return; }
    if (req.method === 'GET' && req.url === '/livez') { json(200, {alive: true}); return; }
    if (req.method === 'GET' && req.url === '/healthz') { try { const s = await state(cfg, options); json(s.healthy ? 200 : 503, {healthy: s.healthy}); } catch { json(503, {healthy: false}); } return; }
    if (inFlight >= 4) { req.resume(); json(503, {error: 'busy'}); return; } inFlight++;
    try {
      if (req.url.startsWith('/admin/')) {
        need(await admin(cfg, req.headers.authorization), 'unauthorized');
        if (req.method === 'GET' && req.url === '/admin/state') { json(200, await state(cfg, options)); return; }
        need(req.method === 'POST', 'not-found'); const value = await body(req);
        if (req.url === '/admin/domains') { fields(value, ['domains', 'revision']); await store.setDomains(cfg, value.domains, value.revision); await renderProxy(cfg); json(200, await state(cfg, options)); return; }
        if (req.url === '/admin/invitations') { fields(value, ['nodeId', 'domains', 'ttlSeconds']); json(200, await store.createInvitation(cfg, value.nodeId, value.domains, value.ttlSeconds ?? 3600)); return; }
        if (req.url === '/admin/join') { fields(value, ['invitation']); json(200, await join(cfg, value.invitation)); return; }
        if (req.url === '/admin/sync') { fields(value, []); json(200, await syncOnce(cfg, options)); return; }
        if (req.url === '/admin/revoke') { fields(value, ['nodeId']); json(200, await store.changeClient(cfg, value.nodeId, null)); return; }
        if (req.url === '/admin/grants') { fields(value, ['nodeId', 'domains']); json(200, await store.changeClient(cfg, value.nodeId, value.domains)); return; }
        need(false, 'not-found');
      }
      need(cfg.role === 'leader' && req.method === 'POST', 'not-found');
      if (req.url === '/v1/join/' + cfg.profile) { const token = bearer(req); json(200, await store.acceptJoin(cfg, await body(req), token)); return; }
      need(req.url === '/v1/certificates/' + cfg.profile, 'not-found');
      const token = bearer(req), request = await body(req); fields(request, ['domains']); const list = domains(request.domains, true);
      const permitted = async () => { const r = await store.registry(cfg), s = await store.settings(cfg);
        const c = r.clients.find(c => !c.revoked && c.tokenSHA256 === hash(token));
        need(c && list.every(d => c.domains.includes(d) && s.domains.includes(d)), 'domain-not-authorized'); return r; };
      const r = await permitted(), value = await leaderCertificates(cfg, list, options);
      await permitted(); json(200, {...value, serviceId: r.serviceId});
    } catch (error) {
      const code = safeCode(error), status = code === 'unauthorized' ? 401
        : ['domain-not-authorized', 'join-not-authorized', 'join-recovery-refused'].includes(code) ? 403
        : ['node-already-registered', 'policy-conflict', 'existing-join-preserved'].includes(code) ? 409
        : code === 'not-found' ? 404 : code.startsWith('invalid') || error instanceof SyntaxError ? 400 : 503;
      if (!res.headersSent && !res.destroyed) json(status, {error: code});
    } finally { inFlight--; req.resume(); }
  });
  server.maxConnections = 32; server.keepAliveTimeout = 1000; return server;
}
export async function run(cfg) {
  await store.settings(cfg); if (cfg.role === 'leader') await store.registry(cfg);
  await cert.protectedRead(cfg.adminTokenFile, 256); await renderProxy(cfg);
  const stop = new AbortController(), server = createServer(cfg);
  const shutdown = () => { stop.abort(); server.close(); };
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, shutdown);
  let renderer;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.listen, resolve); });
    console.log(JSON.stringify({event: 'cert-sync-started', role: cfg.role, nodeId: cfg.nodeId}));
    renderer = setInterval(() => renderProxy(cfg).catch(e => console.error(JSON.stringify({event: 'proxy-render-failed', code: safeCode(e)}))), 5000);
    renderer.unref();
    if (cfg.role === 'leader') {
      await new Promise(resolve => server.once('close', resolve));
      return;
    }
    const policy = {attempts: cfg.retryAttempts, initialDelayMillis: cfg.retryInitialSeconds * 1000, maxDelayMillis: cfg.retrySeconds * 1000};
    while (!stop.signal.aborted) {
      // A new Follower must keep its Console available so an operator can join it.
      // No invitation/identity is invented and a pending join retains its request.
      try { await store.read(cfg, 'client'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await sleep(cfg.retryInitialSeconds * 1000, undefined, {signal: stop.signal});
        continue;
      }
      const result = await retryDependency(() => syncOnce(cfg, {signal: stop.signal}), {
        policy, signal: stop.signal,
        onRetry: async value => {
          const report = {event: 'cert-sync-retry', ...value, at: new Date().toISOString()};
          await store.write(cfg, 'last-sync', report); console.error(JSON.stringify(report));
        },
      });
      console.log(JSON.stringify(result));
      await sleep(cfg.intervalSeconds * 1000, undefined, {signal: stop.signal});
    }
  } catch (error) {
    if (!stop.signal.aborted) {
      const report = {event: 'cert-sync-failed', code: safeCode(error), at: new Date().toISOString()};
      await store.write(cfg, 'last-sync', report);
      throw error;
    }
  } finally {
    clearInterval(renderer);
    for (const name of ['SIGTERM', 'SIGINT']) process.removeListener(name, shutdown);
    server.close(); server.closeIdleConnections();
  }
}
async function consoleMenu(cfg) {
  const reader = createInterface({input: stdin, output: stdout});
  try { for (;;) {
    stdout.write('\ncert-sync ' + cfg.role + ' / ' + cfg.nodeId + '\n1 状态  2 设置域名  3 加入Leader  4 创建JoinToken  5 撤销节点  0 退出\n');
    const choice = await reader.question('选择: '); if (choice === '0') return;
    try {
      if (choice === '1') stdout.write(JSON.stringify(await state(cfg), null, 2) + '\n');
      if (choice === '2') { await store.setDomains(cfg, (await reader.question('域名，用逗号分隔: ')).split(',').map(x => x.trim()).filter(Boolean)); await renderProxy(cfg); }
      if (choice === '3') await join(cfg, JSON.parse(await cert.protectedRead(await reader.question('邀请文件绝对路径: '))));
      if (choice === '4') { const nodeId = await reader.question('Follower nodeId: '), list = (await reader.question('授权域名，逗号分隔: ')).split(',').map(x => x.trim());
        const output = resolve(await reader.question('邀请保存路径（私有文件）: '));
        const invitation = await store.createInvitation(cfg, nodeId, list); await writeFile(output, JSON.stringify(invitation), {mode: 0o600, flag: 'wx'});
        stdout.write('已保存邀请文件，勿发送到公共日志。\n'); }
      if (choice === '5') await store.changeClient(cfg, await reader.question('Follower nodeId: '), null);
    } catch (error) { stdout.write('操作失败: ' + safeCode(error) + '\n'); }
  } } finally { reader.close(); }
}
export async function main(argv) {
  const command = argv[0], args = {};
  for (let i = 1; i < argv.length; i += 2) { need(argv[i].startsWith('--') && argv[i + 1] !== undefined && !Object.hasOwn(args, argv[i].slice(2)), 'usage'); args[argv[i].slice(2)] = argv[i + 1]; }
  const allowed = {domains: ['set'], join: ['invitation'], 'create-join-token': ['node', 'domains', 'output', 'ttl'], revoke: ['node']};
  need(['check', 'init', 'run', 'status', 'domains', 'join', 'sync', 'create-join-token', 'revoke', 'clients', 'console'].includes(command)
    && Object.keys(args).every(k => k === 'config' || (allowed[command] ?? []).includes(k)), 'usage');
  need(args.config, 'config-required'); const cfg = await loadConfig(args.config);
  let value;
  if (command === 'check') value = {valid: true, role: cfg.role, nodeId: cfg.nodeId};
  else if (command === 'init') value = await store.initialize(cfg);
  else if (command === 'run') return run(cfg);
  else if (command === 'status') { value = await state(cfg); if (!value.healthy) process.exitCode = 1; }
  else if (command === 'domains') { value = args.set !== undefined
    ? await store.setDomains(cfg, args.set.split(',').map(v => v.trim()).filter(Boolean)) : await store.settings(cfg); await renderProxy(cfg); }
  else if (command === 'join') { need(args.invitation, 'invitation-required'); value = await join(cfg, JSON.parse(await cert.protectedRead(resolve(args.invitation)))); }
  else if (command === 'sync') value = await syncOnce(cfg);
  else if (command === 'create-join-token') { need(args.node && args.domains && args.output, 'invitation-arguments-required');
    const invitation = await store.createInvitation(cfg, args.node, args.domains.split(','), args.ttl ? Number(args.ttl) : 3600);
    await writeFile(resolve(args.output), JSON.stringify(invitation) + '\n', {flag: 'wx', mode: 0o600});
    value = {created: true, nodeId: invitation.nodeId, expiresAt: invitation.expiresAt, output: resolve(args.output)};
  } else if (command === 'revoke') value = await store.changeClient(cfg, args.node, null);
  else if (command === 'clients') value = (await store.registry(cfg)).clients.map(c => ({nodeId: c.nodeId, domains: c.domains, revoked: c.revoked}));
  else if (command === 'console') return consoleMenu(cfg);
  else need(false, 'usage');
  console.log(JSON.stringify(value));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({event: 'cert-sync-failed', code: safeCode(error)})); process.exitCode = 1; }
}
