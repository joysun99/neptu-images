#!/usr/bin/env python3
"""Validate reviewed input negatives; no registry or private source access."""
import copy
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('prepare',ROOT/'prepare-input.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Contracts(unittest.TestCase):
    def setUp(self):self.lock=module.load(ROOT/'input.lock.json')
    def test_valid_lock_and_licenses(self):module.validate(self.lock)
    def test_unapproved_scope_bytes_and_urls_refuse(self):
        for changes in [{'sourceDirty':True},{'platform':'linux/arm64'},{'service':'device'}, {'binaryBytes':True},
                        {'sourceCommit':'bad'},{'binarySHA256':'A'*64},{'candidateManifestSHA256':''},
                        {'binaryURL':'https://other.example/private'},{'version':'bad\nvalue'},
                        {'capabilityProfile':'gds-t3-capabilities-v84'},{'licenseFileSHA256':{}},
                        {'imagePackage':'ghcr.io/other/package'},{'sourceTreeAlgorithm':'different'}]:
            lock={**self.lock,**changes}
            with self.assertRaises(ValueError):module.validate(lock)
    def test_license_changes_and_paths_refuse(self):
        for path in ['licenses/../../secret','licenses/unknown.txt','licenses/go.txt']:
            lock=copy.deepcopy(self.lock);lock['licenseFileSHA256'][path]='0'*64
            with self.assertRaises(ValueError):module.validate(lock)
    def test_bad_binary_leaves_no_output(self):
        with tempfile.TemporaryDirectory() as root:
            bad=Path(root,'bad');bad.write_bytes(b'not the reviewed executable');out=Path(root,'inputs')
            with self.assertRaises(ValueError):module.prepare(ROOT/'input.lock.json',out,bad)
            self.assertFalse(out.exists())
    def test_dynamic_elf_refuses_even_if_digest_matches(self):
        import hashlib
        data=bytearray(120);data[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',data,18,62);struct.pack_into('<Q',data,32,64);struct.pack_into('<HH',data,54,56,1)
        for kind in [2,3]:
            struct.pack_into('<I',data,64,kind);lock={**self.lock,'binaryBytes':len(data),'binarySHA256':hashlib.sha256(data).hexdigest()}
            with self.assertRaises(ValueError):module.verify_binary(data,lock)
    def test_duplicate_json_refuses(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root,'duplicate');path.write_text('{"schemaVersion":1,"schemaVersion":1}')
            with self.assertRaises(ValueError):module.load(path)

if __name__=='__main__':unittest.main()
