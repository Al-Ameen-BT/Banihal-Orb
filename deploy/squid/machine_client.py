#!/usr/bin/env python3
"""Outbound-only HTTPS/TCP client shared by agents and host bot workers."""
import hashlib
import hmac
import json
import secrets
import ssl
import time
import urllib.parse
import urllib.request


def signed_headers(kind, actor_id, secret, method, path, body, timestamp=None, nonce=None):
    timestamp = str(timestamp if timestamp is not None else int(time.time() * 1000))
    nonce = nonce or secrets.token_hex(16)
    canonical = '\n'.join(['B2B-MACHINE-V2', f'{kind}:{actor_id}', timestamp,
                           nonce, method.upper(), path, hashlib.sha256(body).hexdigest()])
    return {'Authorization': 'Bearer ' + hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest(),
            'X-Machine-Version': '2', 'X-Machine-Nonce': nonce,
            ('X-Proxy-Timestamp' if kind == 'proxy' else 'X-Worker-Timestamp'): timestamp,
            'X-Proxy-Id': actor_id, 'Content-Type': 'application/json'}


class MachineClient:
    def __init__(self, base_url, kind, actor_id, secret, ca_file, cert_file, key_file):
        url = urllib.parse.urlsplit(base_url)
        if url.scheme != 'https' or not url.hostname or url.username or url.query or url.fragment or url.path not in ('', '/'):
            raise ValueError('A bare HTTPS platform machine origin is required')
        if kind not in ('proxy', 'worker') or not actor_id or any(c in actor_id for c in '\r\n/'):
            raise ValueError('Invalid machine identity')
        self.base_url, self.kind, self.actor_id, self.secret = base_url.rstrip('/'), kind, actor_id, secret
        context = ssl.create_default_context(cafile=ca_file)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert_file, key_file)
        # Do not inherit workstation proxy settings or follow redirects carrying credentials.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context), NoRedirect())

    def request(self, method, path, payload=None):
        if not path.startswith('/api/') or path.startswith('//') or any(c in path for c in '\r\n#'):
            raise ValueError('Invalid API path')
        body = b'' if payload is None else json.dumps(payload, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
        headers = signed_headers(self.kind, self.actor_id, self.secret, method, path, body)
        request = urllib.request.Request(self.base_url + path, data=body if payload is not None else None, headers=headers, method=method)
        with self.opener.open(request, timeout=30) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError('Platform response exceeds limit')
            return json.loads(raw)
