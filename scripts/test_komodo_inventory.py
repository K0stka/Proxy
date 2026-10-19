import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('komodo_inventory.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryTests(unittest.TestCase):
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
