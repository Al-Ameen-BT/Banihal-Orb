# BT Proxy — SSL Certificate Installation Guide

**Version 1.12.10** · Banihal Technologies LLP

HTTPS is managed entirely from the **Certificates** page. Do not set
`SSL_ENABLED = True` in config.py by hand — if the cert files are missing the
service refuses to start. Leave it `False`; the GUI toggle controls HTTPS and
survives updates.

## 1. Self-signed certificate (recommended for internal access)

The private key is generated on the server and never leaves it.

1. Log in as admin → **Certificates**
2. **Generate self-signed**:
   - **Common Name**: the IP or hostname you browse to (pre-filled)
   - **Extra SANs**: optional additional names/IPs
   - **Validity**: e.g. 5 years
3. **Generate & install** — installs immediately; any previous cert is backed up
4. **Enable HTTPS** — the service restarts; reconnect on `https://<host>:8800`
5. Browsers warn because the certificate is self-signed. To remove the warning,
   download the `.crt` and distribute it to client PCs via Group Policy (adds it
   to the Trusted Root store).

The IP/hostname must appear in the SAN field (the form handles this) — modern
browsers ignore the Common Name.

## 2. Purchased / CA-issued certificate

**Option A — generate the CSR here (key never leaves the server):**

1. Certificates → **Generate a CSR** → fill Common Name (hostname),
   Organisation, City, State, Country (2 letters), optional SANs → **Generate CSR**
2. Submit the CSR to your CA
3. When issued: **Import purchased certificate**, upload the certificate and CA
   bundle, tick **use the key from the CSR**, install

**Option B — you already have cert + key:**

1. **Import purchased certificate** → upload certificate, private key, and CA
   bundle (or a combined PEM)
2. Enter the passphrase if the key is encrypted
3. **Validate & install** — BT Proxy verifies the key matches the certificate and
   the chain/expiry are valid before installing

## 3. Enabling / disabling HTTPS

After a certificate is installed, use **Enable HTTPS** on the Certificates page.
The service restarts and the GUI becomes available on `https://<host>:8800`.
Use **Disable HTTPS** to revert.

## 4. Monitoring and recovery

- The dashboard shows an **SSL Certificate** card: days remaining (amber ≤30,
  red ≤7) and whether HTTPS is on.
- With email configured, a warning is emailed daily from 30 days before expiry.
- Every change backs up the previous cert/key; restore from the Backups panel.
- If a bad certificate stops the service starting:

```bash
cd /opt/squid-webgui
sudo -u squidui ./venv/bin/python manage.py ssl-off        # revert to HTTP
# or
sudo -u squidui ./venv/bin/python manage.py cert-restore   # restore last good cert
sudo systemctl restart squid-webgui
```

## 5. Security note — the first certificate

Before HTTPS is enabled, uploading a private key travels over plain HTTP. For
the first certificate prefer **self-signed generation** (the key never leaves the
server) or place files via SSH. Use import over HTTPS for later replacements.

## 6. Scope

This certificate secures the **management console** (port 8800). It is not used
for intercepting client HTTPS traffic — BT Proxy filters HTTPS by the CONNECT
hostname, which needs no certificate on the client side.

---

© Banihal Technologies LLP — BT Proxy v1.12.10
