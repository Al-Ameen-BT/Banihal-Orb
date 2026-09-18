"""
Squid Web GUI - configuration
Edit the paths below to match your server. Defaults work for both
Rocky Linux (dnf install squid) and Ubuntu (apt install squid).
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- Squid paths
SQUID_CONF   = "/etc/squid/squid.conf"
ACCESS_LOG   = "/var/log/squid/access.log"

# Directory where per-branch ACL files live. The app creates files here
# named <branch>_whitelist.txt / <branch>_blacklist.txt
ACL_DIR      = "/etc/squid/acls"

# The single file the GUI generates with all port ACLs, full-access rules and
# branch rules. squid.conf needs ONE line, placed just above "http_access deny all":
#     include /etc/squid/acls/webgui_generated.conf
GEN_CONF     = os.path.join(ACL_DIR, "webgui_generated.conf")

# Port ACLs + full-access entries are stored here (JSON, managed by the GUI)
NETWORK_MAP  = os.path.join(BASE_DIR, "network.json")

# Squid binary (same path on Rocky & Ubuntu when installed from packages)
SQUID_BIN    = "/usr/sbin/squid"

# Commands the app runs through sudo (see deploy/sudoers-squidui)
RECONFIGURE_CMD = ["sudo", "-n", SQUID_BIN, "-k", "reconfigure"]
PARSE_CMD       = ["sudo", "-n", SQUID_BIN, "-k", "parse"]
# systemctl restart BLOCKS until the unit finishes starting. Squid's default
# shutdown_lifetime is 30s, so a blocking restart routinely exceeds any short
# timeout. --no-block queues the job and returns immediately; the GUI then
# polls "systemctl is-active" to report the result.
RESTART_CMD     = ["sudo", "-n", "/usr/bin/systemctl", "--no-block", "restart", "squid"]
SELF_RESTART_CMD = ["sudo", "-n", "/usr/bin/systemctl", "--no-block",
                    "restart", "squid-webgui"]
IS_ACTIVE_CMD   = ["systemctl", "is-active", "squid"]

# Seconds to wait for a squid command (parse/reconfigure) to finish
SQUID_CMD_TIMEOUT = 60
# Seconds to wait for squid to come back active after a restart
RESTART_WAIT = 45

# Squid package update helper (root-owned wrapper, see deploy/btproxy-squid-update)
SQUID_PKG_HELPER = "/usr/local/sbin/btproxy-squid-update"
SQUID_PKG_CHECK  = ["sudo", "-n", SQUID_PKG_HELPER, "check"]
SQUID_PKG_APPLY  = ["sudo", "-n", SQUID_PKG_HELPER, "apply"]

# Automatically run "squid -k reconfigure" after every whitelist/blacklist
# change. If False, changes are saved to the ACL files and an "Apply" button
# appears in the UI.
AUTO_RECONFIGURE = False

# ------------------------------------------------------- Cache manager access
# Used for the live "concurrent sessions" view. Requires squid.conf to allow:
#     http_access allow localhost manager
CACHEMGR_URL = "http://127.0.0.1:3128/squid-internal-mgr/active_requests"
CACHEMGR_TIMEOUT = 4  # seconds

# If cache manager is unreachable the app falls back to grouping recent
# access.log entries. A client seen within this window counts as "active".
SESSION_FALLBACK_WINDOW = 120  # seconds

# ------------------------------------------------------------------- App/auth
DB_PATH    = os.path.join(BASE_DIR, "squidui.db")
BRANCH_MAP = os.path.join(BASE_DIR, "branches.json")

# Change this to a long random string in production!
SECRET_KEY = os.environ.get("SQUIDUI_SECRET", "change-me-to-a-long-random-string")

SESSION_HOURS = 8          # GUI login lifetime (absolute)
IDLE_TIMEOUT_MIN = 30      # auto-logout after this many minutes of inactivity
LOGIN_MAX_FAILS = 5        # failed logins before temporary lockout
LOGIN_LOCK_MIN  = 15       # lockout duration in minutes
LOG_MAX_LINES = 5000       # how far back the log viewer reads
LOG_PAGE_SIZE = 200        # lines shown per page/refresh

# First-run default admin account (forced password change on first login)
DEFAULT_ADMIN_USER = "admin"
DEFAULT_ADMIN_PASS = "admin@123"

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 8800          # <- change the web GUI port here

# ------------------------------------------------------------------ HTTPS/SSL
# Set SSL_ENABLED = True and point to your certificate + key to serve HTTPS.
# For a self-signed cert see the "SSL" section in README.md.
SSL_ENABLED = False
SSL_CERT    = os.path.join(BASE_DIR, "certs", "server.crt")
SSL_KEY     = os.path.join(BASE_DIR, "certs", "server.key")

# --------------------------------------------------------------------- Branding
# Drop your company logo at static/logo.png (PNG/SVG, ~200px wide works best).
# It appears on the login screen and sidebar automatically if the file exists.
LOGO_FILE   = "logo.png"     # relative to the static/ folder
# Version is read from the VERSION file, which update packages DO replace
# (config.py is deliberately never overwritten by an update).
def _read_version():
    try:
        with open(os.path.join(BASE_DIR, "VERSION")) as f:
            return f.read().strip() or "0.0.0"
    except OSError:
        return "0.0.0"


APP_VERSION = _read_version()
APP_TITLE   = "BT PROXY"          # defaults; can be changed in GUI Settings
APP_SUBTITLE = "proxy control panel"
SETTINGS_FILE = os.path.join(BASE_DIR, "settings.json")
DEPLIST_DIR   = os.path.join(BASE_DIR, "deplists")  # dependency-finder category lists
