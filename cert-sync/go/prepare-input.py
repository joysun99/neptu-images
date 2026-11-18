#!/usr/bin/env python3
"""Verify one reviewed public cert-sync binary and its license inputs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import time
import urllib.parse
import urllib.request

ROOT=Path(__file__).resolve().parent

def unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise ValueError('duplicate JSON field')
        result[key]=value
    return result

def load(path):return json.loads(Path(path).read_text(),object_pairs_hook=unique)

def validate(lock):
    if lock.get('schemaVersion')!=1 or lock.get('service')!='cert-sync' or lock.get('platform')!='linux/amd64' or lock.get('sourceDirty') is not False:
        raise ValueError('invalid reviewed input scope')
    if lock.get('imagePackage')!='ghcr.io/joysun99/neptu-cert-sync' or lock.get('imageTagPrefix')!='go-git-' or lock.get('goVersion')!='go1.27.3':
        raise ValueError('wrong runtime family or toolchain')
    if lock.get('sourceTreeAlgorithm')!='sha256-git-ls-tree-rz-full-tree' or lock.get('capabilityProfile')!='gds-global-cert-sync-capabilities-v5':
        raise ValueError('wrong source or capability contract')
    for key,length in [('sourceCommit',40),('sourceTree',64),('binarySHA256',64),('candidateManifestSHA256',64)]:
        if not re.fullmatch('[a-f0-9]{'+str(length)+'}',str(lock.get(key,''))):raise ValueError('invalid input digest')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?',lock.get('version','')):raise ValueError('invalid version')
    if not re.fullmatch(r'https://github\.com/joysun99/neptu-images/releases/download/cert-sync-input-[a-f0-9]{7,40}/gds-cert-linux-amd64',lock.get('binaryURL','')):
        raise ValueError('unexpected public binary asset')
    if type(lock.get('binaryBytes')) is not int or not 1<=lock['binaryBytes']<=64*1024*1024:raise ValueError('invalid binary size')
    if type(lock.get('createdAt')) is not int or lock['createdAt']<1:raise ValueError('invalid source epoch')
    licenses=lock.get('licenseFileSHA256',{})
    if not isinstance(licenses,dict) or not {'licenses/go.txt','licenses/whatwg-url.txt','licenses/json-canonicalization.txt'}<=licenses.keys():raise ValueError('missing required license notices')
    for name,digest in licenses.items():
        path=ROOT/name
        if not re.fullmatch(r'licenses/[a-z0-9-]+\.txt',name) or path.is_symlink() or not path.is_file() or not re.fullmatch('[a-f0-9]{64}',str(digest)) or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
            raise ValueError('license input differs')
    if {str(p.relative_to(ROOT)) for p in (ROOT/'licenses').iterdir()}!=set(licenses):raise ValueError('unexpected license files')

def verify_binary(data,lock):
    if len(data)!=lock['binaryBytes'] or hashlib.sha256(data).hexdigest()!=lock['binarySHA256']:raise ValueError('binary bytes differ')
    if len(data)<64 or data[:6]!=b'\x7fELF\x02\x01' or struct.unpack_from('<H',data,18)[0]!=62:raise ValueError('linux-amd64 ELF64 required')
    start=struct.unpack_from('<Q',data,32)[0];width,count=struct.unpack_from('<HH',data,54)
    if width<56 or count>128 or start+width*count>len(data):raise ValueError('invalid program headers')
    if any(struct.unpack_from('<I',data,start+i*width)[0] in (2,3) for i in range(count)):raise ValueError('dynamic binary forbidden')

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,fp,code,msg,headers,newurl):
        endpoint=urllib.parse.urlsplit(newurl)
        if endpoint.scheme!='https' or endpoint.hostname not in {'github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'} or endpoint.username or endpoint.password or endpoint.port not in (None,443):
            raise ValueError('unexpected binary download redirect')
        return super().redirect_request(request,fp,code,msg,headers,newurl)

def prepare(lock_file,output,local=None):
    lock=load(lock_file);validate(lock)
    if local:
        with open(local,'rb') as stream:data=stream.read(lock['binaryBytes']+1)
    else:
        deadline=time.monotonic()+180
        with urllib.request.build_opener(SafeRedirect()).open(lock['binaryURL'],timeout=30) as source:
            pieces=[];size=0
            while True:
                if time.monotonic()>deadline:raise TimeoutError('public input download deadline')
                block=source.read(min(1024*1024,lock['binaryBytes']+1-size))
                if not block:break
                pieces.append(block);size+=len(block)
                if size>lock['binaryBytes']:raise ValueError('download exceeds reviewed size')
            data=b''.join(pieces)
    verify_binary(data,lock)
    output=Path(output);output.mkdir(mode=0o700,exist_ok=False)
    try:
        fd=os.open(output/'gds',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o555)
        with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
        directory=os.open(output,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    except BaseException:
        shutil.rmtree(output);raise
    return lock

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--lock',default=str(ROOT/'input.lock.json'));p.add_argument('--out-dir',default=str(ROOT/'.inputs'));p.add_argument('--local-file');p.add_argument('--github-env',action='store_true');a=p.parse_args()
    lock=prepare(a.lock,a.out_dir,a.local_file)
    values={'CERT_VERSION':lock['version'],'SOURCE_COMMIT':lock['sourceCommit'],'SOURCE_TREE':lock['sourceTree'],'BINARY_SHA256':lock['binarySHA256'],'CANDIDATE_MANIFEST_SHA256':lock['candidateManifestSHA256'],'SOURCE_DATE_EPOCH':str(lock['createdAt'])}
    if a.github_env:
        with open(os.environ['GITHUB_ENV'],'a') as stream:
            for key,value in values.items():stream.write(key+'='+value+'\n')
    print(json.dumps({'status':'verified',**values}))

if __name__=='__main__':main()
