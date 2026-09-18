# BT Proxy — Update Package Creation Guide

**Version 1.12.10** · Banihal Technologies LLP
**CONFIDENTIAL — Banihal internal. Not for customer distribution.**

Updates are delivered as a single signed `.btpkg` file that customers apply from
**Software Update** in the GUI — no SSH needed. Packages are signed with the same
Ed25519 private key as licenses.

## Prerequisites (office machine)

```bash
unzip squid-webgui.zip -d ~/
cd ~/squid-webgui
pip install cryptography
ls -l deploy/vendor_private_key.hex        # must be present
```

## Building a package

From the new version's source tree:

```bash
echo "1.12.1" > VERSION
python3 deploy/build_update.py \
    --version 1.12.1 \
    --min-version 1.12.0 \
    --notes "What changed in this release" \
    --out /tmp/btproxy-1.12.1.btpkg \
    VERSION app.py templates static
```

| Flag | Meaning |
|---|---|
| `--version` | Version this package installs — must match the VERSION file included |
| `--min-version` | Refuses to apply on older installs — forces updates in order |
| `--notes` | Release notes shown to the customer before Apply |
| `--out` | Output `.btpkg` path |
| *(positional)* | Files/directories to include; directories are recursed |

For a release touching the newer modules, list them explicitly:

```bash
python3 deploy/build_update.py --version 1.12.1 --min-version 1.12.0 \
    --notes "..." --out /tmp/btproxy-1.12.1.btpkg \
    VERSION app.py mailer.py backup_manager.py scheduler.py \
    dep_finder.py dep_classify.py templates static
```

## Rules

- **Always include `VERSION`** and make it match `--version`. The displayed
  version reads from this file (not config.py, which packages never overwrite).
- **Never include** `config.py`, `*.json`, `*.db`, `secret.key`, `certs/`,
  `deplists/`, or `backups/` — these are customer configuration and data. The
  update engine refuses to overwrite them anyway, but they must not be packaged.
- **A `.btpkg` cannot run pip.** If a release adds a dependency, that release
  needs the manual update procedure — the GUI updater cannot install it.
- Test on a lab VM at the customer's current version before sending.
- Keep every shipped `.btpkg` plus its source in a `releases/` archive; the
  `min-version` gate forces customers through intermediate versions in order.

## What the customer's GUI does

1. Verifies the Ed25519 signature — unsigned/altered packages are rejected
   before any file is touched
2. Verifies the payload and per-file hashes
3. Backs up every replaced file
4. Writes the new files (refuses path traversal, skips protected config/data)
5. Rolls back automatically if any write fails
6. Restarts the service (`--no-block`) to load the new code
7. Records the upload, verification, and application in the audit log / syslog

## Building a clean zip (full package)

When shipping the whole application rather than a `.btpkg`:

```bash
cd ~
zip -rqX squid-webgui.zip squid-webgui \
  -x "*__pycache__*" -x "*/secret.key" -x "*/squidui.db" \
  -x "*/settings.json" -x "*/branches.json" -x "*/network.json" \
  -x "*/backups/*" -x "*/certs/*" -x "*/deplists/*" \
  -x "*.DS_Store" -x "*/._*" -x "__MACOSX/*"
```

Verify before sending:

```bash
unzip -l squid-webgui.zip | grep -E "branches.json|squidui.db|secret.key|__MACOSX" \
  && echo "STOP - data or junk in package" || echo "clean"
```

---

© Banihal Technologies LLP — BT Proxy v1.12.10
