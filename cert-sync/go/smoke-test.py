#!/usr/bin/env python3
"""Black-box cert-sync image, binary/provenance and foreground lifecycle checks."""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import tarfile
import tempfile
import time
import uuid

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('prepare',ROOT/'prepare-input.py');prepare=importlib.util.module_from_spec(spec);spec.loader.exec_module(prepare)

def run(*args):return subprocess.check_output(args,timeout=40).decode().strip()
def until(fn,seconds=15):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if fn():return
        time.sleep(.2)
    raise AssertionError('runtime observation deadline')

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--image',required=True);p.add_argument('--lock',default=str(ROOT/'input.lock.json'));a=p.parse_args()
    lock=prepare.load(a.lock);prepare.validate(lock);image=json.loads(run('docker','image','inspect',a.image))[0]
    assert image['Os']=='linux' and image['Architecture']=='amd64'
    config=image['Config'];labels=config['Labels']
    assert config['Entrypoint']==['/gds','cert'] and config['User']=='1000:1000' and config['StopSignal']=='SIGTERM'
    assert config['Cmd']==['serve']
    assert config['Healthcheck']['Test']==['CMD','/gds','cert','probe']
    assert labels['org.opencontainers.image.revision']==lock['sourceCommit'] and labels['org.opencontainers.image.version']==lock['version']
    for field,key in [('source-tree','sourceTree'),('binary-sha256','binarySHA256'),('candidate-manifest','candidateManifestSHA256')]:assert labels['io.neptu.cert-sync.'+field]==lock[key]
    recipe=labels['io.neptu.image.recipe-revision'];assert re.fullmatch('[a-f0-9]{40}',recipe)
    if os.environ.get('REVISION'):assert recipe==os.environ['REVISION']
    for user in ['1000:1000','65532:65532']:
        common=['docker','run','--rm','--pull=never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges=true','--user',user,a.image]
        version=json.loads(run(*common,'version'));assert version=={'service':'Global Cert Sync','version':lock['version'],'sourceCommit':lock['sourceCommit'],'sourceTree':lock['sourceTree'],'sourceDirty':False,'goVersion':lock['goVersion']}
        capabilities=json.loads(run(*common,'capabilities'));assert capabilities['profile']==lock['capabilityProfile'] and capabilities['servingImplemented'] and not capabilities['productionQualified']
    excluded=subprocess.run(['docker','run','--rm','--pull=never','--network','none','--read-only','--entrypoint','/gds',a.image,'device','serve'],capture_output=True,timeout=10)
    assert excluded.returncode==2 and not excluded.stdout
    label='cert-image-'+uuid.uuid4().hex[:12];containers=[]
    with tempfile.TemporaryDirectory(prefix='cert-image-') as directory:
        root=Path(directory);root.chmod(0o700)
        try:
            name=label+'-inspect';run('docker','create','--name',name,'--label','neptu.cert-smoke='+label,a.image);containers.append(name)
            run('docker','cp',name+':/gds',str(root/'gds'));run('docker','cp',name+':/usr/local/bin/cert-sync',str(root/'cert-sync'));run('docker','cp',name+':/etc/ssl/certs/ca-certificates.crt',str(root/'ca.pem'))
            prepare.verify_binary((root/'gds').read_bytes(),lock);assert (root/'gds').read_bytes()==(root/'cert-sync').read_bytes()
            assert ssl.create_default_context(cafile=str(root/'ca.pem')).get_ca_certs()
            exported=subprocess.check_output(['docker','export',name],timeout=30)
            with tarfile.open(fileobj=io.BytesIO(exported)) as archive:
                for member in archive:
                    assert not member.name.endswith(('.go','.mjs','.db','.sqlite')), 'application source/data leaked into image'
            private=root/'fixture';private.mkdir(mode=0o700)
            document={'schemaVersion':1,'role':'leader','nodeId':'image-a','publicURL':'https://image.example.net','domains':[],
                      'stateDirectory':'/fixture/state','targetDirectory':'/fixture/dynamic','adminTokenFile':'/fixture/admin-token'}
            (private/'cert.json').write_text(json.dumps(document));(private/'cert.json').chmod(0o600)
            (private/'admin-token').write_text('a'*43);(private/'admin-token').chmod(0o600)
            assert os.getuid()!=0,'nonroot host user required for owner-aligned fixture'
            mounts=['--mount','type=bind,src='+str(private)+',dst=/fixture','--mount','type=bind,src='+str(private/'cert.json')+',dst=/etc/gds/cert/config.json,readonly']
            common=['--pull=never','--user',str(os.getuid())+':'+str(os.getgid()),'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges=true',*mounts]
            run('docker','run','--rm',*common,a.image,'init')
            identity=(private/'state/shared-registry.json').read_bytes()
            name=label+'-runtime';run('docker','run','-d','--name',name,'--label','neptu.cert-smoke='+label,'--restart','unless-stopped',
                                      '--health-interval','1s',*common,a.image);containers.append(name)
            inspect=lambda:json.loads(run('docker','inspect',name))[0]
            until(lambda:inspect()['State']['Health']['Status']=='healthy')
            status=json.loads(run('docker','exec',name,'/gds','cert','status'))
            assert status['healthy'] and status['nodeId']==document['nodeId']
            run('docker','exec',name,'/usr/local/bin/cert-sync','check')
            override=private/'alternate.json'
            override.write_text(json.dumps({**document,'nodeId':'alternate-a'}));override.chmod(0o600)
            checked=json.loads(run('docker','exec',name,'/gds','cert','check','--config','/fixture/alternate.json'))
            assert checked['valid'] and checked['nodeId']=='alternate-a'
            missing=subprocess.run(['docker','exec',name,'/gds','cert','check','--config','/fixture/missing.json'],
                                   capture_output=True,timeout=10)
            assert missing.returncode==2 and not missing.stdout
            assert json.loads(missing.stderr)['error']['code']=='file-not-found'
            run('docker','stop','-t','5',name);run('docker','start',name)
            until(lambda:inspect()['State']['Health']['Status']=='healthy')
            assert (private/'state/shared-registry.json').read_bytes()==identity
            run('docker','stop','-t','5',name);time.sleep(1);assert not inspect()['State']['Running']
        finally:
            for name in reversed(containers):
                actual=json.loads(run('docker','inspect',name))[0];assert actual['Config']['Labels']['neptu.cert-smoke']==label
                run('docker','rm','-f',name)
    print(json.dumps({'status':'passed','image':a.image,'imageID':image['Id'],'sourceCommit':lock['sourceCommit'],'recipeCommit':recipe,'binarySHA256':lock['binarySHA256'],
        'checks':['static-exact-cert-only-binary','source-tree-version-and-labels','two-nonroot-users','public-ca','no-go-node-source-or-data',
                  'foreground-json-healthcheck','default-config-mount','explicit-config-override','legacy-binary-entry','readonly-no-cap-network-none','original-identity-stop-start','unless-stopped-manual-stop'],
        'production':False}))

if __name__=='__main__':main()
