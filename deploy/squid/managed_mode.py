"""Read-only human WebUI while the platform owns managed Squid policy."""
import os
from flask import jsonify, request


def enabled():
    return os.environ.get('PLATFORM_MANAGED') == 'true'


def install(app):
    def managed_write_guard():
        if not enabled() or request.method in ('GET', 'HEAD', 'OPTIONS'):
            return None
        if request.endpoint in {'login', 'logout', 'do_logout', 'mfa', 'mfa_setup', 'password'}:
            return None
        return jsonify(error='Policy is platform-managed. Submit a change ticket in the BanihalOrb application.',
                       code='PLATFORM_MANAGED'), 423
    # Guard even legacy API/DR routes before their existing CSRF/session exemptions.
    app.before_request_funcs.setdefault(None, []).insert(0, managed_write_guard)
