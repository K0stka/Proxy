import importlib.util
import http.server
import json
from pathlib import Path
import socketserver
import tempfile
import threading
import unittest
import io
import subprocess
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).with_name('proxy-maintenance.py'))
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class MaintenanceTests(unittest.TestCase):
    def test_verbose_updates_are_private_and_terminal_output_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            def path(value):
                return Path(directory) if value == '/var/log/proxy-updates' else Path(value)
            def run(*args, **kwargs):
                kwargs['stdout'].write(b'x' * 100000 + b'\nDeployment passed\n')
                return subprocess.CompletedProcess(args[0], 0)
            output = io.StringIO()
            with patch.object(maintenance, 'Path', side_effect=path), patch.object(maintenance.subprocess, 'run', side_effect=run), patch('sys.stdout', output):
                maintenance.update(Path(directory))
            self.assertLess(len(output.getvalue()), 17000)
            self.assertIn('Deployment passed', output.getvalue())
            log = next(Path(directory).glob('update-*.log'))
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)
            self.assertGreater(log.stat().st_size, 100000)
            with patch.object(maintenance, 'Path', side_effect=path), patch.object(maintenance.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)), patch('sys.stdout', io.StringIO()):
                with self.assertRaises(subprocess.CalledProcessError): maintenance.update(Path(directory))

    def test_fixed_broker_command_uses_and_closes_a_real_unix_http_connection(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                body = json.dumps({'operation': self.path}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        with tempfile.TemporaryDirectory() as directory:
            template = Mock()
            template.read_text.return_value = json.dumps({'ipc': directory})
            with socketserver.UnixStreamServer(directory + '/edge.sock', Handler) as server:
                thread = threading.Thread(target=server.handle_request)
                thread.start()
                def path(value):
                    return template if value == '/var/lib/proxy-handoff/templates.json' else Path(value)
                with patch.object(maintenance, 'Path', side_effect=path):
                    self.assertEqual(maintenance.broker('/inventory'), {'operation': '/inventory'})
                thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
