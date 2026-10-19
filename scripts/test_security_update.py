import importlib.util
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('security_update', Path(__file__).with_name('security-update.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class DeploymentTests(unittest.TestCase):
    def test_managed_rollback_restores_environment_before_restarting_old_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / 'templates.json'
            template.write_text('{"environment":"candidate"}')
            backup = root / 'backup.json'
            backup.write_text('{"environment":"previous"}')
            previous = [{'Image': 'old-control'}, {'Image': 'old-edge'}]
            calls = []
            def handoff(images):
                calls.append(images)
                if len(calls) == 2:
                    self.assertEqual(template.read_text(), backup.read_text())
            with patch.object(updater, 'run', return_value='sha256:candidate'), patch.object(updater, 'handoff', side_effect=handoff), patch.object(updater, 'TEMPLATE_PATH', template):
                with self.assertRaisesRegex(RuntimeError, 'health verification failed'):
                    updater.deploy(root, previous, None, root / 'rollback.json',
                        check=lambda *_: False, rollback_check=lambda *_: True,
                        wait=lambda _: None, attempts=1, managed=True, rollback_templates=backup)
            self.assertEqual(len(calls), 2)

    def test_git_checks_out_readable_sources_without_relaxing_other_commands(self):
        with patch.object(updater.subprocess, 'check_call') as call:
            updater.run(['git', 'merge', '--ff-only', 'revision'])
            self.assertEqual(call.call_args.kwargs['umask'], 0o022)
            updater.run(['docker', 'compose', 'up', '-d'])
            self.assertNotIn('umask', call.call_args.kwargs)

    def test_reconstructed_images_preserve_startup_without_embedding_runtime_secrets(self):
        changes = updater.rollback_configuration({
            'Entrypoint': ['proxy-start', 'control'], 'Cmd': ['node', 'server/main.js'],
            'User': '0:10000', 'WorkingDir': '/app',
            'Env': ['PATH=/bin', 'PROXY_STATE=/state', 'PROXY_KOMODO_KEY=do-not-store',
                    'PROXY_KOMODO_SECRET=do-not-store', 'PROXY_CLOUDFLARE_TOKENS=do-not-store',
                    'PROXY_BOOTSTRAP_TOKEN=do-not-store'],
        })
        self.assertNotIn('do-not-store', '\n'.join(changes))
        self.assertIn('ENV PROXY_STATE="/state"', changes)
        self.assertIn('ENTRYPOINT ["proxy-start", "control"]', changes)

    def test_health_failure_restores_images_and_uses_rollback_override(self):
        previous = [{'Image': 'sha256:known-good', 'Config': {'Image': 'proxy-control'}}]
        with patch.object(updater, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'health verification failed'):
                updater.deploy(Path('/deployment'), previous, None, Path('/private/rollback.json'),
                               check=lambda *_: False, rollback_check=lambda *_: True,
                               wait=lambda _: None, attempts=1, managed=False)
            calls = [call.args[0] for call in run.call_args_list]
            self.assertIn(['docker', 'tag', 'sha256:known-good', 'proxy-control'], calls)
            self.assertIn('/private/rollback.json', calls[-1])
            self.assertIn('--no-build', calls[-1])

    def test_healthy_candidate_does_not_run_rollback(self):
        with patch.object(updater, 'run') as run:
            updater.deploy(Path('/deployment'), [], None, Path('/private/rollback.json'),
                           check=lambda *_: True, wait=lambda _: None, attempts=1, managed=False)
            self.assertEqual(run.call_count, 1)

    def test_managed_health_failure_rolls_application_back_through_broker(self):
        previous = [{'Image': 'old-control'}, {'Image': 'old-edge'}]
        with patch.object(updater, 'run', return_value='sha256:candidate'), patch.object(updater, 'handoff') as handoff:
            with self.assertRaisesRegex(RuntimeError, 'health verification failed'):
                updater.deploy(Path('/deployment'), previous, None, Path('/private/rollback.json'),
                               check=lambda *_: False, rollback_check=lambda *_: True,
                               wait=lambda _: None, attempts=1, managed=True)
            self.assertEqual(handoff.call_count, 2)
            self.assertEqual(handoff.call_args.args[0], {'control': 'old-control', 'edge': 'old-edge'})


if __name__ == '__main__':
    unittest.main()
