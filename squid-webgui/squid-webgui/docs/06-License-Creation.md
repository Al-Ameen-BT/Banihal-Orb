# BT Proxy — License Creation Guide

**Version 1.12.10** · Banihal Technologies LLP
**CONFIDENTIAL — Banihal internal. Not for customer distribution.**

License keys are Ed25519-signed. Customers hold only the public key, so nothing
on a customer server can forge a key.

## Prerequisites (office machine)

```bash
unzip squid-webgui.zip -d ~/
cd ~/squid-webgui
pip install cryptography
chmod 600 deploy/vendor_private_key.hex
```

`deploy/vendor_private_key.hex` must be present. Keep it on a Banihal machine
plus a secure offline backup. **If it is lost, no new keys or update packages
can ever be signed for this build.**

## Generating a key

```bash
cd ~/squid-webgui
python3 deploy/license_gen.py "Customer Name" <years>
```

`years` may be any positive integer (typically 1, 3, or 5).

Example output:

```
Customer : Customer Name
Issued   : 2026-01-01
Expires  : 2029-01-01  (3 year(s))

BTP2.<long-signed-string>
```

Send the customer the full `BTP2.…` line. They activate it in
**Settings → License → Activate**.

## Behaviour

- Fresh installs run a 30-day trial. On expiry, Access Lists and Network Rules
  become read-only; monitoring and proxying continue. A banner warns from 7 days
  out, and (with email configured) a reminder is sent daily from 14 days out.
- Keys are self-contained — no phone-home, no internet needed at the customer.
- The customer name is embedded and shown in Settings.
- Keys cannot be revoked once issued — match the validity to the contract.
- On the server the key file is mode 600 owned by `squidui`; run with sudo:
  `sudo ./venv/bin/python deploy/license_gen.py "Name" 3`.

## Anti-tampering

Rolling the server clock back to extend a license is ignored (expiry is computed
against the highest time ever seen) and logged as `license-tamper`
(Wazuh rule 110213, level 12). With email enabled it also raises an immediate
alert.

Enforcement runs on the customer machine, so it is a commercial control backed
by the AMC contract, not a hard security boundary. What it guarantees is that
keys cannot be forged from anything on the customer's disk.

## Remove vendor files at handover

```bash
sudo rm /opt/squid-webgui/deploy/license_gen.py \
        /opt/squid-webgui/deploy/vendor_private_key.hex \
        /opt/squid-webgui/deploy/build_update.py
```

---

© Banihal Technologies LLP — BT Proxy v1.12.10
