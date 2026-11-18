#!/usr/bin/env python3
"""Disposable real-runtime + Traefik integration; synthetic CA, no public ACME."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import time
import uuid


def command(*args):
    result = subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.strip()


def wait(check):
    deadline = time.monotonic() + 20
    while True:
        try:
            return check()
        except (AssertionError, OSError, ssl.SSLError, subprocess.CalledProcessError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.15)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', default='ghcr.io/joysun99/neptu-cert-sync:git-local')
    parser.add_argument('--traefik-image', default='ghcr.io/joysun99/neptu-traefik@sha256:f4ce119ce03dc781b7e4c2d12d26d286668d8d84fe68aea61e19d8c59d4d979f')
    args = parser.parse_args()
    assert os.getuid() != 0, 'Run as a non-root fixture owner'
    base = Path(tempfile.mkdtemp(prefix='cert-sync-smoke-'))
    name = 'cert-sync-test-' + uuid.uuid4().hex[:12]
    containers = []
    created_network = False
    uid = f'{os.getuid()}:{os.getgid()}'
    def put(path, value):
        path.write_text(value if isinstance(value, str) else json.dumps(value))
        path.chmod(0o600)
    def openssl(*words):
        return command('openssl', *words)
    def pem(host, label, days):
        key, csr, cert, ext = (base / (label + s) for s in ('.key', '.csr', '.pem', '.ext'))
        openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(csr), '-subj', '/CN=' + host)
        put(ext, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:' + host + '\n')
        openssl('x509', '-req', '-in', str(csr), '-CA', str(base / 'ca.pem'), '-CAkey', str(base / 'ca.key'),
                '-CAcreateserial', '-out', str(cert), '-days', str(days), '-extfile', str(ext))
        key.chmod(0o600); cert.chmod(0o600)
        return {'host': host, 'certificate': cert.read_text(), 'key': key.read_text()}
    def cli(role, *words):
        return command('docker', 'run', '--rm', '--network', name, '--user', uid, '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--mount', f'type=bind,src={base},dst=/fixtures', '-e', 'NODE_EXTRA_CA_CERTS=/fixtures/ca.pem',
            args.image, *words, '--config', '/fixtures/' + role + '.json')
    def port(container, internal):
        raw = command('docker', 'port', container, str(internal) + '/tcp')
        return int(raw.rsplit(':', 1)[1])
    def http_get(p, host, path):
        connection = http.client.HTTPConnection('127.0.0.1', p, timeout=2)
        connection.request('GET', path, headers={'Host': host})
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result
    def tls_get(p, host, path='/business', expected=b'/business'):
        import socket
        context = ssl.create_default_context(cafile=str(base / 'ca.pem'))
        with socket.create_connection(('127.0.0.1', p), timeout=2) as raw:
            with context.wrap_socket(raw, server_hostname=host) as connection:
                certificate = connection.getpeercert(binary_form=True)
                connection.sendall(('GET ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n').encode())
                data = b''
                while part := connection.recv(65536):
                    data += part
        assert b'200 OK' in data and expected in data
        return hashlib.sha256(certificate).hexdigest()
    try:
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(base / 'ca.key'),
                '-out', str(base / 'ca.pem'), '-days', '40', '-subj', '/CN=cert-sync synthetic test CA',
                '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
        (base / 'ca.pem').chmod(0o600)
        original = pem('a.example.net', 'a', 10)
        renewed = pem('a.example.net', 'renewed', 20)
        pem('leader.example.net', 'transport', 20)
        pem('follower.example.net', 'local-transport', 20)
        import base64
        def acme(item):
            return {'test': {'Account': {'PrivateKey': 'synthetic-account-key-never-export'}, 'Certificates': [{
                'domain': {'main': item['host']},
                'certificate': base64.b64encode(item['certificate'].encode()).decode(),
                'key': base64.b64encode(item['key'].encode()).decode()}]}}
        for role in ('leader', 'follower'):
            root = base / role; root.mkdir(mode=0o700)
            (root / 'state').mkdir(mode=0o700); (root / 'dynamic').mkdir(mode=0o700)
            put(root / 'admin-token', __import__('secrets').token_urlsafe(32))
            cfg = {'schemaVersion': 1, 'role': role, 'nodeId': role, 'domains': ['a.example.net'],
                'publicURL': 'https://' + role + '.example.net', 'stateDirectory': '/fixtures/' + role + '/state',
                'targetDirectory': '/fixtures/' + role + '/dynamic', 'acmeFile': '/fixtures/acme.json',
                'adminTokenFile': '/fixtures/' + role + '/admin-token', 'intervalSeconds': 3600,
                'proxy': {'backendURL': 'http://cert-sync-' + role + ':8080', 'tlsOptions': 'existing-node-policy'}}
            put(base / (role + '.json'), cfg)
        put(base / 'acme.json', acme(original))
        put(base / 'gateway.mjs', '''import http from 'node:http';import https from 'node:https';import fs from 'node:fs';
https.createServer({key:fs.readFileSync('/fixtures/transport.key'),cert:fs.readFileSync('/fixtures/transport.pem')},(q,s)=>{
const r=http.request({host:'cert-sync-leader',port:8080,path:q.url,method:q.method,headers:q.headers},p=>{s.writeHead(p.statusCode,p.headers);p.pipe(s)});r.on('error',()=>{s.writeHead(502);s.end()});q.pipe(r)}).listen(443,'0.0.0.0');
http.createServer((q,s)=>{s.end(q.headers.host+'|'+q.url)}).listen(80,'0.0.0.0');''')
        command('docker', 'network', 'create', name); created_network = True
        cli('leader', 'init'); cli('follower', 'init')
        # Entrypoint arguments belong after the image, so start services separately.
        def service(role):
            container = name + '-' + role
            command('docker', 'run', '-d', '--name', container, '--network', name,
                '--network-alias', 'cert-sync-' + role, '--user', uid, '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--mount', f'type=bind,src={base},dst=/fixtures',
                '-e', 'NODE_EXTRA_CA_CERTS=/fixtures/ca.pem', args.image, 'run', '--config', '/fixtures/' + role + '.json')
            containers.append(container)
        service('leader'); service('follower')
        gateway = name + '-gateway'
        command('docker', 'run', '-d', '--name', gateway, '--network', name, '--network-alias', 'leader.example.net',
                '--user', uid, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--mount', f'type=bind,src={base},dst=/fixtures,readonly', '--entrypoint', 'node', args.image, '/fixtures/gateway.mjs')
        containers.append(gateway)
        wait(lambda: cli('leader', 'status'))
        cli('leader', 'create-join-token', '--node', 'follower', '--domains', 'a.example.net', '--output', '/fixtures/invitation.json')
        wait(lambda: cli('follower', 'join', '--invitation', '/fixtures/invitation.json'))
        cli('follower', 'sync'); cli('follower', 'status')
        dynamic = base / 'follower' / 'dynamic'
        put(dynamic / 'fixture.yml', {'tls': {'options': {'existing-node-policy': {'minVersion': 'VersionTLS12'}}, 'certificates': [{
            'certFile': '/fixtures/local-transport.pem', 'keyFile': '/fixtures/local-transport.key'}]},
            'http': {'routers': {'business': {'entryPoints': ['websecure'], 'rule': 'Host(`a.example.net`)',
                'tls': {'options': 'existing-node-policy'}, 'service': 'business'},
                'existing-node-route': {'entryPoints': ['websecure'], 'rule': 'Host(`follower.example.net`) && Path(`/unrelated`)', 'tls': {'options': 'existing-node-policy'}, 'service': 'business'}}, 'services': {'business': {'loadBalancer': {'servers': [{'url': 'http://leader.example.net:80'}]}}}}})
        static = {'entryPoints': {'web': {'address': ':8080', 'allowACMEByPass': True,
            'http': {'redirections': {'entryPoint': {'to': 'websecure', 'scheme': 'https'}}}},
            'websecure': {'address': ':8443'}},
            'providers': {'file': {'directory': '/fixtures/follower/dynamic', 'watch': True}},
            'certificatesResolvers': {'letsencrypt': {'acme': {'email': 'test@example.net',
                'storage': '/fixtures/local-acme.json', 'caServer': 'https://127.0.0.1:1/directory', 'httpChallenge': {'entryPoint': 'web'}}}}}
        put(base / 'traefik.json', static)
        proxy = name + '-proxy'
        command('docker', 'run', '-d', '--name', proxy, '--network', name, '--user', uid, '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '-p', '127.0.0.1::8080', '-p', '127.0.0.1::8443',
            '--mount', f'type=bind,src={base},dst=/fixtures', args.traefik_image, '--configFile=/fixtures/traefik.json')
        containers.append(proxy)
        web, secure = port(proxy, 8080), port(proxy, 8443)
        def challenge():
            status, body = http_get(web, 'a.example.net', '/.well-known/acme-challenge/synthetic')
            assert status == 200 and body == b'a.example.net|/.well-known/acme-challenge/synthetic'
        wait(challenge)
        assert http_get(web, 'follower.example.net', '/.well-known/acme-challenge/synthetic')[0] == 404
        first = wait(lambda: tls_get(secure, 'a.example.net'))
        wait(lambda: tls_get(secure, 'follower.example.net', '/console', b'cert-sync'))
        # Replace inode like Traefik does: the directory mount must see the new ACME file.
        put(base / 'acme.next', acme(renewed)); os.replace(base / 'acme.next', base / 'acme.json')
        cli('follower', 'sync')
        def reloaded():
            actual = tls_get(secure, 'a.example.net'); assert actual != first; return actual
        wait(reloaded)
        cli('leader', 'revoke', '--node', 'follower')
        old = (dynamic / 'shared-certificates.yml').read_bytes()
        try:
            cli('follower', 'sync'); raise AssertionError('revoked node accepted')
        except subprocess.CalledProcessError:
            pass
        assert (dynamic / 'shared-certificates.yml').read_bytes() == old
        assert tls_get(secure, 'a.example.net') != first
        print(json.dumps({'status': 'passed', 'image': args.image, 'checks': ['actual-runtime-cli-init',
            'readonly-nonroot', 'https-token-join', 'authenticated-sync', 'http01-host-preserving-forward',
            'local-acme-bypass-with-redirect', 'transport-host-not-forwarded', 'tls-verified-san',
            'acme-inode-replacement', 'traefik-certificate-reload', 'existing-nondefault-tls-policy', 'revocation-retains-existing-certificate']}))
    finally:
        for container in reversed(containers):
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if created_network:
            subprocess.run(['docker', 'network', 'rm', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(base)


if __name__ == '__main__':
    main()
