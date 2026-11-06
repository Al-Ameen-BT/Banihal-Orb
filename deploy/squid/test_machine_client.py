import hashlib
import hmac
import unittest
from machine_client import signed_headers


class ProtocolTest(unittest.TestCase):
    def test_exact_v2_signature_and_tamper(self):
        body = b'{"seq":3,"ok":true}'
        nonce = 'ab' * 16
        headers = signed_headers('proxy', 'p1', 'secret', 'POST', '/api/proxy-agent/result?q=1', body, 123, nonce)
        canonical = '\n'.join(['B2B-MACHINE-V2', 'proxy:p1', '123', nonce, 'POST', '/api/proxy-agent/result?q=1', hashlib.sha256(body).hexdigest()])
        expected = hmac.new(b'secret', canonical.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(headers['Authorization'], 'Bearer ' + expected)
        self.assertNotEqual(headers['Authorization'], signed_headers('proxy', 'p2', 'secret', 'POST', '/api/proxy-agent/result?q=1', body, 123, nonce)['Authorization'])

    def test_retries_have_fresh_nonces(self):
        first = signed_headers('worker', 'b1', 'secret', 'POST', '/api/bot-worker/b1/state', b'{}')
        second = signed_headers('worker', 'b1', 'secret', 'POST', '/api/bot-worker/b1/state', b'{}')
        self.assertNotEqual(first['X-Machine-Nonce'], second['X-Machine-Nonce'])


if __name__ == '__main__':
    unittest.main()
