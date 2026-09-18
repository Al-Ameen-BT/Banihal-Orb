#!/usr/bin/env python3
"""
Import an existing squid.conf into the Squid Web GUI.

Reads the classic hand-maintained pattern:

    acl NAME src <subnet-or-ip> ...
    acl NAMESITE dstdomain "/etc/squid/Some-sites.acl"
    http_access allow NAME NAMESITE
    http_access deny  NAME            <- optional (= whitelist-only mode)

plus bare full-access rules:

    acl it src 172.20.99.10/32
    http_access allow it

plus extra "acl Safe_ports/SSL_ports port N" beyond squid defaults.

Groups that share the SAME dstdomain file are merged into ONE GUI branch
with all their subnets combined as sources (edit once, applies to all).

Usage:
    python3 import_squid_conf.py /path/to/squid.conf [--acl-src-dir DIR] [--apply]

Without --apply it only prints what it WOULD do (dry run).
With --apply it copies the .acl files into ACL_DIR, writes branches.json
and network.json, and regenerates the include file.
"""
import argparse
import json
import os
import re
import shutil
import sys
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

DEFAULT_SAFE = {"80", "21", "443", "70", "210", "1025-65535", "280", "488", "591", "777"}
DEFAULT_SSL = {"443"}

ACL_SRC = re.compile(r"^acl\s+(\S+)\s+src\s+(.+?)\s*(?:#.*)?$")
ACL_DOM = re.compile(r'^acl\s+(\S+)\s+dstdomain\s+"([^"]+)"')
ACL_PORT = re.compile(r"^acl\s+(Safe_ports|SSL_ports)\s+port\s+(\S+)")
HTTP_ACCESS = re.compile(r"^http_access\s+(allow|deny)\s+(.+?)\s*(?:#.*)?$")
SKIP_SRC_NAMES = {"localnet", "localhost", "to_localhost", "to_linklocal", "all"}


def parse(conf_path):
    src_acls, dom_acls, rules = {}, {}, []
    extra_ports = {"safe_ports": [], "ssl_ports": []}
    for raw in open(conf_path):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = ACL_PORT.match(line)
        if m:
            which, val = m.groups()
            if which == "Safe_ports" and val not in DEFAULT_SAFE:
                extra_ports["safe_ports"].append(val)
            if which == "SSL_ports" and val not in DEFAULT_SSL:
                extra_ports["ssl_ports"].append(val)
            continue
        m = ACL_SRC.match(line)
        if m and m.group(1) not in SKIP_SRC_NAMES:
            src_acls.setdefault(m.group(1), []).extend(m.group(2).split())
            continue
        m = ACL_DOM.match(line)
        if m:
            dom_acls[m.group(1)] = m.group(2)
            continue
        m = HTTP_ACCESS.match(line)
        if m:
            rules.append((m.group(1), m.group(2).split()))
    return src_acls, dom_acls, rules, extra_ports


def build(src_acls, dom_acls, rules):
    """Walk http_access rules and reconstruct groups + full-access hosts."""
    groups = OrderedDict()      # dstdomain-file -> {sources, wl_only, names}
    full_access = []
    allowed_pairs = []          # (src_name, dom_name) in rule order
    for verb, args in rules:
        args = [a for a in args if a != "!"]
        if verb == "allow" and len(args) == 2 and args[0] in src_acls and args[1] in dom_acls:
            allowed_pairs.append((args[0], args[1]))
        elif verb == "allow" and len(args) == 1 and args[0] in src_acls:
            full_access.append(args[0])
    denied_srcs = {args[0] for verb, args in rules
                   if verb == "deny" and len(args) == 1 and args[0] in src_acls}

    for src_name, dom_name in allowed_pairs:
        f = dom_acls[dom_name]
        g = groups.setdefault(f, {"sources": [], "wl_only": False, "names": []})
        for s in src_acls[src_name]:
            if s not in g["sources"]:
                g["sources"].append(s)
        g["names"].append(src_name)
        if src_name in denied_srcs:
            g["wl_only"] = True
    return groups, full_access


def branch_display_name(acl_file, names):
    base = os.path.basename(acl_file)
    base = re.sub(r"[-_]?sites?\.acl$|\.acl$|\.txt$", "", base, flags=re.I)
    base = re.sub(r"[^A-Za-z0-9_-]", "_", base) or "_".join(names[:1])
    return base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("squid_conf")
    ap.add_argument("--acl-src-dir", default=None,
                    help="Where the referenced .acl files are (default: same paths as in squid.conf)")
    ap.add_argument("--apply", action="store_true", help="Write files (otherwise dry run)")
    args = ap.parse_args()

    src_acls, dom_acls, rules, extra_ports = parse(args.squid_conf)
    groups, fa_names = build(src_acls, dom_acls, rules)

    branches = OrderedDict()
    warnings = []
    for acl_file, g in groups.items():
        name = branch_display_name(acl_file, g["names"])
        i = 2
        while name in branches:
            name = f"{name}_{i}"; i += 1
        src_file = acl_file
        if args.acl_src_dir:
            src_file = os.path.join(args.acl_src_dir, os.path.basename(acl_file))
        if not os.path.exists(src_file):
            warnings.append(f"MISSING FILE: {src_file} (branch {name} gets an empty whitelist)")
        wl = os.path.join(config.ACL_DIR, f"{name.lower()}_whitelist.txt")
        bl = os.path.join(config.ACL_DIR, f"{name.lower()}_blacklist.txt")
        branches[name] = {"whitelist": wl, "blacklist": bl,
                          "description": "imported: " + ", ".join(g["names"]),
                          "sources": g["sources"], "whitelist_only": g["wl_only"],
                          "_src_file": src_file}

    network = {"safe_ports": extra_ports["safe_ports"],
               "ssl_ports": extra_ports["ssl_ports"],
               "full_access": [{"src": s, "desc": f"imported acl '{n}'", "time": None}
                               for n in fa_names for s in src_acls[n]]}

    # ---------- report ----------
    print("=" * 68)
    print("IMPORT PLAN" + ("" if args.apply else "  (dry run - use --apply to write)"))
    print("=" * 68)
    print(f"\nExtra Safe_ports: {network['safe_ports'] or 'none'}")
    print(f"Extra SSL_ports:  {network['ssl_ports'] or 'none'}")
    print(f"\nFull internet access ({len(network['full_access'])}):")
    for fa in network["full_access"]:
        print(f"  {fa['src']:<22} {fa['desc']}")
    print(f"\nBranches ({len(branches)}):")
    for name, b in branches.items():
        mode = "whitelist-only" if b["whitelist_only"] else "open fall-through"
        print(f"  {name:<16} {len(b['sources'])} source(s)  [{mode}]  <- {b['_src_file']}")
        for s in b["sources"]:
            print(f"     src {s}")
    for w in warnings:
        print("  ! " + w)

    if not args.apply:
        return

    # ---------- write ----------
    os.makedirs(config.ACL_DIR, exist_ok=True)
    for name, b in branches.items():
        src_file = b.pop("_src_file")
        entries = []
        if os.path.exists(src_file):
            for line in open(src_file):
                line = line.strip()
                if line and not line.startswith("#"):
                    entries.append(line)
        with open(b["whitelist"], "w") as f:
            f.write("# Managed by Squid Web GUI - imported from "
                    f"{os.path.basename(src_file)}\n")
            for e in entries:
                f.write(e + "\n")
        if not os.path.exists(b["blacklist"]):
            with open(b["blacklist"], "w") as f:
                f.write("# Managed by Squid Web GUI\n")

    with open(config.BRANCH_MAP, "w") as f:
        json.dump(branches, f, indent=2)
    with open(config.NETWORK_MAP, "w") as f:
        json.dump(network, f, indent=2)

    import app  # noqa: F401  (import triggers db init)
    app.generate_conf()
    print(f"\nWrote {config.BRANCH_MAP}, {config.NETWORK_MAP}")
    print(f"Copied {len(branches)} whitelist files into {config.ACL_DIR}")
    print(f"Generated {config.GEN_CONF}")
    print("\nNEXT STEPS:")
    print("  1. In squid.conf, comment out the old PERMANENT RULE and TEMP INTERNET")
    print("     blocks (the imported acl/http_access lines).")
    print(f"  2. Add just above 'http_access deny all':")
    print(f"        include {config.GEN_CONF}")
    print("  3. squid -k parse && squid -k reconfigure")
    print("  4. chown -R squidui:squidui " + config.ACL_DIR)


if __name__ == "__main__":
    main()
