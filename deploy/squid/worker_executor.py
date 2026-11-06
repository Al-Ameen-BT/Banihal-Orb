"""Integrate an existing SQUID_BOT executor with the shared host write lock."""
import fcntl
import json
from pathlib import Path
import sqlite3


def execute_command(command, config, apply_existing_command):
    """Callback uses the installed bot's existing validation/apply/rollback logic."""
    if (not isinstance(command.get('id'), str) or not 1 <= len(command['id']) <= 64
            or command.get('type') not in {'allow', 'deny', 'extend', 'full-net', 'lock-net'}):
        raise ValueError('Invalid command')
    state_dir = Path(config['state_dir'])
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(state_dir / 'writer.lock', 'a', encoding='ascii') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (state_dir / 'overload-paused').exists():
            raise RuntimeError('Local automation is paused')
        with sqlite3.connect(state_dir / 'commands.sqlite') as ledger:
            ledger.execute('CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL)')
            payload = json.dumps(command, sort_keys=True, separators=(',', ':'))
            previous = ledger.execute('SELECT payload, state FROM commands WHERE id = ?', (command['id'],)).fetchone()
            if previous:
                if previous[0] != payload:
                    raise ValueError('Command identity reused with different content')
                if previous[1] == 'applied':
                    return {'ok': True, 'duplicate': True}
                # A crash may have occurred after the external side effect. Do not guess/reapply.
                raise RuntimeError('Interrupted command requires operator reconciliation')
            ledger.execute('INSERT INTO commands VALUES (?, ?, ?)', (command['id'], payload, 'applying'))
            ledger.commit()
            try:
                result = apply_existing_command(command)
                if result is False or (isinstance(result, dict) and result.get('ok') is False):
                    raise RuntimeError('Installed executor reported failure')
            except BaseException:
                (state_dir / 'overload-paused').touch(mode=0o600)
                raise
            ledger.execute("UPDATE commands SET state = 'applied' WHERE id = ?", (command['id'],))
            ledger.commit()
    return {'ok': True, 'duplicate': False}
