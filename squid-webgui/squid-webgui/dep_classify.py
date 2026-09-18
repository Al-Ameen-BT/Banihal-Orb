"""
BT Proxy - domain classification for the Dependency Finder.

Labels are ADVISORY hints to help an operator judge each domain. They never
cause a domain to be allowed - approval is always a manual, per-domain click.

Categories:
  cdn        - known CDN / infrastructure (jsDelivr, Cloudflare, Akamai, fonts)
  provider   - known platform endpoints (Microsoft 365, Google) - bundles
  telemetry  - browser/search/tracking noise (Bing, telemetry, analytics)
  unknown    - not on any imported list -> gets EXTRA scrutiny, never pre-checked

Lists live in config.DEPLIST_DIR as plain text files, one domain per line
('#' comments allowed). A match is exact host or any parent domain suffix, so
'fonts.gstatic.com' matches a 'gstatic.com' entry.

A small built-in seed list ships for the most common cases; operators can
import/extend lists from the GUI. Nothing here contacts the internet.
"""
import os

import config

CATEGORIES = ("telemetry", "cdn", "provider")
DEPLIST_DIR = getattr(config, "DEPLIST_DIR",
                      os.path.join(config.BASE_DIR, "deplists"))

# Minimal built-in seed. Deliberately conservative. Operators extend via import.
SEED = {
    "telemetry": [
        # browser / search noise that is NOT a page dependency
        "bing.com", "www.bing.com", "edge.microsoft.com",
        "config.edge.microsoft.com", "ntp.msn.com", "msn.com",
        "google-analytics.com", "analytics.google.com",
        "googletagmanager.com", "doubleclick.net", "safebrowsing.googleapis.com",
        "incoming.telemetry.mozilla.org", "telemetry.mozilla.org",
        "settings-win.data.microsoft.com", "vortex.data.microsoft.com",
        "watson.telemetry.microsoft.com", "scorecardresearch.com",
        "hotjar.com", "mixpanel.com", "segment.io", "sentry.io",
    ],
    "cdn": [
        "jsdelivr.net", "cdnjs.cloudflare.com", "cloudflare.com",
        "akamaihd.net", "akamai.net", "akamaized.net", "fastly.net",
        "fbcdn.net", "gstatic.com", "fonts.googleapis.com",
        "fonts.gstatic.com", "bootstrapcdn.com", "unpkg.com",
        "cloudfront.net", "jquery.com", "code.jquery.com",
        "ajax.googleapis.com", "cdn.jsdelivr.net", "stackpath.bootstrapcdn.com",
    ],
    "provider": [
        # coarse Microsoft 365 / Google Workspace roots - refine via import
        "office.com", "office365.com", "microsoftonline.com",
        "sharepoint.com", "outlook.com", "microsoft.com",
        "google.com", "googleapis.com", "gstatic.com", "googleusercontent.com",
    ],
}


def _load_list(category):
    """Return a set of domains for a category: seed + imported file."""
    domains = set(SEED.get(category, []))
    path = os.path.join(DEPLIST_DIR, f"{category}.txt")
    if os.path.exists(path):
        try:
            for line in open(path, encoding="utf-8"):
                line = line.strip().lower()
                if line and not line.startswith("#"):
                    domains.add(line)
        except OSError:
            pass
    return domains


def _match(host, domain_set):
    """True if host equals or is a subdomain of any domain in the set."""
    host = host.lower().strip(".")
    parts = host.split(".")
    for i in range(len(parts) - 1):
        candidate = ".".join(parts[i:])
        if candidate in domain_set:
            return True
    return host in domain_set


def classify(host):
    """Return a category string for a host. telemetry wins over cdn/provider
    (we want noise flagged even if it's also on a CDN)."""
    for cat in CATEGORIES:                 # telemetry, cdn, provider
        if _match(host, _load_list(cat)):
            return cat
    return "unknown"


def label_domains(domains):
    """Given finder output (list of {domain, third_party, count}), attach a
    'category' and a 'recommend' hint. Nothing is auto-approved."""
    out = []
    for d in domains:
        cat = classify(d["domain"])
        # security-first: never auto-check. 'recommend' is only a soft hint.
        if cat == "telemetry":
            recommend, note = "avoid", "Browser/search/telemetry - not a site dependency"
        elif cat == "cdn":
            recommend, note = "likely", "Known CDN / infrastructure"
        elif cat == "provider":
            recommend, note = "likely", "Known platform endpoint"
        else:
            recommend, note = "review", "Unknown - review before allowing"
        out.append({**d, "category": cat, "recommend": recommend, "note": note})
    # order: unknowns first (need most scrutiny), then likely, then avoid
    order = {"review": 0, "likely": 1, "avoid": 2}
    out.sort(key=lambda x: (order.get(x["recommend"], 9), not x["third_party"],
                            x["domain"]))
    return out


def list_stats():
    """For the import screen: how many domains in each category (seed+imported)."""
    return {cat: len(_load_list(cat)) for cat in CATEGORIES}


def import_list(category, text):
    """Append domains from pasted/uploaded text to a category list file.
    Returns (added_count, total_count). Ignores dupes and comments."""
    if category not in CATEGORIES:
        raise ValueError("Unknown category")
    os.makedirs(DEPLIST_DIR, exist_ok=True)
    existing = _load_list(category)
    new = []
    for line in text.splitlines():
        line = line.strip().lower()
        if line and not line.startswith("#") and line not in existing:
            # basic sanity: looks like a domain
            if "." in line and " " not in line and "/" not in line:
                new.append(line)
                existing.add(line)
    path = os.path.join(DEPLIST_DIR, f"{category}.txt")
    with open(path, "a", encoding="utf-8") as f:
        for d in new:
            f.write(d + "\n")
    return len(new), len(existing)
