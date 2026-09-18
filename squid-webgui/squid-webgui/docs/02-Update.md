# BT Proxy — Update Guide

**Version 1.12.10** · Banihal Technologies LLP

---

## The golden rule

**Never extract an update zip over `/opt/squid-webgui` with a plain `unzip -o`.**
Always exclude the config and data files, or use the GUI updater.

Files that must be preserved:

| File / folder | Contains |
|---|---|
| `config.py` | Port, paths, SSL fallback |
| `gunicorn_conf.py` | Web server settings |
| `branches.json` | Rules, access lists, sources, modes |
| `network.json` | Network rules |
| `settings.json` | Branding, AD, SMTP, HTTPS, schedules |
| `squidui.db` | Users, MFA, audit log |
| `secret.key` | Decrypts the AD and SMTP passwords |
| `certs/` | SSL certificate and key |
| `deplists/` | Imported dependency-finder lists |
| `backups/` | Configuration backups |

## Method A — GUI update (preferred)

For a `.btpkg` release that adds no dependency: log in as admin →
**Software Update** → upload the `.btpkg` → **Check package** → **Apply**. The
signature is verified, files are backed up, applied, and the service restarts.
Configuration and data are never touched.

## Method B — Manual update (safe procedure)

### B1. Back up first — from the GUI

**Backup & Restore → Create backup now → Download.** Keep it off-server. This is
faster and more complete than copying files by hand, and it is the same archive
the restore function accepts.

Or from the CLI:

```bash
btp backup "before update to 1.12.0"
btp backup-list
```

### B2. Copy and stop

```bash
scp squid-webgui.zip <user>@<server-ip>:/tmp/
sudo systemctl stop squid-webgui
```

### B3. File-level safety copy (belt and braces)

```bash
TS=$(date +%Y%m%d_%H%M%S)
sudo mkdir -p /opt/btproxy-backups/$TS
sudo cp -a /opt/squid-webgui/{config.py,gunicorn_conf.py,branches.json,network.json,settings.json,squidui.db,secret.key} /opt/btproxy-backups/$TS/ 2>/dev/null
sudo cp -a /opt/squid-webgui/certs /opt/squid-webgui/deplists /opt/btproxy-backups/$TS/ 2>/dev/null
ls -la /opt/btproxy-backups/$TS
```

### B4. Extract, EXCLUDING config and data

Put all exclusion patterns after a **single** `-x` — repeating `-x` per file
does not work:

```bash
cd /tmp
sudo unzip -o squid-webgui.zip -d /opt/ -x "squid-webgui/config.py" "squid-webgui/gunicorn_conf.py" "squid-webgui/branches.json" "squid-webgui/network.json" "squid-webgui/settings.json" "squid-webgui/squidui.db" "squid-webgui/secret.key" "squid-webgui/certs/*" "squid-webgui/deplists/*" "squid-webgui/backups/*"
```

Remove OS metadata if the zip carried any:

```bash
sudo rm -rf /opt/__MACOSX && sudo find /opt/squid-webgui -name '._*' -delete
```

### B5. Dependencies (only if the release notes say so)

```bash
cd /opt/squid-webgui && sudo ./venv/bin/pip install -r requirements.txt
```

### B6. Helpers and ownership

```bash
cd /opt/squid-webgui
sudo cp deploy/sudoers-squidui /etc/sudoers.d/squidui && sudo chmod 440 /etc/sudoers.d/squidui
sudo visudo -cf /etc/sudoers.d/squidui
sudo chown -R squidui:squidui /opt/squid-webgui
```

### B7. Start and verify

```bash
sudo systemctl reset-failed squid-webgui
sudo systemctl start squid-webgui
sleep 4
sudo systemctl status squid-webgui --no-pager
```

Verify: all rules present, users intact, sidebar shows the new version. Click
**Reload Squid**. Confirm the Squid include is still correct:

```bash
sudo squid -k parse 2>&1 | grep -nE "webgui_generated|deny all"
```

### B8. Rollback

Restore the backup from B1 via **Backup & Restore → Check backup → Restore**, or
from files:

```bash
sudo systemctl stop squid-webgui
TS=<timestamp from B3>
sudo cp -a /opt/btproxy-backups/$TS/{branches.json,network.json,settings.json,squidui.db,secret.key} /opt/squid-webgui/ 2>/dev/null
sudo cp -a /opt/btproxy-backups/$TS/certs /opt/btproxy-backups/$TS/deplists /opt/squid-webgui/ 2>/dev/null
sudo chown -R squidui:squidui /opt/squid-webgui
sudo systemctl start squid-webgui
```

## Updating Squid itself

GUI → **Software Update → Squid proxy package → Check → Upgrade Squid**. Only
the squid package is upgraded; your ACLs are untouched and re-parsed.

## Startup troubleshooting

```bash
sudo journalctl -u squid-webgui -n 30 --no-pager
```

| Message | Fix |
|---|---|
| `ModuleNotFoundError` | Missed B5 — `sudo ./venv/bin/pip install -r requirements.txt` |
| `Not a string: <module 'config'>` | `gunicorn_conf.py` naming clash — `sudo sed -i 's/^import config$/import config as _cfg/; s/\bconfig\./_cfg./g' /opt/squid-webgui/gunicorn_conf.py` |
| `SSL_ENABLED is True but cert/key not found` | `btp ssl-off` then restart |
| `sudo: I'm afraid I can't do that` on restart | Sudoers outdated — redo B6 |

---

© Banihal Technologies LLP — BT Proxy v1.12.10
