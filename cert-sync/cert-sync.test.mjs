import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, chmod, rm, mkdir, unlink, symlink, link} from 'node:fs/promises';
import {tmpdir, userInfo} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {createHash,randomBytes} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {validateConfig, loadConfig} from './config.mjs';
import {validateBundle, selectAcmeCertificates, publishBundle, health, protectedRead} from './certificates.mjs';
import * as store from './store.mjs';
import {createServer, join as joinLeader, syncOnce, state, requestJSON} from './app.mjs';
import {traefikRoutes, renderProxy} from './proxy.mjs';
const moduleURL = new URL('./app.mjs', import.meta.url).href;
const fixture = await mkdtemp(join(tmpdir(), 'cert-sync-test-'));
const openssl = (...args) => execFileSync('openssl', args, {cwd: fixture, stdio: 'ignore'});
const config = extra => validateConfig({schemaVersion: 1, role: 'follower', nodeId: 'follower-a', publicURL: 'https://consumer.example.net', domains: ['a.example.net', 'b.example.net'], ...extra});
const put = async (path, value) => { await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), {mode: 0o600}); await chmod(path, 0o600); };
openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem',
  '-days', '40', '-subj', '/CN=Synthetic CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
const root = await readFile(join(fixture, 'root.pem'), 'utf8'), roots = [root];
async function leaf(name, dns, days = 10) {
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + dns.split(',')[0]);
  await put(join(fixture, name + '.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=' + dns.split(',').map(v => 'DNS:' + v).join(',') + '\n');
  openssl('x509', '-req', '-in', name + '.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial',
    '-out', name + '.pem', '-days', String(days), '-extfile', name + '.ext');
  return {host: dns.split(',')[0], certificate: await readFile(join(fixture, name + '.pem'), 'utf8'),
    key: await readFile(join(fixture, name + '.key'), 'utf8')};
}
const a = await leaf('a', 'a.example.net'), b = await leaf('b', 'b.example.net');
const extraSAN = await leaf('extra', 'a.example.net,b.example.net');
const wildcard = await leaf('wildcard', '*.example.net');
const renewedA = await leaf('renewed', 'a.example.net', 20);
const bundle = {schemaVersion: 1, certificates: [a, b]};
const renewed = {schemaVersion: 1, certificates: [renewedA, b]};
const acme = {resolver: {Account: {PrivateKey: 'synthetic-account-secret-must-not-export'},
  Certificates: [a, b].map(c => ({domain: {main: c.host}, certificate: Buffer.from(c.certificate).toString('base64'), key: Buffer.from(c.key).toString('base64')}))}};
const options = {roots};
const document = dir => join(dir, 'shared-certificates.yml');
const stateFile = dir => join(dir, 'shared-tls', 'sync-state');
const temporary = async callback => { const dir = await mkdtemp(join(tmpdir(), 'cert-sync-case-'));
  try { await callback(dir, config({targetDirectory: dir})); } finally { await rm(dir, {recursive: true, force: true}); } };
test.after(() => rm(fixture, {recursive: true, force: true}));

test('config validates role, exact DNS names, proxy defaults, paths, HTTPS and timer bounds', () => {
  const cfg = config({intervalSeconds: 600, proxy: {resolver: 'publicca'}});
  assert.equal(cfg.intervalSeconds, 600); assert.equal(cfg.proxy.type, 'traefik'); assert.equal(cfg.profile, 'shared');
  for (const patch of [{domains: ['*.example.net']}, {domains: ['a.example.net', 'a.example.net']},
    {domains: ['127.0.0.1']}, {domains: ['consumer.example.net']}, {profile: '../escape'},
    {publicURL: 'http://issuer.example.net'}, {publicURL: 'https://user:secret@issuer.example.net'},
    {intervalSeconds: 0}, {unknown: true}, {targetDirectory: '/a/../b'}, {healthMaxAgeSeconds: 60},
    {proxy: {type: 'caddy'}}, {source: {transport: 'ssh'}}]) assert.throws(() => config(patch));
});

test('each configured DNS name requires its own trusted matching unexpired certificate', () => {
  assert.deepEqual(validateBundle(bundle, config(), options).map(c => c.host), ['a.example.net', 'b.example.net']);
  for (const [value, opt] of [[bundle, {roots: []}], [{schemaVersion: 1, certificates: [a]}, options],
    [{schemaVersion: 1, certificates: [a, a]}, options],
    [{schemaVersion: 1, certificates: [{...a, key: b.key}, b]}, options],
    [{schemaVersion: 1, certificates: [extraSAN, b]}, options],
    [{schemaVersion: 1, certificates: [{...wildcard, host: a.host}, b]}, options],
    [bundle, {roots, now: Date.now() + 15 * 86400000}]]) assert.throws(() => validateBundle(value, config(), opt));
});

test('ACME export selects exact single-domain certificates without account keys or other certificates', () => {
  const result = selectAcmeCertificates(acme, config(), options);
  assert.equal(result.certificates.length, 2);
  assert.ok(!JSON.stringify(result).includes('synthetic-account-secret'));
  assert.throws(() => selectAcmeCertificates({resolver: {...acme.resolver, Certificates: [...acme.resolver.Certificates, acme.resolver.Certificates[0]]}}, config(), options));
  assert.throws(() => selectAcmeCertificates({resolver: {Certificates: [{...acme.resolver.Certificates[0], domain: {main: a.host, sans: [b.host]}}]}}, config(), options));
});

test('replay, actual publication and renewal keep previous files and reject older source certificates', () => temporary(async (dir, cfg) => {
  const first = await publishBundle(bundle, cfg, options); const original = await readFile(document(dir), 'utf8');
  assert.equal((await publishBundle(bundle, cfg, options)).generation, first.generation);
  assert.equal((await health(cfg, options)).healthy, true);
  const next = await publishBundle(renewed, cfg, options); assert.notEqual(next.generation, first.generation);
  assert.equal(await readFile(join(dir, 'shared-tls', first.generation, '0.pem'), 'utf8'), a.certificate);
  const current = await readFile(document(dir), 'utf8'); assert.notEqual(current, original);
  await assert.rejects(publishBundle(bundle, cfg, options), /older-certificate/);
  assert.equal(await readFile(document(dir), 'utf8'), current);
  // Actual active files continue to prevent rollback if a state write was lost.
  await unlink(stateFile(dir)); await assert.rejects(publishBundle(bundle, cfg, options), /older-certificate/);
  await publishBundle(renewed, cfg, options); assert.equal((await health(cfg, options)).healthy, true);
}));

test('failed validation, scope changes and an existing writer lock preserve the active document', () => temporary(async (dir, cfg) => {
  await publishBundle(bundle, cfg, options); const original = await readFile(document(dir), 'utf8');
  await assert.rejects(publishBundle({...bundle, certificates: [{...a, key: 'invalid'}, b]}, cfg, options));
  await assert.rejects(publishBundle(bundle, config({targetDirectory: dir, domains: ['a.example.net']}), options));
  const lock = join(dir, '.shared-sync.lock'); await mkdir(lock, {mode: 0o700});
  await assert.rejects(publishBundle(bundle, cfg, options), /writer-lock-exists/); await rm(lock, {recursive: true});
  assert.equal(await readFile(document(dir), 'utf8'), original);
}));

test('health revalidates actual files, freshness and remaining lifetime rather than trusting metadata', () => temporary(async (dir, cfg) => {
  const first = await publishBundle(bundle, cfg, options);
  await assert.rejects(health(cfg, {roots, now: Date.now() + 4 * 86400000}), /stale-sync/);
  const state = JSON.parse(await readFile(stateFile(dir), 'utf8'));
  await put(stateFile(dir), {...state, checkedAt: new Date(Date.now() + 4 * 86400000).toISOString()});
  await assert.rejects(health(cfg, {roots, now: Date.now() + 4 * 86400000}), /certificate-near-expiry/);
  await put(stateFile(dir), state);
  await put(join(dir, 'shared-tls', first.generation, '0.key'), b.key);
  await assert.rejects(health(cfg, options));
}));

test('unsafe files, symlinks, hardlinks and publicly readable config are rejected', () => temporary(async (dir, cfg) => {
  await chmod(dir, 0o755); await assert.rejects(publishBundle(bundle, cfg, options)); await chmod(dir, 0o700);
  await symlink(dir, join(dir, 'alias')); await assert.rejects(publishBundle(bundle, config({targetDirectory: join(dir, 'alias')}), options));
  const path = join(dir, 'config.json'); await put(path, cfg); assert.equal((await loadConfig(path)).profile, cfg.profile);
  await chmod(path, 0o644); await assert.rejects(loadConfig(path)); await chmod(path, 0o600);
  await symlink(path, join(dir, 'link')); await assert.rejects(protectedRead(join(dir, 'link')));
  await link(path, join(dir, 'hardlink')); await assert.rejects(protectedRead(path));
}));

test('CLI rejects malformed config with a redacted error and no private content', () => temporary(async (dir) => {
  const file = join(dir, 'bad.json'); await put(file, 'synthetic-private-value-invalid-json');
  const modulePath = new URL(moduleURL).pathname;
  try { execFileSync(process.execPath, [modulePath, 'check', '--config', file], {encoding: 'utf8', stdio: 'pipe'}); assert.fail('invalid config accepted'); }
  catch (error) { assert.ok(error.status !== 0); assert.ok(!error.stderr.includes('synthetic-private-value')); assert.ok(error.stderr.includes('cert-sync-failed')); }
}));


async function nodeConfig(base, role, extra = {}) {
  const directory = join(base, role); await mkdir(directory, {mode: 0o700});
  const cfg = config({role, nodeId: role + '-a', publicURL: 'https://' + role + '.example.net',
    stateDirectory: join(directory, 'state'), targetDirectory: join(directory, 'dynamic'),
    adminTokenFile: join(directory, 'admin-token'), acmeFile: join(directory, 'acme.json'), ...extra});
  await put(cfg.adminTokenFile, store.secret()); await put(cfg.acmeFile, acme);
  await store.initialize(cfg); return cfg;
}
async function pendingPair(dir) {
  const leader = await nodeConfig(dir, 'leader'), follower = await nodeConfig(dir, 'follower');
  const invitation = await store.createInvitation(leader, follower.nodeId, follower.domains);
  const pending = await store.prepareJoin(follower, invitation);
  return {leader, follower, invitation, pending};
}
test('initialization is explicit and preserves service identity; policy changes use revision checks', () => temporary(async dir => {
  const cfg = await nodeConfig(dir, 'leader'), initial = await store.registry(cfg);
  assert.equal((await store.initialize(cfg)).existing, true);
  assert.equal((await store.registry(cfg)).serviceId, initial.serviceId);
  const policy = await store.settings(cfg);
  await store.setDomains(cfg, ['a.example.net'], policy.revision);
  await assert.rejects(store.setDomains(cfg, [], policy.revision), /policy-conflict/);
  await assert.rejects(store.setDomains(cfg, ['leader.example.net']), /transport-domain/);
  await unlink(store.file(cfg, 'registry')); await assert.rejects(store.initialize(cfg));
}));
test('Join Token binds node, domains and service; follower persists original operation before request', () => temporary(async dir => {
  const {leader, follower, invitation, pending} = await pendingPair(dir);
  const again = await store.prepareJoin(follower, invitation); assert.deepEqual(again, pending);
  assert.ok(!JSON.stringify(pending.request).includes(pending.token));
  assert.equal(pending.request.credentialSHA256, createHash('sha256').update(pending.token).digest('hex'));
  await assert.rejects(store.acceptJoin(leader, {...pending.request, nodeId: 'wrong'}, invitation.token), /join-not-authorized/);
  await assert.rejects(store.acceptJoin(leader, {...pending.request, domains: ['not-granted.example.net']}, invitation.token), /join-not-authorized/);
  await assert.rejects(store.acceptJoin(leader, pending.request, store.secret()), /join-not-authorized/);
  const ack = await store.acceptJoin(leader, pending.request, invitation.token);
  assert.deepEqual(await store.acceptJoin(leader, pending.request, invitation.token), ack);
  const reg = await store.registry(leader);
  assert.ok(!JSON.stringify(reg).includes(invitation.token)); assert.ok(!JSON.stringify(reg).includes(pending.token));
  const active = await store.finishJoin(follower, ack);
  assert.equal(active.phase, 'active'); assert.equal(active.invitation.token, undefined);
  assert.equal((await store.prepareJoin(follower, invitation)).phase, 'active');
  await assert.rejects(store.acceptJoin(leader, {...pending.request, operationId: store.secret()}, invitation.token));
}));
test('committed Join retry survives expiry; uncommitted expiry, reuse and revocation refuse', () => temporary(async dir => {
  const {leader, follower, invitation, pending} = await pendingPair(dir);
  const ack = await store.acceptJoin(leader, pending.request, invitation.token);
  const r = await store.registry(leader); r.tokens[0].expiresAt = new Date(0).toISOString(); await store.write(leader, 'registry', r);
  assert.deepEqual(await store.acceptJoin(leader, pending.request, invitation.token), ack);
  const unused = await store.createInvitation(leader, 'other-node', ['a.example.net']);
  const rr = await store.registry(leader); rr.tokens.at(-1).expiresAt = new Date(0).toISOString(); await store.write(leader, 'registry', rr);
  await assert.rejects(store.acceptJoin(leader, {...pending.request, operationId: 'a5d032ce-67ba-4a0d-bc9e-fd71c3f5a56a', nodeId: 'other-node', invitationId: unused.id}, unused.token), /join-not-authorized/);
  await store.changeClient(leader, follower.nodeId, null);
  await assert.rejects(store.acceptJoin(leader, pending.request, invitation.token), /join-recovery-refused/);
  await assert.rejects(store.changeClient(leader, follower.nodeId, ['a.example.net']));
}));
test('join state cannot be replaced by another invitation or another profile', () => temporary(async dir => {
  const {leader, follower, invitation} = await pendingPair(dir);
  const another = await store.createInvitation(leader, follower.nodeId, ['a.example.net']);
  await assert.rejects(store.prepareJoin(follower, another), /existing-join-preserved/);
  await assert.rejects(store.prepareJoin(follower, {...invitation, profile: 'other', sourceURL: 'https://leader.example.net/v1/certificates/other'}), /wrong-node/);
  assert.throws(() => store.invitation({...invitation, sourceURL: 'https://user:secret@leader.example.net/v1/certificates/shared'}));
}));
test('dynamic domain removal keeps old PEM immutable, publishes reduced set and supports empty set', () => temporary(async (dir, cfg) => {
  const before = await publishBundle(bundle, cfg, options);
  const reduced = {...cfg, domains: ['b.example.net']};
  await publishBundle({schemaVersion: 1, certificates: [b]}, reduced, options);
  assert.equal((await health(reduced, options)).healthy, true);
  assert.equal(await readFile(join(dir, 'shared-tls', before.generation, '0.pem'), 'utf8'), a.certificate);
  const empty = {...cfg, domains: []};
  await publishBundle({schemaVersion: 1, certificates: []}, empty, options);
  assert.equal((await health(empty, options)).healthy, true);
}));
test('renewal replaces a certificate that has crossed minimum remaining lifetime', () => temporary(async (dir, cfg) => {
  await publishBundle(bundle, cfg, options);
  const now = Date.now() + 9.5 * 86400000;
  const extendedB = await leaf('extended-b', 'b.example.net', 20);
  await publishBundle({schemaVersion: 1, certificates: [renewedA, extendedB]}, cfg, {roots, now});
  assert.equal((await health(cfg, {roots, now})).healthy, true);
}));
test('Traefik routes preserve Host, isolate own transport TLS and require active membership for HTTP-01 forwarding', () => {
  const cfg = config(), policy = {domains: cfg.domains};
  const client = {phase: 'active', invitation: {sourceURL: 'https://issuer.example.net/v1/certificates/shared'}};
  const follower = traefikRoutes(cfg, policy, client);
  const challenge = follower.http.routers['cert-sync-shared-challenge'];
  assert.equal(challenge.priority, 10000); assert.ok(challenge.rule.includes('PathPrefix(`/.well-known/acme-challenge/`)'));
  assert.ok(!challenge.rule.includes('consumer.example.net'));
  assert.equal(follower.http.services['cert-sync-shared-challenge'].loadBalancer.servers[0].url, 'http://issuer.example.net:80');
  assert.equal(follower.http.services['cert-sync-shared-challenge'].loadBalancer.passHostHeader, true);
  assert.ok(!traefikRoutes(cfg, policy, {...client, phase: 'pending'}).http.routers['cert-sync-shared-challenge']);
  const issuer = traefikRoutes({...cfg, role: 'leader'}, policy).http.routers;
  assert.equal(Object.values(issuer).filter(r => r.tls?.domains?.length === 1).length, 2);
  for (const r of Object.values(issuer)) if (r.tls?.domains) assert.ok(!r.tls.domains[0].sans);
});
async function listening(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server; }
async function closeServer(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
test('real HTTPS join/sync, Web Console and administration enforce TLS, grant updates, revocation and failed-sync retention', () => temporary(async dir => {
  const leader = await nodeConfig(dir, 'leader');
  const transport = await leaf('transport-final', 'leader.example.net', 20);
  const backend = await listening(createServer(leader, options));
  const gateway = await listening(https.createServer({key: transport.key, cert: transport.certificate}, (request, response) => {
    const forward = http.request({host: '127.0.0.1', port: backend.address().port, path: request.url,
      method: request.method, headers: request.headers, agent: false}, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
    }); forward.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(forward);
  }));
  const effectiveLeader = {...leader, publicURL: 'https://leader.example.net:' + gateway.address().port};
  const follower = await nodeConfig(dir, 'follower', {connectAddress: '127.0.0.1', sourceCAFile: join(dir, 'ca.pem')});
  await put(follower.sourceCAFile, root);
  const adminToken = (await readFile(leader.adminTokenFile, 'utf8')).trim();
  const base = 'http://127.0.0.1:' + backend.address().port;
  const api = (path, value, authorized = true) => fetch(base + path, {method: value === undefined ? 'GET' : 'POST',
    headers: authorized ? {'authorization': 'Bearer ' + adminToken, 'content-type': 'application/json'} : {},
    ...(value === undefined ? {} : {body: JSON.stringify(value)})});
  try {
    const page = await fetch(base + '/console'); assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.ok((await page.text()).includes('cert-sync'));
    const js = await fetch(base + '/console/app.js'); assert.ok(!(await js.text()).includes('localStorage'));
    assert.equal((await api('/admin/state', undefined, false)).status, 401);
    const publicState = JSON.stringify(await (await api('/admin/state')).json());
    assert.ok(!publicState.includes('PRIVATE KEY')); assert.ok(!publicState.includes(adminToken));
    const invitation = await store.createInvitation(effectiveLeader, follower.nodeId, follower.domains);
    const pending = await store.prepareJoin(follower, invitation);
    await store.acceptJoin(leader, pending.request, invitation.token); // Simulate lost first response.
    await joinLeader(follower, invitation); assert.equal((await store.read(follower, 'client')).phase, 'active');
    await Promise.all([syncOnce(follower, options), syncOnce(follower, options)]);
    assert.equal((await state(follower, options)).healthy, true);
    const current = await readFile(document(follower.targetDirectory), 'utf8');
    await assert.rejects(syncOnce({...follower, sourceCAFile: undefined}, options));
    await assert.rejects(syncOnce({...follower, connectAddress: '127.0.0.2'}, options));
    const c = await store.read(follower, 'client');
    await assert.rejects(requestJSON(follower, c.invitation.sourceURL.replace('leader.example.net', 'wrong.example.net'), c.token, {domains: follower.domains}));
    assert.equal((await api('/admin/grants', {nodeId: follower.nodeId, domains: ['a.example.net']})).status, 200);
    await assert.rejects(syncOnce(follower, options)); assert.equal(await readFile(document(follower.targetDirectory), 'utf8'), current);
    const policy = await store.settings(leader);
    assert.equal((await api('/admin/domains', {domains: ['a.example.net'], revision: policy.revision})).status, 200);
    assert.equal((await api('/admin/domains', {domains: [], revision: policy.revision})).status, 409);
    await store.setDomains(follower, ['a.example.net']); await syncOnce(follower, options);
    assert.equal((await state(follower, options)).healthy, true);
    const reduced = await readFile(document(follower.targetDirectory), 'utf8');
    assert.equal((await api('/admin/revoke', {nodeId: follower.nodeId})).status, 200);
    await assert.rejects(syncOnce(follower, options)); assert.equal(await readFile(document(follower.targetDirectory), 'utf8'), reduced);
    assert.ok(!JSON.stringify(await state(leader, options)).includes(c.token));
    await renderProxy(follower); assert.ok((await readFile(join(follower.targetDirectory, 'cert-sync-shared-routes.yml'), 'utf8')).includes('acme-challenge'));
  } finally { await closeServer(gateway); await closeServer(backend); }
}));

test('domain removal and readdition retain per-domain expiry floors', () => temporary(async (dir, cfg) => {
  await publishBundle(renewed, cfg, options);
  const reduced = {...cfg, domains: ['b.example.net']};
  await publishBundle({schemaVersion: 1, certificates: [b]}, reduced, options);
  await assert.rejects(publishBundle(bundle, cfg, options), /older-certificate/);
}));

test('Traefik adapter preserves an explicitly selected existing TLS policy on every generated TLS router', () => {
  const cfg = config({role: 'leader', proxy: {tlsOptions: 'existing-node-policy'}});
  const value = traefikRoutes(cfg, {domains: cfg.domains});
  for (const router of Object.values(value.http.routers)) assert.equal(router.tls.options, 'existing-node-policy');
  assert.throws(() => config({proxy: {tlsOptions: 'bad`injection'}}));
});
