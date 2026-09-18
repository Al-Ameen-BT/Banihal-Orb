# BT Proxy — Fresh Installation Guide

**Version 1.12.10** · Banihal Technologies LLP

Deploying BT Proxy on a new Ubuntu (22.04+) or Rocky Linux (8/9) server.
Allow about 45 minutes.

---

## 1. Prerequisites

| Item | Requirement |
|---|---|
| OS | Ubuntu 22.04+ / Rocky Linux 8+ |
| CPU / RAM | 2 vCPU, 4 GB RAM minimum |
| Disk | 40 GB minimum |
| Network | Static IP on the management VLAN |
| Time | NTP accurate — required for MFA, licensing and schedules |

```bash
timedatectl status                       # "System clock synchronized: yes"
sudo timedatectl set-timezone <Area/City>   # set the local timezone
```

Set the timezone before anything else: log timestamps, backup schedules,
time-based rules and MFA all follow the server's local time.

## 2. Install packages

Ubuntu:

```bash
sudo apt update
sudo apt install -y squid python3 python3-venv python3-pip unzip
```

Rocky:

```bash
sudo dnf install -y squid python3 python3-pip unzip
```

Enable Squid:

```bash
sudo systemctl enable --now squid
systemctl is-active squid
```

## 3. Service account and directories

```bash
sudo useradd -r -m -d /opt/squid-webgui -s /sbin/nologin squidui 2>/dev/null || \
  sudo useradd -r -s /sbin/nologin squidui
sudo mkdir -p /opt/squid-webgui /etc/squid/acls
```

## 4. Deploy the application

```bash
sudo unzip -o /tmp/squid-webgui.zip -d /opt/
cd /opt/squid-webgui
sudo python3 -m venv venv
sudo ./venv/bin/pip install -r requirements.txt
```

## 5. Permissions

```bash
sudo chown -R squidui:squidui /opt/squid-webgui
sudo chown -R squidui:squid /etc/squid/acls
sudo chmod 775 /etc/squid/acls
```

Log read access — Ubuntu group is `proxy`, Rocky is `squid`:

```bash
sudo usermod -aG proxy squidui      # Ubuntu
sudo usermod -aG squid  squidui     # Rocky
sudo chmod g+rx /var/log/squid && sudo chmod g+r /var/log/squid/access.log
```

Rocky + SELinux:

```bash
sudo semanage fcontext -a -t squid_conf_t "/etc/squid/acls(/.*)?"
sudo restorecon -Rv /etc/squid/acls
```

## 6. Privilege helpers

```bash
sudo cp /opt/squid-webgui/deploy/btproxy-squid-update /usr/local/sbin/
sudo chown root:root /usr/local/sbin/btproxy-squid-update
sudo chmod 755 /usr/local/sbin/btproxy-squid-update

sudo cp /opt/squid-webgui/deploy/sudoers-squidui /etc/sudoers.d/squidui
sudo chmod 440 /etc/sudoers.d/squidui
sudo visudo -cf /etc/sudoers.d/squidui        # must print "parsed OK"

sudo tee /usr/local/bin/btp > /dev/null << 'WRAP'
#!/bin/bash
exec sudo -u squidui /opt/squid-webgui/venv/bin/python /opt/squid-webgui/manage.py "$@"
WRAP
sudo chmod 755 /usr/local/bin/btp
```

## 7. Configuration and service

Leave `SSL_ENABLED = False` in `config.py` — HTTPS is managed from the
Certificates page (see 04-SSL-Installation.md).

```bash
cd /opt/squid-webgui
sudo sed -i "s/CHANGE_ME_LONG_RANDOM_STRING/$(openssl rand -hex 32)/" deploy/squid-webgui.service
sudo cp deploy/squid-webgui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now squid-webgui
sudo systemctl status squid-webgui --no-pager
```

Restrict the firewall to the IT subnet (never the whole network):

```bash
# Ubuntu
sudo ufw allow from 10.0.0.0/24 to any port 8800 proto tcp
# Rocky
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.0.0.0/24 port port=8800 protocol=tcp accept'
sudo firewall-cmd --reload
```

Browse to `http://<server-ip>:8800` — log in `admin` / `admin@123` (change forced).

## 8. Wire Squid to the GUI — THE CRITICAL STEP

**This is the step that breaks installations when missed.** BT Proxy writes its
rules to `/etc/squid/acls/webgui_generated.conf`, but Squid only reads that file
if `squid.conf` includes it — **and the include must be above the catch-all
deny**, because Squid stops at the first matching rule.

Optionally import an existing squid.conf first:

```bash
cd /opt/squid-webgui
sudo -u squidui ./venv/bin/python import_squid_conf.py /etc/squid/squid.conf          # dry run
sudo -u squidui ./venv/bin/python import_squid_conf.py /etc/squid/squid.conf --apply
```

Back up and edit squid.conf:

```bash
sudo cp /etc/squid/squid.conf /etc/squid/squid.conf.orig
sudo nano /etc/squid/squid.conf
```

Find `http_access deny all` and add the include on the line **immediately above**
it:

```
http_access deny to_linklocal

include /etc/squid/acls/webgui_generated.conf

# And finally deny all other access to this proxy
http_access deny all
```

Also recommended, for fast restarts from the GUI:

```
shutdown_lifetime 5 seconds
```

Apply and **verify the ordering**:

```bash
sudo squid -k parse 2>&1 | grep -nE "webgui_generated|_net|deny all"
sudo squid -k reconfigure
```

The generated rules must be listed **before** `http_access deny all`. If they
are not, or if the include does not appear at all, no GUI rule will work.

## 9. First-run configuration

In the GUI: activate the license (Settings → License), set branding, password
policy, create per-person accounts, enroll MFA, configure email alerts
(Settings → Email alerts), set a backup schedule (Backup & Restore), configure
Wazuh syslog if used, and set up HTTPS (04-SSL-Installation.md).

## 10. Access rules — subnet, department, and per-host

A rule is **a name + a set of source IPs/subnets + a whitelist**, so any
granularity works:

- **Whole subnet:** `10.1.0.0/24` — the classic branch rule
- **Department:** `10.1.0.16/29` — only those hosts
- **Single host:** `10.1.0.50/32` — one PC

Rules are evaluated **most-specific-source first**, so a department or per-PC
rule always takes precedence over the wider subnet it sits inside. Each rule has
an access mode:

- **Additive** — these sources get their whitelist *plus* whatever broader rules
  grant
- **Exclusive (whitelist-only)** — these sources may reach *only* their
  whitelist; everything else is blocked

Example: branch subnet `10.1.0.0/24` (additive, general sites) with a credit
department `10.1.0.16/29` (exclusive, credit-bureau sites only). The department
PCs are correctly restricted even though their IPs sit inside the branch subnet.

**Domains:** enter a domain plainly (`example.com`). BT Proxy stores it as
`.example.com`, which Squid matches against the domain **and all its
subdomains**. Redundant entries are removed automatically.

**A site needs all its domains.** A page often loads content from other domains
(CDNs, APIs, fonts). Whitelisting one domain is rarely enough — use **Access
Lists → Dependency Finder** to discover what a site references, then approve
each domain you want.

> Reliability note: IP-based department/host rules require those machines to
> have **static IPs or DHCP reservations**. If a PC's address changes, its rule
> no longer matches it.

### Building the lists

**Adding entries.** Type one or more domains (space or comma separated). IPs and
subnets are accepted too.

- **"Include subdomains" ticked (default)** — stored as `.example.com`: matches
  `example.com` and every subdomain. This is what you want almost always.
- **Unticked** — stored as `example.com`: matches that exact host only.

If both forms of the same domain end up in one list, BT Proxy keeps the broader
(subdomain) form and tells you. This is deliberate: Squid treats both forms in
one ACL as a **fatal** error and refuses to start.

**Bulk upload.** Each list has a *Bulk upload from file* panel. Plain text, one
entry per line; blank lines and `#` comments are ignored. Every line is
validated exactly as a typed entry, and invalid lines are reported and skipped
rather than silently dropped. Limits: 1 MB, 5000 entries per import.

Example file:

```
# Core banking and bureaux
microsoft.com
www.fingate.gov.in
crt.sectigo.com
data.experian.in
cibil.com
crifhighmark.com
equifax.co.in
ckycindia.in
cersai.org.in
```

**Bulk delete.** Tick the entries to remove and use *Delete selected*.
*Select all* only ticks rows currently visible under the filter box — filter
first, then select all, to remove a whole group safely.

**Access mode.** New rules default to **Exclusive** (whitelist-only): those
sources reach only what is on their whitelist. Switch to **Additive** only when
the sources should also keep whatever broader rules grant them.

## 11. Handover checklist

- [ ] Timezone set; NTP synchronised
- [ ] `include` line present in squid.conf **above** `http_access deny all` (verified with `squid -k parse`)
- [ ] `SQUIDUI_SECRET` is a real random value in the service unit
- [ ] Firewall restricts the GUI port to the IT subnet
- [ ] Default `admin@123` changed; per-person accounts created
- [ ] MFA enrolled for admins/operators
- [ ] License activated (Settings → License shows *Licensed*)
- [ ] Email alerts configured and test message received
- [ ] Backup schedule set; one backup downloaded and stored off-server
- [ ] Syslog forwarding tested in Wazuh (if used)
- [ ] Browsing verified from a client PC
- [ ] Vendor files removed (see 06 and 07)

---

© Banihal Technologies LLP — BT Proxy v1.12.10
