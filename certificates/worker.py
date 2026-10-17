"""Restricted Certbot scheduler. No request-controlled arguments or shell commands."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import random
import re
import signal
import sqlite3
import subprocess
import time
import uuid


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(value), encoding="utf-8")
    os.chmod(temp, 0o640)
    os.replace(temp, path)


def cert_name(domain, staging):
    if not isinstance(domain,str) or len(domain)>253 or "." not in domain or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",label) for label in domain.split('.')):
        raise ValueError("Invalid configured domain")
    return "proxy-" + domain + ("-staging" if staging else "")


def credential_path(domain):
    cert_name(domain,False)
    return Path('/tmp/cloudflare') / (domain+'.ini')


def load_policy(path=Path('/cert-policy/policy.db')):
    with sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True) as connection:
        row=connection.execute("SELECT value FROM data WHERE key='policy'").fetchone()
    if not row:
        raise ValueError('Certificate settings unavailable')
    policy=json.loads(row[0])
    domains=policy['domains']
    settings=policy['certificates']
    if not isinstance(domains,list) or len(domains)>50:
        raise ValueError('Invalid domains')
    names=[domain['name'] for domain in domains]
    if len(set(names))!=len(names):
        raise ValueError('Duplicate domains')
    for name in names:
        cert_name(name,False)
    if type(settings['staging']) is not bool or type(settings['propagationSeconds']) is not int or not 10<=settings['propagationSeconds']<=600:
        raise ValueError('Invalid certificate settings')
    if names and not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+',settings['email']):
        raise ValueError('Invalid ACME email')
    return {'domains':[{'name':name} for name in names],'certificates':settings}


def write_credentials(domain,env=None,credentials_dir=Path('/tmp/cloudflare')):
    cert_name(domain,False)
    env=os.environ if env is None else env
    try:
        tokens=json.loads(env.get('PROXY_CLOUDFLARE_TOKENS','{}') or '{}')
    except ValueError:
        raise ValueError('PROXY_CLOUDFLARE_TOKENS must be a JSON object') from None
    if not isinstance(tokens,dict):
        raise ValueError('PROXY_CLOUDFLARE_TOKENS must be a JSON object')
    token=tokens.get(domain,env.get('PROXY_CLOUDFLARE_TOKEN',''))
    if not isinstance(token,str) or not re.fullmatch(r'[A-Za-z0-9_-]{20,512}',token):
        raise ValueError('Configure a valid Cloudflare token for this domain')
    credentials_dir.mkdir(mode=0o700,parents=True,exist_ok=True)
    fd=os.open(credentials_dir/(domain+'.ini'),os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as output:
        os.fchmod(output.fileno(),0o600)
        output.write('dns_cloudflare_api_token = '+token+'\n')


def certbot_args(domain, policy):
    name = cert_name(domain["name"], policy["certificates"]["staging"])
    credentials = str(credential_path(domain['name']))
    settings = policy["certificates"]
    propagation = settings["propagationSeconds"]
    if not isinstance(propagation, int) or not 10 <= propagation <= 600:
        raise ValueError("Invalid propagation time")
    args = ["certbot", "certonly", "--non-interactive", "--agree-tos", "--email="+settings["email"],
            "--config-dir", "/certbot", "--work-dir", "/tmp/certbot-work", "--logs-dir", "/tmp/certbot-logs",
            "--cert-name", name, "--keep-until-expiring", "--dns-cloudflare", "--dns-cloudflare-credentials", credentials,
            "--dns-cloudflare-propagation-seconds", str(propagation), "-d", domain["name"], "-d", "*." + domain["name"]]
    if settings["staging"]:
        args.append("--staging")
    return args


def export_certificate(domain, staging, tls_root=Path("/tls"), certbot_root=Path("/certbot")):
    source = certbot_root / "live" / cert_name(domain, staging)
    fullchain, key = (source / "fullchain.pem").read_bytes(), (source / "privkey.pem").read_bytes()
    # Never export a mismatched pair; a new directory and one symlink switch publish both.
    public_cert = subprocess.run(["openssl", "x509", "-pubkey", "-noout"], input=fullchain, capture_output=True, check=True).stdout
    public_key = subprocess.run(["openssl", "pkey", "-pubout"], input=key, capture_output=True, check=True).stdout
    if public_cert != public_key:
        raise ValueError("Certificate key mismatch")
    expiry_line = subprocess.run(["openssl", "x509", "-enddate", "-noout"], input=fullchain, capture_output=True, check=True).stdout.decode().strip()
    expiry = dt.datetime.strptime(expiry_line.split("=", 1)[1], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=dt.timezone.utc)
    if expiry <= dt.datetime.now(dt.timezone.utc):
        raise ValueError("Certificate expired")
    fingerprint = hashlib.sha256(fullchain).hexdigest()
    directory = tls_root / "archive" / domain / (fingerprint + ("-staging" if staging else "-production"))
    if not directory.exists():
        temp_directory = directory.with_name(directory.name + "." + uuid.uuid4().hex)
        temp_directory.mkdir(parents=True, mode=0o750)
        for name, content in [("fullchain.pem", fullchain), ("privkey.pem", key)]:
            file = temp_directory / name
            file.write_bytes(content)
            os.chmod(file, 0o640)
        atomic_json(temp_directory / "meta.json", {"staging": staging})
        os.replace(temp_directory, directory)
    live = tls_root / "live"
    live.mkdir(parents=True, exist_ok=True, mode=0o750)
    link = live / (domain + "." + uuid.uuid4().hex)
    link.symlink_to(directory)
    os.replace(link, live / domain)
    return {"ready": True, "expires": expiry.isoformat(), "fingerprint": fingerprint}


def check_domain(domain, policy, status_dir=Path("/cert-status")):
    status_file = status_dir / (domain["name"] + ".json")
    try:
        old = json.loads(status_file.read_text())
    except (OSError, ValueError):
        old = {}
    status = {**old, "lastCheck": dt.datetime.now(dt.timezone.utc).isoformat(), "staging": policy["certificates"]["staging"]}
    try:
        write_credentials(domain["name"])
        result = subprocess.run(certbot_args(domain, policy), capture_output=True, timeout=600, check=False)
        if result.returncode:
            raise ValueError("Certbot failed")
        status.update(export_certificate(domain["name"], policy["certificates"]["staging"]))
        status["error"] = None
    except (OSError, ValueError, subprocess.SubprocessError):
        # Do not forward raw Certbot output or DNS-provider errors into logs or the UI.
        status["error"] = "Certificate check failed. Verify the DNS zone, token permissions, propagation and ACME limits."
        try:
            status["ready"] = bool(old.get("ready")) and old.get("staging") == policy["certificates"]["staging"] and bool(old.get("expires")) and dt.datetime.fromisoformat(old["expires"]) > dt.datetime.now(dt.timezone.utc)
        except (ValueError, TypeError):
            status["ready"] = False
    atomic_json(status_file, status)
    return status


def main():
    os.umask(0o027)
    policy = None
    running = True

    def stop(_sig, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    requests = Path("/cert-requests")
    requests.mkdir(parents=True, exist_ok=True)
    next_check = {}
    # A single worker instance owns the Certbot state and serializes all checks.
    while running:
        try:
            updated=load_policy()
            if updated!=policy:
                policy=updated
                next_check={domain['name']:0 for domain in policy['domains']}
        except (OSError,ValueError,KeyError,TypeError,sqlite3.Error):
            pass
        for domain in policy['domains'] if policy else []:
            name = domain["name"]
            request = requests / (name + ".json")
            now = time.monotonic()
            requested = request.exists()
            if requested and now >= next_check[name] - 12 * 3600 + 300:
                request.unlink(missing_ok=True)
                next_check[name] = 0
            if now >= next_check[name]:
                check_domain(domain, policy)
                next_check[name] = time.monotonic() + 12 * 3600 + random.randint(0, 1800)
        time.sleep(5)


if __name__ == "__main__":
    main()
