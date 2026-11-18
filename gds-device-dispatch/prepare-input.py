#!/usr/bin/env python3
"""Fetch one reviewed prebuilt static GDS binary; private source is never read."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent

def validate(lock):
    if lock.get('schemaVersion') != 1 or lock.get('service') != 'gds-device-dispatch' or lock.get('platform') != 'linux/amd64' or lock.get('sourceDirty') is not False:
        raise ValueError('invalid approved binary input contract')
    for key, length in [('sourceCommit', 40), ('sourceTree', 64), ('binarySHA256', 64), ('nativeManifestSHA256', 64)]:
        if not re.fullmatch('[a-f0-9]{'+str(length)+'}', str(lock.get(key,''))): raise ValueError('invalid input digest')
    if not re.fullmatch(r'https://github\.com/joysun99/neptu-images/releases/download/[a-zA-Z0-9._-]+/gds-linux-amd64', lock.get('binaryURL','')):
        raise ValueError('binary URL must be the fixed public input release asset')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?',lock.get('version','')): raise ValueError('invalid input version')
    if type(lock.get('binaryBytes')) is not int or not 1 <= lock['binaryBytes'] <= 64*1024*1024: raise ValueError('invalid binary size')
    if type(lock.get('createdAt')) is not int or lock['createdAt'] < 1: raise ValueError('invalid source timestamp')
    for name, digest in lock.get('licenseFileSHA256',{}).items():
        if not re.fullmatch(r'licenses/[a-z0-9-]+\.txt',name) or hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=digest: raise ValueError('public license input differs')

def verify_binary(data, lock):
    if len(data)!=lock['binaryBytes'] or hashlib.sha256(data).hexdigest()!=lock['binarySHA256']: raise ValueError('binary bytes differ from reviewed input')
    if len(data)<64 or data[:6]!=b'\x7fELF\x02\x01' or struct.unpack_from('<H',data,18)[0]!=62: raise ValueError('expected Linux amd64 ELF64 binary')
    offset=struct.unpack_from('<Q',data,32)[0]; size,count=struct.unpack_from('<HH',data,54)
    if size<56 or count>128 or offset+size*count>len(data): raise ValueError('invalid ELF program headers')
    if any(struct.unpack_from('<I',data,offset+i*size)[0] in (2,3) for i in range(count)): raise ValueError('binary must be static without a dynamic loader')

def prepare(lock_file, output, local=None):
    lock=json.loads(Path(lock_file).read_text());validate(lock)
    if local: data=Path(local).read_bytes()
    else:
        deadline=time.monotonic()+180
        with urllib.request.urlopen(lock['binaryURL'],timeout=30) as source:
            parts=[];total=0
            while True:
                if time.monotonic()>deadline: raise TimeoutError('binary download window exhausted')
                chunk=source.read(min(1024*1024,lock['binaryBytes']+1-total))
                if not chunk:break
                parts.append(chunk);total+=len(chunk)
                if total>lock['binaryBytes']:raise ValueError('download exceeded approved size')
            data=b''.join(parts)
    verify_binary(data,lock)
    output=Path(output);output.mkdir(mode=0o700,exist_ok=False)
    descriptor=os.open(output/'gds',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o555)
    with os.fdopen(descriptor,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
    return lock

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--lock',default=str(ROOT/'input.lock.json'));p.add_argument('--out-dir',default=str(ROOT/'.inputs'));p.add_argument('--local-file');p.add_argument('--github-env',action='store_true');a=p.parse_args()
    lock=prepare(a.lock,a.out_dir,a.local_file)
    values={'GDS_VERSION':lock['version'],'SOURCE_COMMIT':lock['sourceCommit'],'SOURCE_TREE':lock['sourceTree'],'BINARY_SHA256':lock['binarySHA256'],'NATIVE_MANIFEST_SHA256':lock['nativeManifestSHA256'],'SOURCE_DATE_EPOCH':str(lock['createdAt'])}
    if a.github_env:
        with open(os.environ['GITHUB_ENV'],'a') as env:
            for k,v in values.items():env.write(k+'='+v+'\n')
    print(json.dumps({'status':'verified','platform':lock['platform'],**values}))

if __name__=='__main__':main()
