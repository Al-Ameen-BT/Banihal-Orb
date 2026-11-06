import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from platform_writer import apply_bundle, validate_bundle


class WriterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.managed = self.root / 'acls'; self.managed.mkdir()
        self.key = Ed25519PrivateKey.generate()
        self.public = self.root / 'public.pem'
        self.public.write_bytes(self.key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
        self.config = {'state_dir': str(self.root / 'state'), 'managed_dir': str(self.managed), 'bundle_public_key': str(self.public), 'proxy_id': 'p1'}

    def bundle(self, seq=1, content='new config', path='/etc/squid/acls/webgui_generated.conf'):
        files = [{'path': path, 'content': content}]
        raw = json.dumps({'protocol': 2, 'proxyId': 'p1', 'seq': seq, 'files': files}, separators=(',', ':'), ensure_ascii=False).encode()
        return {'collection': 'squid-conf', 'protocol': 2, 'proxyId': 'p1', 'seq': seq, 'files': files, 'signature': base64.b64encode(self.key.sign(raw)).decode()}

    @patch('platform_writer._run')
    def test_duplicate_delivery_does_not_reload(self, run):
        apply_bundle(self.bundle(), self.config)
        self.assertEqual(run.call_count, 3)
        self.assertTrue(apply_bundle(self.bundle(), self.config)['duplicate'])
        self.assertEqual(run.call_count, 3)
        with self.assertRaises(ValueError):
            apply_bundle(self.bundle(content='different'), self.config)

    @patch('platform_writer._run')
    def test_parse_failure_restores_last_configuration(self, run):
        target = self.managed / 'webgui_generated.conf'; target.write_text('working')
        owner = target.stat().st_uid, target.stat().st_gid
        run.side_effect = [RuntimeError('parse'), None, None, None]
        with self.assertRaises(RuntimeError):
            apply_bundle(self.bundle(), self.config)
        self.assertEqual(target.read_text(), 'working')
        self.assertEqual((target.stat().st_uid, target.stat().st_gid), owner)
        self.assertFalse((self.root / 'state' / 'applied.json').exists())

    def test_path_escape_and_signature_tamper(self):
        with self.assertRaises(ValueError):
            validate_bundle(self.bundle(path='/etc/passwd'), self.public, 'p1')
        bundle = self.bundle(); bundle['files'][0]['content'] = 'tampered'
        with self.assertRaises(Exception):
            validate_bundle(bundle, self.public, 'p1')
        with self.assertRaises(ValueError):
            validate_bundle(self.bundle(), self.public, 'p2')

    @patch('platform_writer._run')
    def test_local_pause_never_writes_or_reloads(self, run):
        state = self.root / 'state'; state.mkdir(); (state / 'overload-paused').touch()
        with self.assertRaises(RuntimeError):
            apply_bundle(self.bundle(), self.config)
        run.assert_not_called()
        self.assertFalse((self.managed / 'webgui_generated.conf').exists())


if __name__ == '__main__':
    unittest.main()
