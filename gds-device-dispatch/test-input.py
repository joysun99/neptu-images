import importlib.util
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('gds_input',Path(__file__).with_name('prepare-input.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class InputContract(unittest.TestCase):
    def lock(self):return json.loads(Path(__file__).with_name('input.lock.json').read_text())
    def test_contract_rejects_private_or_mutable_inputs(self):
        for key,value in [('sourceDirty',True),('binaryURL','http://127.0.0.1/private'),('sourceCommit','main'),('binaryBytes',64*1024*1024+1)]:
            lock=self.lock();lock[key]=value
            with self.assertRaises(ValueError):m.validate(lock)
    def test_wrong_binary_never_creates_output(self):
        with tempfile.TemporaryDirectory() as d:
            raw=Path(d,'bad');raw.write_bytes(b'wrong');output=Path(d,'out')
            with self.assertRaises(ValueError):m.prepare(Path(__file__).with_name('input.lock.json'),output,raw)
            self.assertFalse(output.exists())
    def test_dynamic_or_wrong_arch_elf_rejected_even_with_matching_checksum(self):
        for machine,ptype in [(183,1),(62,3),(62,2)]:
            data=bytearray(120);data[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',data,18,machine);struct.pack_into('<Q',data,32,64);struct.pack_into('<HH',data,54,56,1);struct.pack_into('<I',data,64,ptype)
            lock=self.lock();lock.update(binaryBytes=len(data),binarySHA256=hashlib.sha256(data).hexdigest())
            with self.assertRaises(ValueError):m.verify_binary(data,lock)
    def test_static_elf_structure_is_accepted_after_exact_checksum(self):
        data=bytearray(120);data[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',data,18,62);struct.pack_into('<Q',data,32,64);struct.pack_into('<HH',data,54,56,1);struct.pack_into('<I',data,64,1)
        lock=self.lock();lock.update(binaryBytes=len(data),binarySHA256=hashlib.sha256(data).hexdigest());m.verify_binary(data,lock)
if __name__=='__main__':unittest.main()
