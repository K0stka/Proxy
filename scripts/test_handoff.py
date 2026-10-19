import importlib.util
import io
import json
from pathlib import Path
import unittest
import tempfile
import os
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('handoff', Path(__file__).with_name('proxy-handoff.py'))
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


class HandoffTests(unittest.TestCase):
    def test_listener_set_is_bounded_and_ingress_is_fixed(self):
        route = {'published': True, 'kind': 'udp', 'ingressIP': '203.0.113.10',
                 'ports': '27015,27020,27025-27027'}
        self.assertEqual(handoff.ports({'routes': [route]}, '203.0.113.10'),
                         [['tcp', 80], ['tcp', 443], ['udp', 27015], ['udp', 27020],
                          ['udp', 27025], ['udp', 27026], ['udp', 27027]])
        for value in ['0', '65536', '1-65535', '80; shell', '100-1']:
            with self.assertRaises(ValueError):
                handoff.ports({'routes': [{**route, 'ports': value}]}, '203.0.113.10')
        with self.assertRaises(ValueError):
            handoff.ports({'routes': [route]}, '203.0.113.11')

    def test_ready_backend_is_enabled_before_old_backend_is_quiesced(self):
        existing = '-A -t 203.0.113.10:443 -s rr\n-a -t 203.0.113.10:443 -r 10.254.240.2:443 -m -w 1'
        with patch.object(handoff, 'run', return_value=existing) as run:
            handoff.configure_service('203.0.113.10', 'tcp', 443,
                                      {'10.254.240.2': 0, '10.254.240.3': 1})
            commands = [call.args[0] for call in run.call_args_list]
            self.assertIn('10.254.240.3:443', commands[1])
            self.assertEqual(commands[1][-1], '1')
            self.assertIn('10.254.240.2:443', commands[2])
            self.assertEqual(commands[2][-1], '0')

    def test_retirement_keeps_active_flows_until_one_hour_and_audits_forced_count(self):
        broker = handoff.Broker.__new__(handoff.Broker)
        broker.lock = __import__('threading').RLock()
        entry = {'id': 'old', 'role': 'edge', 'ip': '10.254.240.2', 'deadline': 3600}
        broker.state = {'draining': [entry]}
        broker.drop_destinations = Mock()
        broker.remove = Mock()
        broker.persist = Mock()
        with patch.object(handoff, 'generation_count', return_value=3), patch.object(handoff.time, 'time', return_value=3599), patch.object(handoff, 'audit') as audit:
            broker.reap()
            broker.remove.assert_not_called()
            audit.assert_not_called()
        with patch.object(handoff, 'generation_count', return_value=3), patch.object(handoff.time, 'time', return_value=3600), patch.object(handoff, 'audit') as audit:
            broker.reap()
            broker.remove.assert_called_once_with(entry)
            audit.assert_called_once_with('forced_retirement', generation='old', role='edge', remainingConnections=3)

    def test_application_peer_cannot_deploy_images(self):
        handler = handoff.Handler.__new__(handoff.Handler)
        handler.connection = Mock()
        handler.connection.getsockopt.return_value = __import__('struct').pack('3i', 123, 10001, 10000)
        handler.headers = {'Content-Length': '2'}
        handler.rfile = io.BytesIO(b'{}')
        handler.wfile = io.BytesIO()
        handler.command, handler.path = 'POST', '/deploy'
        handler.server = Mock()
        handler.server.broker.lock = __import__('threading').RLock()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.handle_request()
        handler.send_response.assert_called_once_with(403)
        handler.server.broker.deploy.assert_not_called()

    def test_failed_handoff_restores_routing_and_registry(self):
        broker = handoff.Broker.__new__(handoff.Broker)
        old = {'id': 'old', 'role': 'edge'}
        candidate = {'id': 'new', 'role': 'edge'}
        broker.state = {'edge': old.copy(), 'control': {}, 'draining': []}
        broker.routes = Mock(side_effect=[RuntimeError('failed switch'), None])
        broker.persist, broker.drop_destinations, broker.remove = Mock(), Mock(), Mock()
        with patch.object(handoff, 'audit') as audit:
            with self.assertRaises(RuntimeError):
                broker.activate(candidate)
            self.assertEqual(broker.state['edge'], old)
            broker.drop_destinations.assert_called_once_with(candidate)
            audit.assert_called_once_with('rollback', generation='new')

    def test_agent_recreation_keeps_traffic_but_explicit_stop_propagates(self):
        broker = handoff.Broker.__new__(handoff.Broker)
        broker.lock = __import__('threading').RLock()
        broker.agent_stopped_since = {}
        broker.state = {'edge': {'container': 'active'}, 'control': {},
                        'draining': [{'role': 'edge', 'container': 'draining'}]}
        broker.routes, broker.persist = Mock(), Mock()
        def state(name):
            return {'State': {'Status': 'created' if name == 'proxy-edge-1' else 'running'}}
        with patch.object(handoff, 'inspect', side_effect=state), patch.object(handoff, 'docker') as docker:
            broker.watch_agents()
            docker.assert_not_called()
        def stopped(name):
            return {'State': {'Status': 'exited' if name == 'proxy-edge-1' else 'running'}}
        with patch.object(handoff, 'inspect', side_effect=stopped), patch.object(handoff, 'docker') as docker, patch.object(handoff, 'audit'):
            with patch.object(handoff.time, 'time', return_value=0):
                broker.watch_agents()
                docker.assert_not_called()
            with patch.object(handoff.time, 'time', return_value=5):
                broker.watch_agents()
                self.assertEqual(docker.call_count, 2)
                self.assertIn('edge', broker.state['paused'])

    def test_cleanup_does_not_follow_application_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identifier = 'a' * 32
            (root / identifier).mkdir()
            sentinel = root / 'keep.txt'
            sentinel.write_text('keep')
            (root / identifier / 'link').symlink_to(sentinel)
            broker = handoff.Broker.__new__(handoff.Broker)
            broker.state = {}
            with patch.object(handoff, 'STATE', root), patch.object(handoff, 'run', return_value='[{"addr_info": []}]'):
                broker.remove({'id': identifier, 'ip': '10.254.240.2', 'role': 'edge'})
            self.assertEqual(sentinel.read_text(), 'keep')
            self.assertFalse((root / identifier).exists())

    def test_changed_komodo_images_request_only_the_fixed_tested_update_job(self):
        broker = handoff.Broker.__new__(handoff.Broker)
        broker.lock = __import__('threading').RLock()
        broker.state = {'draining': [], 'control': {'image': 'old'}, 'edge': {'image': 'old'}}
        broker.persist = Mock()
        agent = {'Image': 'new', 'Config': {'Env': ['PROXY_HANDOFF_AGENT=true']}}
        with patch.object(handoff, 'inspect', return_value=agent), patch.object(handoff.subprocess, 'run') as run, patch.object(handoff, 'audit'), patch.object(handoff.time, 'time', return_value=10000):
            run.return_value.returncode = 1
            broker.check_agent_updates()
            self.assertEqual(run.call_args.args[0], ['systemctl', 'start', '--no-block', 'proxy-security-update.service'])
            self.assertEqual(run.call_count, 2)
            broker.check_agent_updates()
            self.assertEqual(run.call_count, 2)


if __name__ == '__main__':
    unittest.main()
