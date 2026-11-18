import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('pull_public_image',Path(__file__).with_name('pull-public-image.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
REF='ghcr.io/joysun99/neptu-cert-sync@sha256:'+'3'*64

class PullContract(unittest.TestCase):
    def exercise(self, failure=None):
        with tempfile.TemporaryDirectory() as base:
            original=Path(base,'existing-config.json');original.write_text('{"auths":{"ghcr.io":{"auth":"PRIVATE_TEST_MARKER"}}}')
            before=original.read_bytes();calls=[];contexts=[]
            def docker(argv, **kw):
                context=Path(argv[2]);contexts.append(context);calls.append(argv)
                self.assertEqual(argv[3:5],['--host','unix:///var/run/docker.sock'])
                self.assertEqual(context.stat().st_mode&0o777,0o700)
                self.assertEqual((context/'config.json').stat().st_mode&0o777,0o600)
                self.assertEqual(json.loads((context/'config.json').read_text()),{})
                self.assertTrue(all(k not in kw['env'] for k in module.CREDENTIAL_ENV))
                if argv[5]=='pull':return module.subprocess.CompletedProcess(argv,17 if failure=='pull' else 0,'','registry denied' if failure=='pull' else '')
                self.assertEqual(argv[5:7],['image','inspect'])
                digest=REF if failure!='digest' else REF.replace('3'*64,'4'*64)
                return module.subprocess.CompletedProcess(argv,0,json.dumps([{'Id':'sha256:'+'5'*64,'Os':'linux','Architecture':'amd64','RepoDigests':[digest]}]),'')
            with patch.dict(os.environ,{k:str(original) for k in module.CREDENTIAL_ENV}), patch.object(module.subprocess,'run',side_effect=docker), contextlib.redirect_stderr(io.StringIO()):
                if failure:
                    with self.assertRaises(RuntimeError):module.pull([REF])
                else:
                    result=module.pull([REF]);self.assertEqual(result['images'][0]['image'],REF)
            self.assertEqual(original.read_bytes(),before)
            self.assertTrue(contexts and all(not p.exists() for p in contexts))
            self.assertTrue(all(a[5] in ['pull','image'] for a in calls))
            if failure=='pull':self.assertEqual(len(calls),1)
    def test_isolated_credentials_and_cleanup(self):self.exercise()
    def test_failed_pull_does_not_continue_and_cleans_up(self):self.exercise('pull')
    def test_missing_digest_is_rejected(self):self.exercise('digest')
    def test_all_references_validated_before_any_docker_operation(self):
        with patch.object(module.subprocess,'run') as run:
            for value in ['ghcr.io/joysun99/neptu-cert-sync:latest','docker.io/library/mysql@sha256:'+'1'*64,REF+';id']:
                with self.assertRaises(module.argparse.ArgumentTypeError):module.pull([REF,value])
            run.assert_not_called()

if __name__=='__main__':unittest.main()
