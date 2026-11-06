import os
import unittest
from unittest.mock import patch
from flask import Flask
import managed_mode


class ManagedModeTest(unittest.TestCase):
    def test_managed_policy_blocks_legacy_and_dr_writes(self):
        app = Flask(__name__)
        app.add_url_rule('/policy', 'policy', lambda: 'write', methods=['GET', 'POST', 'PUT', 'DELETE'])
        app.add_url_rule('/login', 'login', lambda: 'login', methods=['POST'])
        managed_mode.install(app)
        with patch.dict(os.environ, {'PLATFORM_MANAGED': 'true'}):
            client = app.test_client()
            self.assertEqual(client.get('/policy').status_code, 200)
            for method in ('post', 'put', 'delete'):
                self.assertEqual(getattr(client, method)('/policy').status_code, 423)
            self.assertEqual(client.post('/login').status_code, 200)


if __name__ == '__main__':
    unittest.main()
