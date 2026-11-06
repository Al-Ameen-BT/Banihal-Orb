from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from worker_executor import execute_command


class WorkerExecutorTest(unittest.TestCase):
    def test_duplicate_and_interrupted_command(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {'state_dir': directory}
            command = {'id': 'cmd1', 'type': 'allow', 'payload': {'ip': '192.168.1.4', 'domain': 'example.org'}}
            apply = Mock()
            self.assertFalse(execute_command(command, config, apply)['duplicate'])
            self.assertTrue(execute_command(command, config, apply)['duplicate'])
            apply.assert_called_once()
            broken = {'id': 'cmd2', 'type': 'deny', 'payload': {}}
            with self.assertRaises(RuntimeError):
                execute_command(broken, config, Mock(side_effect=RuntimeError('failed')))
            self.assertTrue((Path(directory) / 'overload-paused').exists())
            (Path(directory) / 'overload-paused').unlink()
            with self.assertRaisesRegex(RuntimeError, 'reconciliation'):
                execute_command(broken, config, apply)

    def test_executor_reported_failure_is_not_recorded_as_applied(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'reported failure'):
                execute_command({'id': 'cmd1', 'type': 'allow'}, {'state_dir': directory}, lambda _command: {'ok': False})
            self.assertTrue((Path(directory) / 'overload-paused').exists())


if __name__ == '__main__':
    unittest.main()
