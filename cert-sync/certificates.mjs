import {X509Certificate, createPrivateKey, createHash, randomUUID} from 'node:crypto';
import {getCACertificates} from 'node:tls';
const rootCertificates = getCACertificates('default');
const trustedRoots = rootCertificates.map(pem => new X509Certificate(pem));
import {constants} from 'node:fs';
import {open, lstat, realpath, mkdir, rename, unlink, rmdir} from 'node:fs/promises';
import {resolve, dirname, join, isAbsolute} from 'node:path';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const required = (ok, code) => { if (!ok) fail(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const absolute = value => required(typeof value === 'string' && isAbsolute(value) && value !== '/'
  && resolve(value) === value && !/[\r\n\0,]/.test(value), 'invalid-path');
export async function protectedDirectory(path) {
  absolute(path); const s = await lstat(path);
  required(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.geteuid()
    && !(s.mode & 0o077) && await realpath(path) === path, 'unsafe-directory');
  return s;
}
export async function protectedRead(path, maximum = 1024 * 1024) {
  absolute(path); const s = await lstat(path);
  required(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.geteuid()
    && !(s.mode & 0o077) && s.size <= maximum && await realpath(path) === path, 'unsafe-file');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await fd.stat();
    required(actual.ino === s.ino && actual.dev === s.dev && actual.uid === process.geteuid()
      && !(actual.mode & 0o077) && actual.nlink === 1, 'unsafe-file');
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) { const r = await fd.read(buffer, length, buffer.length - length, null); if (!r.bytesRead) break; length += r.bytesRead; }
    required(length <= maximum, 'oversized-file'); return buffer.subarray(0, length).toString();
  } finally { await fd.close(); }
}
export const metadata = checked => checked.map(c => ({host: c.host, hosts: [c.host], fingerprint: c.fingerprint,
  expiresAt: c.expiresAt, certificateSHA256: hash(c.certificate)}));
export function validateBundle(value, cfg, {now = Date.now(), roots = rootCertificates, historical = false} = {}) {
  required(object(value) && value.schemaVersion === 1 && Array.isArray(value.certificates)
    && value.certificates.length === cfg.domains.length, 'invalid-bundle');
  const trusted = roots === rootCertificates ? trustedRoots : roots.map(pem => new X509Certificate(pem)); const hosts = new Set();
  const checked = value.certificates.map(item => {
    required(object(item) && cfg.domains.includes(item.host) && !hosts.has(item.host)
      && typeof item.certificate === 'string' && Buffer.byteLength(item.certificate) <= 65536
      && typeof item.key === 'string' && Buffer.byteLength(item.key) <= 16384, 'invalid-bundle');
    hosts.add(item.host);
    const pems = item.certificate.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    required(pems?.length >= 1 && pems.length <= 5, 'invalid-chain');
    const chain = pems.map(pem => new X509Certificate(pem)), leaf = chain[0];
    for (const c of chain) required(historical || Date.parse(c.validFrom) <= now
      && Date.parse(c.validTo) > now + cfg.minimumValiditySeconds * 1000, 'certificate-time');
    // One exact DNS name per certificate: no wildcard, IP SAN or undeclared SAN.
    required(leaf.subjectAltName === 'DNS:' + item.host && !leaf.ca
      && (!leaf.keyUsage || leaf.keyUsage.includes('1.3.6.1.5.5.7.3.1'))
      && leaf.checkHost(item.host, {wildcards: false})
      && leaf.checkPrivateKey(createPrivateKey(item.key)), 'certificate-identity');
    for (let n = 0; n < chain.length - 1; n++) required(chain[n + 1].ca
      && chain[n].checkIssued(chain[n + 1]) && chain[n].verify(chain[n + 1].publicKey), 'invalid-chain');
    const last = chain.at(-1);
    required(trusted.some(root => root.ca && (historical || Date.parse(root.validFrom) <= now && Date.parse(root.validTo) > now)
      && (last.raw.equals(root.raw) || last.checkIssued(root) && last.verify(root.publicKey))), 'untrusted-chain');
    return {host: item.host, certificate: item.certificate, key: item.key,
      fingerprint: hash(leaf.raw), expiresAt: new Date(leaf.validTo).toISOString()};
  });
  return checked.sort((a, b) => a.host < b.host ? -1 : a.host > b.host ? 1 : 0);
}
export function selectAcmeCertificates(acme, cfg, options) {
  required(object(acme), 'invalid-acme');
  const all = Object.values(acme).flatMap(resolver => resolver?.Certificates ?? []);
  const certificates = cfg.domains.map(host => {
    const matches = all.filter(c => c.domain?.main === host && !(c.domain.sans?.length));
    required(matches.length === 1, 'ambiguous-or-missing-certificate'); const c = matches[0];
    required(typeof c.certificate === 'string' && typeof c.key === 'string', 'invalid-acme');
    return {host, certificate: Buffer.from(c.certificate, 'base64').toString(), key: Buffer.from(c.key, 'base64').toString()};
  });
  const value = {schemaVersion: 1, certificates}; validateBundle(value, cfg, options);
  required(Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024, 'oversized-bundle'); return value;
}
export async function atomicWrite(path, bytes) {
  const temp = path + '.' + randomUUID() + '.tmp';
  const fd = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  try { await rename(temp, path); const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
const locations = cfg => ({document: join(cfg.targetDirectory, cfg.profile + '-certificates.yml'),
  base: join(cfg.targetDirectory, cfg.profile + '-tls')});
const scope = cfg => hash(JSON.stringify({profile: cfg.profile, directory: cfg.targetDirectory}));
async function maybeRead(path) { try { return await protectedRead(path); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
async function ensureDirectory(path) { try { await mkdir(path, {mode: 0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; } await protectedDirectory(path); }
async function currentBundle(cfg, options) {
  const loc = locations(cfg), raw = await maybeRead(loc.document); if (raw === undefined) return undefined;
  const doc = JSON.parse(raw);
  required(object(doc) && Object.keys(doc).join() === 'tls' && object(doc.tls)
    && Object.keys(doc.tls).join() === 'certificates' && Array.isArray(doc.tls.certificates)
    && doc.tls.certificates.length <= 16, 'invalid-current-document');
  const certificates = []; let generation;
  for (let i = 0; i < doc.tls.certificates.length; i++) {
    const c = doc.tls.certificates[i];
    required(object(c) && Object.keys(c).sort().join() === 'certFile,keyFile'
      && typeof c.certFile === 'string', 'invalid-current-document');
    const relative = c.certFile.slice((loc.base + '/').length), match = /^([0-9a-f]{32})\/([0-9]+)\.pem$/.exec(relative);
    required(c.certFile.startsWith(loc.base + '/') && match && Number(match[2]) === i
      && c.keyFile === join(loc.base, match[1], i + '.key')
      && (!generation || generation === match[1]), 'invalid-current-path');
    generation = match[1]; await protectedDirectory(join(loc.base, generation));
    const certificate = await protectedRead(c.certFile);
    const leaf = new X509Certificate(certificate);
    required(leaf.subjectAltName?.startsWith('DNS:'), 'certificate-identity');
    certificates.push({host: leaf.subjectAltName.slice(4), certificate, key: await protectedRead(c.keyFile)});
  }
  return {checked: validateBundle({schemaVersion: 1, certificates}, {...cfg, domains: certificates.map(c => c.host).sort()}, options), generation: generation ?? hash(JSON.stringify([])).slice(0, 32)};
}
export async function withLock(cfg, callback) {
  const lock = join(cfg.targetDirectory, '.' + cfg.profile + '-sync.lock');
  try { await mkdir(lock, {mode: 0o700}); } catch (e) { if (e.code === 'EEXIST') fail('writer-lock-exists'); throw e; }
  const token = randomUUID(); await atomicWrite(join(lock, 'owner'), token);
  try { return await callback(); }
  finally { required(await protectedRead(join(lock, 'owner')) === token, 'writer-lock-owner-differs');
    await unlink(join(lock, 'owner')); await rmdir(lock); }
}
export async function publishBundle(value, cfg, options = {}) {
  await protectedDirectory(cfg.targetDirectory);
  const checked = validateBundle(value, cfg, options);
  return withLock(cfg, async () => {
    const loc = locations(cfg); await ensureDirectory(loc.base);
    const statePath = join(loc.base, 'sync-state'), previousRaw = await maybeRead(statePath);
    const previous = previousRaw === undefined ? undefined : JSON.parse(previousRaw);
    if (previous) required(previous.schemaVersion === 2 && previous.scopeSHA256 === scope(cfg)
      && Array.isArray(previous.certificates), 'state-scope-differs');
    const active = await currentBundle(cfg, {...options, historical: true});
    const expiryFloors = {...(previous?.expiryFloors ?? {})};
    for (const old of previous?.certificates ?? []) expiryFloors[old.host] = Math.max(expiryFloors[old.host] ?? 0, Date.parse(old.expiresAt));
    required(Object.keys(expiryFloors).length <= 256, 'state-capacity');
    // The actual published certificate files also constrain rollback, even if a
    // previous document switch succeeded but its following state write failed.
    for (const c of checked) {
      required(!expiryFloors[c.host] || Date.parse(c.expiresAt) >= expiryFloors[c.host], 'older-certificate');
      const oldState = previous?.certificates.find(old => old.host === c.host);
      const oldActive = active?.checked.find(old => old.host === c.host);
      for (const old of [oldState, oldActive]) if (old) required(Date.parse(c.expiresAt) >= Date.parse(old.expiresAt), 'older-certificate');
    }
    for (const c of checked) expiryFloors[c.host] = Date.parse(c.expiresAt);
    required(Object.keys(expiryFloors).length <= 256, 'state-capacity');
    const records = metadata(checked), generation = hash(JSON.stringify(records)).slice(0, 32);
    const directory = join(loc.base, generation); await ensureDirectory(directory);
    const certificates = [];
    for (const [i, c] of checked.entries()) {
      const certFile = join(directory, i + '.pem'), keyFile = join(directory, i + '.key');
      for (const [path, content] of [[certFile, c.certificate], [keyFile, c.key]]) {
        const old = await maybeRead(path); if (old === undefined) await atomicWrite(path, content);
        else required(old === content, 'immutable-generation-differs');
      }
      certificates.push({certFile, keyFile});
    }
    const state = {schemaVersion: 2, scopeSHA256: scope(cfg), generation, expiryFloors,
      checkedAt: new Date(options.now ?? Date.now()).toISOString(), certificates: records};
    const document = JSON.stringify({tls: {certificates}}) + '\n';
    if (await maybeRead(loc.document) !== document) await atomicWrite(loc.document, document);
    await atomicWrite(statePath, JSON.stringify(state) + '\n'); return state;
  });
}
export async function health(cfg, options = {}) {
  await protectedDirectory(cfg.targetDirectory); const loc = locations(cfg);
  await protectedDirectory(loc.base);
  const state = JSON.parse(await protectedRead(join(loc.base, 'sync-state')));
  required(state.schemaVersion === 2 && state.scopeSHA256 === scope(cfg)
    && Array.isArray(state.certificates), 'state-scope-differs');
  const now = options.now ?? Date.now(), age = now - Date.parse(state.checkedAt);
  required(Number.isFinite(age) && age >= -300000 && age <= cfg.healthMaxAgeSeconds * 1000, 'stale-sync');
  const active = await currentBundle(cfg, {...options, now});
  required(active && active.generation === state.generation
    && JSON.stringify(metadata(active.checked)) === JSON.stringify(state.certificates)
    && JSON.stringify(active.checked.map(c => c.host)) === JSON.stringify(cfg.domains), 'state-document-differ');
  required(active.checked.every(c => Date.parse(c.expiresAt) > now + cfg.healthMinimumRemainingSeconds * 1000), 'certificate-near-expiry');
  return {healthy: true, profile: cfg.profile, checkedAt: state.checkedAt, certificates: state.certificates};
}
