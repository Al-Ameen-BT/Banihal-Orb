# H1: Token file move — `.env` → `/etc/squid-bot/env` (0600)

## Why
The bot's identity (`wrk_` key) and its optional AES-256-GCM wrapper (`PLATFORM_MASTER_SECRET`) must live outside the repo `.env` so they are:
- **Never committed** to version control (secret at rest)
- **Mode 0600** (owner-only read) to satisfy the host kernel `no_new_privs` flag
- **Separate from app `.env`** (which is for app config, not cryptographic keys)

## What moves to `/etc/squid-bot/env`

| Variable | Description | Example |
|----------|-------------|---------|
| `SLACK_BOT_TOKEN` | Bot token (xoxb-…) | `xoxb-1234567890-abcdefgh` |
| `SLACK_APP_TOKEN` | App token (xapp-…) | `xapp-abc123` |
| `SLACK_ALERT_CHANNEL` | Crash/recovery alerts channel ID | `C0123456789` |
| `PLATFORM_BASE_URL` | Platform outbound URL | `https://platform.example.com` |
| `PLATFORM_BOT_ID` | Bot's Slack ID | `B12345678` |
| `SQUID_BOT_KEY_FILE` | Path to worker key (overrides default `/etc/squid-bot/key`) | `/etc/squid-bot/custom.key` |
| `PLATFORM_MASTER_SECRET` | Optional: SHA-256-derived key for unwrapping encrypted key files | `my-super-secret-master-phrase` |

**Note:** `SQUID_BOT_KEY_FILE` and `PLATFORM_MASTER_SECRET` are optional. If `SQUID_BOT_KEY_FILE` is omitted, the default `/etc/squid-bot/key` is used. If `PLATFORM_MASTER_SECRET` is omitted, the key file must be plaintext `wrk_…`.

## Migration steps (run as root on the host)

```bash
# 1. Create the directory (mode 700)
sudo mkdir -p /etc/squid-bot
sudo chmod 700 /etc/squid-bot

# 2. Copy the repo .env (or the squid repo's .env.example) into it
sudo cp /path/to/repo/.env /etc/squid-bot/env
# Or, if the repo has no .env, copy from the squid bundle:
sudo cp /path/to/squid/squid-bot/.env.example /etc/squid-bot/env

# 3. Lock down permissions
sudo chmod 600 /etc/squid-bot/env
sudo chown root:root /etc/squid-bot/env

# 3a. (Optional) Lock down the key file too
sudo chmod 600 /etc/squid-bot/key   # if using default key location

# 4. Verify the key ring can read it (Python, needs 'cryptography')
pip install cryptography  # if not already installed
python3 -c "
from platform_client.keyring import load_worker_key
key = load_worker_key()
print(f'Key loaded: {key[:8]}...')
"

# 5. Update any CI/CD or deployment scripts to reference /etc/squid-bot/env
#    instead of the old repo-level .env path.

echo "H1 complete — token files are now outside the repo and locked to 0600."
```

## Rollback

If something breaks, restore from the backup:

```bash
sudo cp /etc/squid-bot/env.bak.$YEAR$MONTH$DAY /etc/squid-bot/env
sudo chmod 600 /etc/squid-bot/env
```

Or restore the repo-level `.env` if that was the original source:

```bash
sudo cp /etc/squid-bot/env /path/to/repo/.env
```
