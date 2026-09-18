# BT Proxy — Active Directory / LDAPS Integration (Internal)

Banihal Technologies LLP — internal runbook and site record.
Not for customer handover.

This document has two parts:

- **Part A — Runbook.** Reusable steps to get BT Proxy authenticating admins
  against Active Directory over verified LDAPS. Use this at every branch.
- **Part B — Tirur (tirurucb.ad) record.** What was actually wrong at the first
  site and how it was resolved, with the real values, so the next branch is a
  copy-and-adjust job.

---

## Part A — Runbook: AD login over LDAPS

### The one thing to understand first

A domain controller does **not** have a separate "enable LDAPS" switch. It
starts serving LDAPS on port 636 automatically **the moment it holds a valid
server-authentication certificate** in its computer certificate store. No cert
= no LDAPS. So "enabling LDAPS" always means "getting a certificate onto the
DCs."

Modern domain controllers also **reject plain (unencrypted) LDAP binds** that
carry credentials — they require signing or TLS. This is correct and secure.
The practical consequence: if the DCs have no certificate, there is **no**
working path for an authenticated bind at all — plaintext is refused by policy,
and encrypted is impossible with no cert. Both must line up: the DC requires
encryption **and** has a certificate to provide it.

Do not "fix" a login failure by disabling the DC's signing requirement or by
running BT Proxy on plaintext LDAP. On a bank network that is the wrong
direction and an auditor will flag it. The correct fix is always: give the DCs
a certificate, then connect over verified LDAPS.

### Step 1 — Confirm whether LDAPS already works

From the proxy, against each DC:

```bash
openssl s_client -connect <DC-FQDN>:636 </dev/null
```

- **Certificate block printed, TLS negotiated** → LDAPS is already served. Skip
  to Step 4 (you only need the CA file for verification).
- **`write:errno=104`, `no peer certificate available`, handshake reads 0
  bytes** → the DC has no certificate. Continue to Step 2.

### Step 2 — Get a certificate onto every DC

**Preferred: enterprise CA (AD Certificate Services).** If the domain has an
enterprise CA, DCs auto-enrol for a Domain Controller certificate. Force it now
instead of waiting for the ~90-minute cycle — run on **each** DC:

```powershell
certutil -pulse
gpupdate /force
```

Then re-check with the `openssl` command from Step 1. A CA-issued cert is the
right answer: it chains to a root you can pin, and future branch DCs auto-enrol
with no extra work.

**If no CA exists and you need the site working now: self-signed per DC.** Run
on **each** DC, changing the names to that DC's own FQDN:

```powershell
New-SelfSignedCertificate `
  -Subject "CN=<DC-FQDN>" `
  -DnsName "<DC-FQDN>","<domain>" `
  -CertStoreLocation "Cert:\LocalMachine\My" `
  -KeyExportPolicy Exportable `
  -KeyLength 2048 -HashAlgorithm SHA256 `
  -Provider "Microsoft Software Key Storage Provider" `
  -KeyUsage DigitalSignature,KeyEncipherment `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.1")
```

The `2.5.29.37=...1.3.6.1.5.5.7.3.1` extension is the **Server Authentication**
EKU — without it the DC will not use the cert for LDAPS. Self-signed means the
proxy cannot validate a chain, so you would run with verify-cert **off**
(encrypted but unverified). Acceptable only as a stopgap; move to a CA.

> Do **every** DC the proxy talks to (host1 and host2). A login that lands on an
> un-certed DC still fails, and you will chase a ghost.

If a DC still resets on 636 a minute after getting its cert, force it to pick up
the cert:

```powershell
Restart-Service NTDS -Force
```

(Brief AD interruption on that DC only; the other DC covers logins.)

### Step 3 — Verify LDAPS is live

From the proxy, for each DC:

```bash
openssl s_client -connect <DC-FQDN>:636 </dev/null
```

Expect a `Server certificate` block with `subject=CN=<DC-FQDN>` and a negotiated
TLS version. A `Verify return code: 21 (unable to verify the first
certificate)` at this stage is **fine** — it only means the proxy does not yet
have the CA to check the chain. That is Step 4.

### Step 4 — Pin the CA on the proxy (for verified TLS)

On the CA server (the DC hosting the enterprise CA), export the CA certificate.
Note: in PowerShell, quote the switch or the dot in `-ca.cert` mis-parses.

```powershell
certutil "-ca.cert" C:\ca.cer
certutil "-ca.chain" C:\ca-chain.p7b     # full chain (use this if -ca.cert is incomplete)
```

Move the file to the proxy (WinSCP / scp / share — **do not hand-paste**; a
truncated paste produces an invalid cert and a misleading "verify failed").
Then convert to a PEM containing the full chain:

```bash
openssl pkcs7 -print_certs -in /tmp/ca-chain.p7b -out /opt/squid-webgui/certs/ad-ca.pem
sudo chown squidui:squidui /opt/squid-webgui/certs/ad-ca.pem
sudo chmod 644 /opt/squid-webgui/certs/ad-ca.pem
grep -c "BEGIN CERTIFICATE" /opt/squid-webgui/certs/ad-ca.pem     # 1 = self-contained root; 2+ = chain
```

**Verify exactly the way BT Proxy will** — Python trusts *only* the CA file you
give it, with no system-store fallback (unlike `openssl s_client`, which can
mislead you by completing a chain from the OS store):

```bash
python3 - << 'PY'
import ssl, socket
CA = "/opt/squid-webgui/certs/ad-ca.pem"
for host in ("<DC1-FQDN>", "<DC2-FQDN>"):
    try:
        ctx = ssl.create_default_context(cafile=CA)
        with socket.create_connection((host, 636), timeout=5) as raw:
            with ctx.wrap_socket(raw, server_hostname=host) as s:
                print(f"{host}: OK (TLS {s.version()})")
    except Exception as e:
        print(f"{host}: FAIL - {e}")
PY
```

`OK` for both DCs is the gate. If either says `unable to get local issuer`, the
PEM is missing part of the chain — redo the export with `-ca.chain` and transfer
by file, not paste.

### Step 5 — Find the group DN for role mapping

BT Proxy maps an AD group to a role by matching the **full group DN** (exact,
case-insensitive). Not the group name — the whole `CN=...,DC=...` string.

Get the DNs of the groups the test user belongs to:

```bash
LDAPTLS_CACERT=/opt/squid-webgui/certs/ad-ca.pem \
ldapsearch -x -H ldaps://<DC-FQDN>:636 -D "<user>@<domain>" -W \
  -b "<base-dn>" "(sAMAccountName=<user>)" memberOf
```

(`ldapsearch` needs `LDAPTLS_CACERT` pointed at the CA file, or it drops the
LDAPS connection with "Can't contact LDAP server". That is the tool's own trust
config, nothing to do with BT Proxy.)

Or from a DC in PowerShell:

```powershell
Get-ADUser <user> -Properties MemberOf | Select-Object -ExpandProperty MemberOf
```

Copy the DN of the group that should be BT Proxy admin, verbatim.

### Step 6 — Configure BT Proxy

Settings → Active Directory:

| Field | Value |
|---|---|
| Enable AD login | on |
| Domain controller 1 / 2 | the DC FQDNs (both) |
| Security | **LDAPS (636)** |
| Port | 636 |
| Verify DC certificate | **on** |
| CA file | `/opt/squid-webgui/certs/ad-ca.pem` |
| Domain | e.g. `bank.ad` (used to build `user@bank.ad`) |
| Base DN | e.g. `DC=bank,DC=ad` |
| Bind user / password | a read-only service account (UPN or DN) |
| Admin group | the **full DN** from Step 5 |
| Operator / Viewer group | full DNs if used, else blank |

Save, then **Test**. Provide a test user + password in the test fields to
confirm the full login maps to a role.

Confirm the CA path actually saved (this bit us once — see Part B):

```bash
grep ad_ca_file /opt/squid-webgui/settings.json
```

It must show the path, not `""`.

### Reading the Test result

| Message | Meaning | Action |
|---|---|---|
| `NOT reachable (... ssl wrapping ... reset by peer)` | TCP opens, TLS refused | DC has no cert — Step 2 |
| `NOT reachable (CERTIFICATE_VERIFY_FAILED / unable to get local issuer)` | CA file wrong, missing, or empty in settings | Step 4; check `ad_ca_file` is saved |
| `startTLS failed - unavailable` | DC offers no StartTLS (no cert) | use LDAPS after Step 2 |
| `bad_creds` on plaintext | DC rejects unsigned binds by policy | not a password problem — use LDAPS |
| `password OK, but no mapped group` | auth works; group DN doesn't match | Step 5 — use the full DN |
| `SUCCESS - mapped to role '<role>'` | done | back up the config |

### After it works

- **Back up:** BT Proxy → Backup → Create. The backup includes `settings.json`,
  so the AD config and CA path are captured.
- **Certificate expiry:** CA-issued DC certs are typically 1 year. AD CS
  auto-enrolment renews them, but note the date — an expired DC cert breaks
  LDAPS login across all branches at once.
- **Least privilege:** map admin to a group that means "may administer BT
  Proxy," not a broad "Remote Admins" that grants more elsewhere. A dedicated
  `BT-Proxy-Admins` group is cleaner for a bank.

---

## Part B — Tirur record (tirurucb.ad)

### Environment

- Proxy host: `TUCB-DC-PROXY`
- DCs: `AD-PRI.tirurucb.ad`, `SEC-AD.tirurucb.ad`
- Domain: `tirurucb.ad`  ·  Base DN: `DC=tirurucb,DC=ad`
- Enterprise CA (already present on AD-PRI): `tirurucb-AD-PRI-CA`
- Test user: `tbt001@tirurucb.ad` (Subind K)

### Symptom

AD test failed on both DCs. As settings were tried, the errors walked through:

1. **LDAPS 636** — `socket ssl wrapping error: [Errno 104] Connection reset by
   peer`. `openssl s_client ...:636` returned `no peer certificate available`.
2. **StartTLS 389** — `startTLS failed - unavailable`.
3. **Plaintext 389** — `bad_creds`, despite the same credentials logging into
   PCs fine.
4. `ldapwhoami -x` gave the decisive line: `ldap_bind: Strong(er)
   authentication required (8) ... The server requires binds to turn on
   integrity checking if SSL/TLS are not already active`.
5. On AD-PRI, Directory Service **event 2888** confirmed: the DC is configured
   to reject unsigned/clear-text binds ("simple binds rejected because they were
   performed without SSL/TLS: 1" — that 1 was the proxy's test).

### Root cause

Two individually-correct AD security settings collided: the DCs **required**
signed/encrypted binds, but had **no certificate**, so no encrypted path
existed. PC login worked because it uses Kerberos (already
signed/encrypted). The proxy's bind was refused by policy, not by a wrong
password. Nothing was wrong in BT Proxy or its config.

### Fix

1. DCs held no LDAPS cert. The enterprise CA `tirurucb-AD-PRI-CA` existed, so
   the DCs auto-enrolled Domain Controller certificates (CA-issued, not
   self-signed — confirmed by the issuer line on the served cert). LDAPS then
   came up on 636 on both DCs.
2. Exported the CA cert on AD-PRI. First attempt with `-ca.cert` plus a manual
   copy-paste produced a **truncated, invalid** PEM → `CERTIFICATE_VERIFY_FAILED
   / unable to get local issuer`. Re-exported with `certutil "-ca.chain"`,
   transferred the `.p7b` as a file, and converted with
   `openssl pkcs7 -print_certs` → `/opt/squid-webgui/certs/ad-ca.pem`.
   (`tirurucb-AD-PRI-CA` turned out to be a self-contained root: subject ==
   issuer, one cert. The single cert was fine — the earlier failure was purely
   the bad paste.)
3. Python-level verification against the CA file returned `OK` for both DCs.
4. **The remaining failure was a blank `ad_ca_file` in `settings.json`** — the
   path had not been saved even though the file was correct and readable by
   `squidui`. Set the path, restarted the service.
5. `Test` then returned `password OK, but no mapped group`. The Admin group
   field needed the **full DN**, not the name. `tbt001` is a member of
   `CN=Support UI Access,CN=Users,DC=tirurucb,DC=ad` and
   `CN=Remote Admins,CN=Users,DC=tirurucb,DC=ad`. Put the full DN in the Admin
   group field.
6. Final result: **`SUCCESS - mapped to role 'admin'`**.

### Working values (Tirur)

| Setting | Value |
|---|---|
| Security | LDAPS (636) |
| Verify cert | on |
| CA file | `/opt/squid-webgui/certs/ad-ca.pem` |
| Domain | `tirurucb.ad` |
| Base DN | `DC=tirurucb,DC=ad` |
| DC1 / DC2 | `AD-PRI.tirurucb.ad` / `SEC-AD.tirurucb.ad` |
| Admin group | (full DN of the chosen admin group in `CN=Users`) |

### Notes carried forward

- DC cert expiry: **Aug 5 2027** (CA root: 2036). Confirm AD CS auto-renews the
  DC certs before the 2027 date.
- Decide deliberately which AD group is proxy-admin; prefer a dedicated
  `BT-Proxy-Admins` group over a broad one.
- Open item: the `ad_ca_file` came back blank once after saving. If the AD
  settings form is not re-submitting the CA-file field on Save, that is a UI bug
  to fix — check whether the field shows the saved path when the page reloads.

### Rollout note (13 branches)

Because the enterprise CA auto-enrols every DC and they all chain to the same
root, each branch DC serves LDAPS on its own and the proxy reuses the identical
`ad-ca.pem`. Per branch, only these change: DC FQDNs, base DN, and the group DN.
The certificate work is done once.
