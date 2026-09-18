"""
BT Proxy - Dependency Finder (security-first, advisory only).

Given an operator-supplied URL, fetch the page with a sandboxed, SSRF-protected,
GET-only static request and extract the external domains it references
(scripts, stylesheets, images, fonts, iframes, links, preconnect hints).

DESIGN PRINCIPLES (do not weaken):
  * ADVISORY ONLY. This module never writes an ACL or allows anything. It
    returns a list of domains for a human to individually approve.
  * NO CODE EXECUTION. Static HTML parse only - the target site's JavaScript
    is never run. No headless browser, no eval, no redir(redirects to private
    ranges are refused).
  * SSRF-HARDENED. Only public http/https hosts may be fetched. Private,
    loopback, link-local, and reserved IP ranges are refused BEFORE connecting,
    and again after DNS resolution, and again on every redirect hop.
  * BOUNDED. Hard timeout, response size cap, redirect cap.

The classification (CDN / Microsoft / telemetry / unknown) is done by the
caller against locally-imported lists; this module only discovers domains.
"""
import ipaddress
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import urllib.request

MAX_BYTES = 3 * 1024 * 1024        # 3 MB response cap
TIMEOUT = 10                       # seconds
MAX_REDIRECTS = 8         # login-gated sites (Gmail, O365) chain several hops;
                          # every hop is still SSRF-revalidated before we follow it
USER_AGENT = "BTProxy-DependencyFinder/1.0 (+security-scan; static)"

# HTML places that reference an external domain
URL_ATTRS = {
    "script": ["src"],
    "link": ["href"],
    "img": ["src", "data-src"],
    "iframe": ["src"],
    "source": ["src", "srcset"],
    "video": ["src", "poster"],
    "audio": ["src"],
    "embed": ["src"],
    "object": ["data"],
    "form": ["action"],
    "a": ["href"],
}


class BadURLError(Exception):
    pass


def _is_public_ip(ip_str):
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return not (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified)


def _resolve_all_public(host):
    """Resolve host; every resolved address must be public, or refuse.
    Returns the list of resolved IPs (so we can pin/verify)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise BadURLError(f"Could not resolve host '{host}': {e}")
    ips = {info[4][0] for info in infos}
    if not ips:
        raise BadURLError(f"Host '{host}' did not resolve.")
    for ip in ips:
        if not _is_public_ip(ip):
            raise BadURLError(
                f"Refusing to fetch '{host}': it resolves to a non-public "
                f"address ({ip}). Only public internet sites can be scanned.")
    return ips


def validate_url(raw):
    """Validate scheme/host and confirm it resolves to public IPs only.
    Returns (normalized_url, host). Raises BadURLError on anything unsafe."""
    raw = (raw or "").strip()
    if not raw:
        raise BadURLError("Enter a URL.")
    if "://" not in raw:
        raw = "https://" + raw
    p = urlparse(raw)
    if p.scheme not in ("http", "https"):
        raise BadURLError("Only http:// and https:// URLs are allowed.")
    if not p.hostname:
        raise BadURLError("URL has no hostname.")
    host = p.hostname
    # reject raw IP literals that are private; also reject obvious internal names
    try:
        ip = ipaddress.ip_address(host)
        if not _is_public_ip(str(ip)):
            raise BadURLError(
                f"Refusing to fetch a private/loopback address ({host}).")
    except ValueError:
        pass  # it's a hostname, resolved below
    _resolve_all_public(host)
    return raw, host


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Capture redirects instead of following blindly, so each hop can be
    re-validated for SSRF before we chase it."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _Redirect(newurl)


class _Redirect(Exception):
    def __init__(self, url):
        self.url = url


def _fetch_once(url):
    """Single GET with caps. Returns (final_html_text, content_type).
    Raises BadURLError / urllib errors."""
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
    }, method="GET")
    opener = urllib.request.build_opener(_NoRedirect)
    with opener.open(req, timeout=TIMEOUT) as resp:
        ctype = resp.headers.get("Content-Type", "")
        # only parse HTML; other content types yield no useful dependency info
        data = resp.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        data = data[:MAX_BYTES]
    charset = "utf-8"
    if "charset=" in ctype:
        charset = ctype.split("charset=", 1)[1].split(";")[0].strip() or "utf-8"
    try:
        text = data.decode(charset, errors="replace")
    except LookupError:
        text = data.decode("utf-8", errors="replace")
    return text, ctype


def fetch(url):
    """SSRF-safe fetch following at most MAX_REDIRECTS hops, re-validating
    each hop. Returns (final_url, html_text, content_type, hop_hosts)."""
    current, _ = validate_url(url)
    hop_hosts = []
    for _ in range(MAX_REDIRECTS + 1):
        try:
            text, ctype = _fetch_once(current)
            return current, text, ctype, hop_hosts
        except _Redirect as r:
            nxt = urljoin(current, r.url)
            h = urlparse(nxt).hostname
            if h:
                hop_hosts.append(h.lower())
            current, _ = validate_url(nxt)   # re-validate every redirect target
    # exhausted the hop budget - tell the operator where it was heading
    final_host = ""
    try:
        final_host = urlparse(current).hostname or ""
    except ValueError:
        pass
    raise BadURLError(
        f"This site redirects more than {MAX_REDIRECTS} times "
        f"(it was heading to '{final_host}'). This usually means it needs a "
        f"login before the real page loads, so its dependencies can't be read "
        f"from the public entry page. Try the specific page you actually want "
        f"to whitelist (for example the login domain '{final_host}' directly), "
        f"or add the known domains manually.")


class _LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        wanted = URL_ATTRS.get(tag)
        if not wanted:
            return
        d = dict(attrs)
        for a in wanted:
            v = d.get(a)
            if not v:
                continue
            if a == "srcset":
                # "url1 1x, url2 2x" -> take the URLs
                for part in v.split(","):
                    u = part.strip().split(" ")[0]
                    if u:
                        self.urls.append(u)
            else:
                self.urls.append(v)
        # <link rel="preconnect"|"dns-prefetch" href="//domain">
        if tag == "link" and d.get("href") and (
                "preconnect" in (d.get("rel") or "") or
                "dns-prefetch" in (d.get("rel") or "")):
            self.urls.append(d["href"])


def extract_domains(base_url, html_text):
    """Return a sorted list of (domain, is_third_party, sample_kinds) from the
    page. is_third_party is True when the domain's registrable-ish root differs
    from the base host."""
    parser = _LinkParser()
    try:
        parser.feed(html_text)
    except Exception:
        pass

    base_host = urlparse(base_url).hostname or ""
    base_root = _root(base_host)

    found = {}
    for raw in parser.urls:
        raw = raw.strip()
        if not raw or raw.startswith(("data:", "javascript:", "mailto:",
                                      "tel:", "#", "blob:")):
            continue
        # handle protocol-relative //host/...
        if raw.startswith("//"):
            raw = "https:" + raw
        try:
            host = urlparse(urljoin(base_url, raw)).hostname
        except ValueError:
            host = None
        if not host:
            continue
        host = host.lower()
        entry = found.setdefault(host, {"third_party": _root(host) != base_root,
                                        "count": 0})
        entry["count"] += 1

    out = []
    for host, meta in sorted(found.items()):
        out.append({
            "domain": host,
            "third_party": meta["third_party"],
            "count": meta["count"],
        })
    return out, base_host


def _root(host):
    """Rough registrable-root: last two labels (or three for known 2-level
    ccTLD suffixes). Good enough to separate first-party from third-party."""
    if not host:
        return ""
    parts = host.split(".")
    if len(parts) <= 2:
        return host
    two_level = {"co.uk", "co.in", "org.uk", "gov.in", "ac.in", "com.au",
                 "co.jp", "org.in", "net.in", "co.za"}
    last2 = ".".join(parts[-2:])
    if last2 in two_level:
        return ".".join(parts[-3:])
    return last2


def find(url):
    """Top-level entry: fetch + extract. Returns dict with results or error.
    Never raises to the caller for expected problems - returns {'error': ...}."""
    try:
        typed_host = urlparse(
            url if "://" in url else "https://" + url).hostname
    except ValueError:
        typed_host = None
    try:
        final_url, html_text, ctype, hop_hosts = fetch(url)
    except BadURLError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"Could not fetch the page: {e}"}
    if "html" not in ctype.lower():
        return {"ok": False,
                "error": f"That URL returned '{ctype or 'unknown content'}', "
                         f"not an HTML page - nothing to scan."}
    domains, base_host = extract_domains(final_url, html_text)

    # Add the domains the browser MUST reach for the site itself: the address
    # the operator typed, and every host in the redirect chain (e.g. gmail.com
    # -> mail.google.com -> accounts.google.com). These are real dependencies
    # even though they aren't "referenced" resources in the final HTML.
    seen = {d["domain"] for d in domains}
    chain = []
    for h in ([typed_host] + hop_hosts + [base_host]):
        if h and h.lower() not in seen:
            seen.add(h.lower())
            chain.append(h.lower())
    base_root = _root(base_host)
    for h in chain:
        domains.append({"domain": h, "third_party": _root(h) != base_root,
                        "count": 1, "site_itself": True})

    return {"ok": True, "final_url": final_url, "base_host": base_host,
            "domains": domains, "count": len(domains)}
