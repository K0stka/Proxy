"""Run inside the CrowdSec container: python3 < test/crowdsec-recorder.py."""
import subprocess
import unittest


class RecorderException(unittest.TestCase):
    def test_known_recorder_endpoint_and_successful_requests_are_whitelisted(self):
        for path, status, agent, allowed in (
            ('/api/game/cs2/recorder/claim', 204, 'AutoTournament-Recorder/1.0', True),
            ('/api/game/cs2/recorder/claim', 401, 'AutoTournament-Recorder/1.0', False),
            ('/api/demos/example/download/0', 200, 'AutoTournament-Recorder/1.0', True),
            ('/api/game/cs2/recorder/link', 101, 'AutoTournament-Recorder/1.0', True),
            ('/api/game/cs2/recorder/link', 502, 'AutoTournament-Recorder/1.0', True),
            ('/api/game/cs2/other', 502, 'AutoTournament-Recorder/1.0', False),
            ('/api/game/cs2/recorder/link', 502, 'sqlmap/1.0', False),
            ('/api/game/cs2/recorder/claim', 204, 'sqlmap/1.0', False),
        ):
            with self.subTest(path=path, status=status, agent=agent):
                line = (f'185.5.69.56 - - [20/Oct/2026:19:17:13 +0000] '
                        f'"POST {path} HTTP/1.1" {status} 0 "-" "{agent}"')
                result = subprocess.run(
                    ['cscli', 'explain', '--log', line, '--type', 'nginx'],
                    capture_output=True, text=True, check=True, timeout=60,
                )
                output = result.stdout + result.stderr
                self.assertIn('parser success', output)
                self.assertEqual('ignored by whitelist (Known AutoTournament recorder traffic)' in output, allowed, output)


if __name__ == '__main__':
    unittest.main()
