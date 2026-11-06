#!/usr/bin/env python3
"""Poll platform, apply through the WebUI-owned local writer, acknowledge durably."""
import argparse
import fcntl
import importlib
import json
import logging
import os
from pathlib import Path
import random
import shutil
import stat
import time
from machine_client import MachineClient


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with open(temporary, 'w', encoding='utf-8') as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def overloaded(config):
    load = os.getloadavg()[0] / max(os.cpu_count() or 1, 1)
    memory = {}
    with open('/proc/meminfo', encoding='ascii') as source:
        for line in source:
            name, value, *_rest = line.split()
            if name in ('MemTotal:', 'MemAvailable:'):
                memory[name] = int(value)
    used_memory = 1 - memory['MemAvailable:'] / memory['MemTotal:']
    disk = shutil.disk_usage(config['state_dir'])
    return (load >= config.get('max_load_per_cpu', 0.85) or used_memory >= config.get('max_memory_fraction', 0.9)
            or disk.used / disk.total >= config.get('max_disk_fraction', 0.9))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='/etc/squid-agent/config.json')
    args = parser.parse_args()
    config_path = Path(args.config)
    if stat.S_IMODE(config_path.stat().st_mode) & 0o077:
        raise RuntimeError('Agent config containing credentials must have mode 0600')
    config = json.loads(config_path.read_text())
    state_dir = Path(config['state_dir'])
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if stat.S_IMODE(state_dir.stat().st_mode) & 0o077:
        raise RuntimeError('Agent state directory must have mode 0700')
    if stat.S_IMODE(Path(config['key_file']).stat().st_mode) & 0o077:
        raise RuntimeError('Client private key must have mode 0600')
    transport_lock = open(state_dir / 'agent.lock', 'a', encoding='ascii')
    fcntl.flock(transport_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    ack_path = state_dir / 'pending-result.json'
    pause_path = state_dir / 'overload-paused'
    client = MachineClient(config['platform_origin'], 'proxy', config['proxy_id'], config['secret'], config['ca_file'], config['cert_file'], config['key_file'])
    # The WebUI integration owns the configuration writer; the transport never writes ACLs.
    apply_bundle = importlib.import_module('platform_writer').apply_bundle
    backoff = 5
    while True:
        try:
            if ack_path.exists():
                client.request('POST', '/api/proxy-agent/result', json.loads(ack_path.read_text()))
                ack_path.unlink()
            if overloaded(config):
                pause_path.touch(mode=0o600, exist_ok=True)
            state = client.request('GET', '/api/proxy-agent/poll')
            if state.get('pending') and not pause_path.exists():
                bundle = state['pending']
                try:
                    apply_bundle(bundle, config)
                    result = {'seq': bundle['seq'], 'ok': True}
                except Exception:
                    # Details remain local; avoid sending command/file content or secrets.
                    logging.exception('Local configuration apply failed')
                    result = {'seq': bundle['seq'], 'ok': False, 'error': 'Local validation/apply failed; inspect host journal'}
                atomic_json(ack_path, result)
            backoff = 5
            time.sleep(30 + random.uniform(0, 5))
        except Exception:
            logging.error('Platform request unavailable; preserving running Squid configuration')
            time.sleep(backoff + random.uniform(0, 5))
            backoff = min(backoff * 2, 300)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    main()
