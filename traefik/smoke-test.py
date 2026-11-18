#!/usr/bin/env python3
"""Exercise a Traefik image with synthetic config and loopback-only published ports."""
import argparse
import http.client
import json
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import time
import uuid


def docker(*args, check=True):
    result = subprocess.run(['docker', *args], check=check, text=True, capture_output=True)
    return result.stdout + (result.stderr if args[0] == 'logs' else '')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='ghcr.io/joysun99/neptu-traefik:git-local')
    parser.add_argument('--user', default='65532:65532')
    args = parser.parse_args()
    image = json.loads(docker('image', 'inspect', args.image))[0]
    assert image['Config']['User'] == '65532:65532', 'unexpected default image user'
    version = docker('run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
                     '--security-opt=no-new-privileges', '--user', args.user, args.image, 'version')
    assert '3.7.14-neptu1' in version, version
    name = 'neptu-traefik-smoke-' + uuid.uuid4().hex[:12]
    created = False
    with tempfile.TemporaryDirectory(prefix='neptu-traefik-') as tmp:
        root = Path(tmp)
        root.chmod(0o755)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-days', '1', '-subj', '/CN=smoke.invalid', '-addext',
                        'subjectAltName=DNS:smoke.invalid,DNS:node.invalid',
                        '-keyout', str(root / 'key.pem'), '-out', str(root / 'cert.pem')],
                       check=True, capture_output=True)
        # Synthetic throwaway key only; no production material enters this test.
        (root / 'key.pem').chmod(0o644)
        static = {
            'global': {'checkNewVersion': False, 'sendAnonymousUsage': False},
            'entryPoints': {k: {'address': f':{p}'} for k, p in
                            [('web', 8080), ('websecure', 8443), ('health', 8082), ('node', 9443)]},
            'ping': {'entryPoint': 'health'},
            'providers': {'file': {'filename': '/config/dynamic.json', 'watch': False}},
        }
        # The private node entry point is the TLS backend. It is never published.
        # /ping provides the backend bytes without another image or host listener.
        dynamic = {
            'http': {
                'routers': {
                    'plain': {'entryPoints': ['web'], 'rule': 'Host(`smoke.invalid`)', 'service': 'backend'},
                    'secure': {'entryPoints': ['websecure'], 'rule': 'Host(`smoke.invalid`)',
                               'service': 'backend', 'tls': {}},
                    'node-backend': {'entryPoints': ['node'], 'rule': 'Host(`node.invalid`)',
                                     'service': 'backend', 'tls': {'options': 'node'}},
                },
                'services': {'backend': {'loadBalancer': {'servers': [
                    {'url': 'http://127.0.0.1:8082'}]}}},
            },
            'tcp': {
                'routers': {'node': {'entryPoints': ['websecure'],
                    'rule': 'HostSNI(`node.invalid`) && (ALPN(`neptu-device-sync/1`) || ALPN(`neptu-device-join/1`))',
                    'service': 'node', 'tls': {'passthrough': True}}},
                'services': {'node': {'loadBalancer': {'servers': [{'address': '127.0.0.1:9443'}]}}},
            },
            'tls': {'certificates': [{'certFile': '/config/cert.pem', 'keyFile': '/config/key.pem'}],
                    'options': {'node': {'alpnProtocols': ['http/1.1']}}},
        }
        for filename, data in [('static.json', static), ('dynamic.json', dynamic)]:
            (root / filename).write_text(json.dumps(data))
        try:
            docker('run', '-d', '--name', name, '--read-only', '--cap-drop=ALL',
                   '--security-opt=no-new-privileges', '--user', args.user,
                   '-p', '127.0.0.1::8080', '-p', '127.0.0.1::8443', '-p', '127.0.0.1::8082',
                   '--mount', f'type=bind,src={tmp},dst=/config,readonly', args.image,
                   '--configFile=/config/static.json')
            created = True
            state = json.loads(docker('inspect', name))[0]
            ports = {p: int(state['NetworkSettings']['Ports'][f'{p}/tcp'][0]['HostPort'])
                     for p in [8080, 8443, 8082]}
            for _ in range(150):
                try:
                    health = http.client.HTTPConnection('127.0.0.1', ports[8082], timeout=1)
                    health.request('GET', '/ping')
                    result = health.getresponse()
                    assert result.status == 200 and result.read() == b'OK'
                    health.close()
                    break
                except (OSError, AssertionError, http.client.HTTPException):
                    time.sleep(0.1)
            else:
                raise AssertionError('Traefik health startup timeout')
            for encrypted in [False, True]:
                if encrypted:
                    client = ssl.create_default_context(cafile=str(root / 'cert.pem'))
                    raw = socket.create_connection(('127.0.0.1', ports[8443]), timeout=3)
                    conn = http.client.HTTPConnection('127.0.0.1', ports[8443], timeout=3)
                    conn.sock = client.wrap_socket(raw, server_hostname='smoke.invalid')
                else:
                    conn = http.client.HTTPConnection('127.0.0.1', ports[8080], timeout=3)
                conn.request('GET', '/ping', headers={'Host': 'smoke.invalid'})
                response = conn.getresponse()
                assert response.status == 200 and response.read() == b'OK'
                conn.close()
            for selector in ['neptu-device-sync/1', 'neptu-device-join/1', None]:
                client = ssl.create_default_context(cafile=str(root / 'cert.pem'))
                # A Device selector chooses TCP passthrough; the backend negotiates HTTP/1.1.
                client.set_alpn_protocols(([selector] if selector else []) + ['http/1.1'])
                with socket.create_connection(('127.0.0.1', ports[8443]), timeout=3) as raw:
                    with client.wrap_socket(raw, server_hostname='node.invalid') as stream:
                        assert stream.selected_alpn_protocol() == 'http/1.1'
                        stream.sendall(b'GET /ping HTTP/1.0\r\nHost: node.invalid\r\n\r\n')
                        body = b''
                        while True:
                            chunk = stream.recv(4096)
                            if not chunk:
                                break
                            body += chunk
                        if selector:
                            assert b'200 OK' in body and body.endswith(b'OK'), body
                        else:
                            assert b'404 Not Found' in body, 'missing selector reached node backend'
            assert json.loads(docker('inspect', name))[0]['State']['Running']
            print(json.dumps({'imageId': image['Id'], 'user': args.user,
                              'checks': ['version', 'readonly-nonroot', 'ping', 'http',
                                         'https-verified-san', 'same-port-device-sync-join-alpn-passthrough',
                                         'missing-alpn-selector-refused'],
                              'status': 'passed'}))
        except Exception:
            if created:
                print(docker('logs', name, check=False))
            raise
        finally:
            if created:
                docker('rm', '-f', name, check=False)


if __name__ == '__main__':
    main()
