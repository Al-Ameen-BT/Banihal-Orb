"""
BT Proxy - lightweight background scheduler.

Runs inside the app process on a daemon thread. Used for:
  * scheduled configuration backups (and emailing them, if enabled)
  * daily certificate / license expiry alerts

Deliberately simple: it wakes once a minute, checks whether a job's scheduled
time has passed for today (or the configured weekday/day-of-month), and runs it
at most once per period. State is kept in a small JSON file so a restart does
not re-run or skip a job.

Under gunicorn there are multiple workers; only ONE must run the scheduler, so
a lock file with the owning PID is used - the first worker to claim it runs the
jobs, and it is re-claimed if that worker dies.
"""
import json
import os
import threading
import time
from datetime import datetime

import config

STATE_FILE = os.path.join(config.BASE_DIR, "scheduler_state.json")
LOCK_FILE = os.path.join(config.BASE_DIR, "scheduler.lock")

DEFAULTS = {
    "backup_schedule": "off",     # off | daily | weekly | monthly
    "backup_time": "02:00",       # HH:MM (server local time)
    "backup_weekday": 0,          # 0=Mon .. 6=Sun (weekly)
    "backup_dom": 1,              # 1-28 (monthly)
    "backup_email": False,        # email the archive after creating it
    "backup_keep": 10,            # how many archives to keep on disk
}


def settings_with_defaults(s):
    out = dict(DEFAULTS)
    out.update({k: v for k, v in s.items() if k in DEFAULTS})
    return out


def _load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_state(st):
    try:
        old = os.umask(0o077)
        try:
            with open(STATE_FILE, "w") as f:
                json.dump(st, f)
        finally:
            os.umask(old)
    except OSError:
        pass


def _claim_lock():
    """Return True if this process should run the scheduler."""
    mypid = os.getpid()
    try:
        if os.path.exists(LOCK_FILE):
            with open(LOCK_FILE) as f:
                pid = int((f.read() or "0").strip() or 0)
            if pid and pid != mypid:
                # is that process still alive?
                try:
                    os.kill(pid, 0)
                    return False          # someone else owns it
                except OSError:
                    pass                  # stale lock - take over
        with open(LOCK_FILE, "w") as f:
            f.write(str(mypid))
        return True
    except OSError:
        return False


def _due(cfg, state, now):
    """Is a backup due right now?"""
    sched = cfg.get("backup_schedule", "off")
    if sched == "off":
        return False
    try:
        hh, mm = [int(x) for x in str(cfg.get("backup_time", "02:00")).split(":")]
    except ValueError:
        hh, mm = 2, 0
    if (now.hour, now.minute) < (hh, mm):
        return False
    if sched == "weekly" and now.weekday() != int(cfg.get("backup_weekday", 0)):
        return False
    if sched == "monthly" and now.day != int(cfg.get("backup_dom", 1)):
        return False
    # run at most once per calendar day
    return state.get("last_backup_date") != now.strftime("%Y-%m-%d")


def start(app, load_settings, run_backup_job, run_daily_checks,
          run_dr_sync=None):
    """Start the scheduler thread. Callables are injected so this module has no
    dependency on the app internals (keeps it testable).

    run_dr_sync (optional): called on a short cadence to push the current config
    to the DR peer as a safety net, so a change that failed to land while the
    peer was briefly down is caught. It self-checks whether DR is enabled and
    whether this node should push, so calling it when DR is off is harmless."""
    def loop():
        # let the app finish booting before claiming anything
        time.sleep(20)
        owner = False
        last_dr = 0
        while True:
            try:
                if not owner:
                    owner = _claim_lock()
                if owner:
                    now = datetime.now()
                    st = _load_state()
                    cfg = settings_with_defaults(load_settings())

                    if _due(cfg, st, now):
                        try:
                            run_backup_job(cfg)
                        except Exception:
                            pass
                        st["last_backup_date"] = now.strftime("%Y-%m-%d")
                        _save_state(st)

                    # once-a-day housekeeping alerts
                    if st.get("last_checks_date") != now.strftime("%Y-%m-%d") \
                            and now.hour >= 8:
                        try:
                            run_daily_checks()
                        except Exception:
                            pass
                        st["last_checks_date"] = now.strftime("%Y-%m-%d")
                        _save_state(st)

                    # DR periodic safety sync (only the lock owner runs it, so a
                    # bundle is never pushed twice by parallel workers)
                    if run_dr_sync:
                        interval = int(cfg.get("dr_sync_interval", 300) or 300)
                        if time.time() - last_dr >= max(60, interval):
                            try:
                                run_dr_sync()
                            except Exception:
                                pass
                            last_dr = time.time()
            except Exception:
                pass
            time.sleep(60)

    t = threading.Thread(target=loop, daemon=True, name="btproxy-scheduler")
    t.start()
    return t
