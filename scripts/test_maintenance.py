import importlib.util
import http.server
import json
from pathlib import Path
import socketserver
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).with_name('proxy-maintenance.py'))
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class MaintenanceTests(unittest.TestCase):
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
