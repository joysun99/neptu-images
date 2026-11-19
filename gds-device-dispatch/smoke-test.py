#!/usr/bin/env python3
"""Verify the actual published GDS image against its exact prebuilt input."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import uuid

ROOT=Path(__file__).resolve().parent

def command(*args):return subprocess.check_output(args,text=True,timeout=30).strip()

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--image',required=True);p.add_argument('--lock',default=str(ROOT/'input.lock.json'));a=p.parse_args();lock=json.loads(Path(a.lock).read_text());image=json.loads(command('docker','image','inspect',a.image))[0]
    assert image['Os']=='linux' and image['Architecture']=='amd64'
    labels=image['Config']['Labels'];assert image['Config']['Entrypoint']==['/gds'] and image['Config']['User']=='65532:65532'
    if os.environ.get('REVISION'):assert labels['io.neptu.image.recipe-revision']==os.environ['REVISION']
    assert labels['org.opencontainers.image.revision']==lock['sourceCommit'] and labels['com.smartgds.binary-sha256']==lock['binarySHA256'] and labels['com.smartgds.native-manifest']==lock['nativeManifestSHA256']
    for user in ['65532:65532','1000:1000']:
        args=['docker','run','--rm','--read-only','--network','none','--user',user,'--cap-drop','ALL','--security-opt','no-new-privileges:true',a.image]
        version=json.loads(command(*args,'version'));assert version['sourceCommit']==lock['sourceCommit'] and version['sourceTree']==lock['sourceTree'] and not version['sourceDirty'] and version['version']==lock['version']
        cap=json.loads(command(*args,'capabilities'));assert cap['profile']=='gds-t3-capabilities-v84' and not cap['productionReplacementQualified']
    name='gds-input-check-'+uuid.uuid4().hex[:12];created=False
    try:
        command('docker','create','--name',name,a.image);created=True
        with tempfile.TemporaryDirectory(prefix='gds-input-image-') as directory:
            binary=Path(directory,'gds');ca=Path(directory,'ca.pem');notice=Path(directory,'htmx.txt')
            command('docker','cp',name+':/gds',str(binary));command('docker','cp',name+':/etc/ssl/certs/ca-certificates.crt',str(ca))
            command('docker','cp',name+':/usr/share/licenses/gds/htmx.txt',str(notice))
            assert hashlib.sha256(notice.read_bytes()).hexdigest()==lock['licenseFileSHA256']['licenses/htmx.txt']
            assert hashlib.sha256(binary.read_bytes()).hexdigest()==lock['binarySHA256'];assert ssl.create_default_context(cafile=str(ca)).get_ca_certs()
    finally:
        if created:subprocess.run(['docker','rm',name],check=True,stdout=subprocess.DEVNULL,timeout=15)
    print(json.dumps({'status':'passed','image':a.image,'imageID':image['Id'],'sourceCommit':lock['sourceCommit'],'version':lock['version'],'checks':['exact-binary-bytes','static-runtime-entrypoint','public-ca-bundle','pinned-htmx-license','two-nonroot-users','readonly-network-none','version-source-tree-binding','capability-v84-no-production-relabel'],'businessOrSQLAccess':False}))

if __name__=='__main__':main()
