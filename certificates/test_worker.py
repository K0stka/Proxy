import unittest
import os
import json
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch
import worker


class CertificateTests(unittest.TestCase):
    def settings(self):
        return {"certificates": {"email": "admin@example.net", "staging": True, "propagationSeconds": 60}}

    def test_apex_and_wildcard_use_distinct_names_and_requested_sans(self):
        apex=worker.certbot_args({'name':'example.net','subdomains':False},self.settings())
        wildcard=worker.certbot_args({'name':'example.net','subdomains':True},self.settings())
        self.assertNotIn('*.example.net',apex)
        self.assertIn('*.example.net',wildcard)
        self.assertIn('proxy-example.net_apex-staging',apex)
        self.assertNotEqual(apex[apex.index('--cert-name')+1],wildcard[wildcard.index('--cert-name')+1])

    def test_fixed_arguments_and_separate_staging_lineages(self):
        args = worker.certbot_args({"name": "example.net"}, self.settings())
        self.assertIn('/tmp/cloudflare/example.net.ini',args)
        self.assertIn("*.example.net", args)
        self.assertIn("--keep-until-expiring", args)
        self.assertIn("--staging", args)
        self.assertIn("proxy-example.net-staging", args)
        self.assertNotEqual(worker.cert_name("example.net", True), worker.cert_name("example.net", False))

    def test_paths_and_domain_injection_are_rejected(self):
        for value in ["../../etc/passwd", "example.net;id", "example.net\n--config", "example..net"]:
            with self.assertRaises(ValueError):
                worker.cert_name(value, False)
        with self.assertRaises(ValueError):
            worker.certbot_args({"name": "../../etc/passwd"}, self.settings())

    def test_settings_reload_from_readonly_sqlite_without_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'policy.db'
            policy={**self.settings(),'domains':[{'name':'example.net'}]}
            with sqlite3.connect(path) as connection:
                connection.execute('CREATE TABLE data (key TEXT PRIMARY KEY, value TEXT)')
                connection.execute('INSERT INTO data VALUES (?,?)',('policy',json.dumps(policy)))
            self.assertEqual(worker.load_policy(path),policy)
            policy['certificates']['staging']=False
            with sqlite3.connect(path) as connection:
                connection.execute('UPDATE data SET value=?',(json.dumps(policy),))
            self.assertFalse(worker.load_policy(path)['certificates']['staging'])
            for invalid in [{**policy,'domains':[{'name':'../invalid'}]}, {**policy,'certificates':{**policy['certificates'],'propagationSeconds':0}}]:
                with sqlite3.connect(path) as connection:
                    connection.execute('UPDATE data SET value=?',(json.dumps(invalid),))
                with self.assertRaises(ValueError):
                    worker.load_policy(path)

    @unittest.skipUnless(os.name == 'posix', 'Needs POSIX file permissions')
    def test_tokens_are_private_temporary_files_not_policy_or_arguments(self):
        with tempfile.TemporaryDirectory() as folder:
            env={'PROXY_CLOUDFLARE_TOKEN':'default-token-'+'a'*32,'PROXY_CLOUDFLARE_TOKENS':json.dumps({'other.net':'override-token-'+'b'*32})}
            directory=Path(folder)/'credentials'
            for name,prefix in [('example.net','default-token-'),('other.net','override-token-')]:
                worker.write_credentials(name,env,directory)
                file=directory/(name+'.ini')
                self.assertEqual(file.stat().st_mode & 0o777,0o600)
                self.assertIn(prefix,file.read_text())
                self.assertNotIn(prefix,' '.join(worker.certbot_args({'name':name},self.settings())))
            for change in [{'PROXY_CLOUDFLARE_TOKEN':'secret\ninjected = yes'},{'PROXY_CLOUDFLARE_TOKENS':'[]'}]:
                with self.assertRaises(ValueError) as caught:
                    worker.write_credentials('example.net',{**env,**change},directory)
                self.assertNotIn('injected',str(caught.exception))

    def test_mismatched_key_is_never_exported(self):
        with patch.object(Path, "read_bytes", return_value=b"certificate"), patch.object(worker.subprocess, "run") as run:
            run.side_effect = [type("R", (), {"stdout": b"one"})(), type("R", (), {"stdout": b"two"})()]
            with self.assertRaises(ValueError):
                worker.export_certificate("example.net", False)

    @unittest.skipUnless(os.name == "posix" and shutil.which("openssl"), "Needs Linux symlinks and OpenSSL")
    def test_real_key_export_is_atomic_and_failed_renewal_keeps_valid_certificate(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            source = base / "certbot" / "live" / "proxy-example.net-staging"
            source.mkdir(parents=True)
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", str(source / "privkey.pem"), "-out", str(source / "fullchain.pem"), "-subj", "/CN=example.net", "-addext", "subjectAltName=DNS:example.net,DNS:*.example.net"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            export = worker.export_certificate
            original_run = subprocess.run
            failed = False

            def command(args, **kwargs):
                if args[0] == "certbot":
                    return subprocess.CompletedProcess(args, 1 if failed else 0, b"", b"sensitive error details")
                return original_run(args, **kwargs)

            domain = {"name": "example.net"}
            with patch.object(worker, "write_credentials"), patch.object(worker.subprocess, "run", side_effect=command), patch.object(worker, "export_certificate", side_effect=lambda name, stage: export(name, stage, base / "tls", base / "certbot")):
                status = worker.check_domain(domain, self.settings(), base / "status")
                self.assertTrue(status["ready"])
                live = base / "tls" / "live" / "example.net"
                self.assertTrue(live.is_symlink())
                self.assertEqual((live / "privkey.pem").stat().st_mode & 0o777, 0o640)
                before = live.resolve()
                failed = True
                status = worker.check_domain(domain, self.settings(), base / "status")
                self.assertTrue(status["ready"])
                self.assertEqual(live.resolve(), before)
                self.assertNotIn("sensitive error details", json.dumps(status))


if __name__ == "__main__":
    unittest.main()
