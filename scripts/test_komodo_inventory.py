import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import fcntl

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('komodo_inventory.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryTests(unittest.TestCase):
    def test_update_lock_check_needs_only_read_access_and_detects_contention(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / 'lock'
            lock.touch(mode=0o400)
            original_open = open
            def read_lock(name, mode):
                self.assertEqual(mode, 'r')
                return original_open(lock, mode)
            with patch('builtins.open', side_effect=read_lock):
                self.assertFalse(inventory.update_running())
                with original_open(lock, 'r') as held:
                    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.assertTrue(inventory.update_running())
            with patch('builtins.open', side_effect=FileNotFoundError):
                self.assertFalse(inventory.update_running())

    def test_inventory_keeps_secrets_out_of_compose_and_preserves_restrictions(self):
        container = {
            'Image': 'sha256:image',
            'Config': {'Env': ['SECRET=value$literal'], 'User': '10001:10000'},
            'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}, 'ReadonlyRootfs': True,
                           'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'],
                           'LogConfig': {'Type': 'json-file'}, 'NetworkMode': 'host'},
            'Mounts': [],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private.env'
            service = inventory.service(container, 'edge-abcdef-0', path)
            self.assertNotIn('value$literal', str(service))
            self.assertEqual(path.read_text(), 'SECRET=value$literal\n')
            self.assertEqual(service['env_file'][0]['format'], 'raw')
            self.assertTrue(service['read_only'])
            self.assertFalse(service['privileged'])
            self.assertEqual(service['cap_drop'], ['ALL'])


if __name__ == '__main__':
    unittest.main()
