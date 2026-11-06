from pathlib import Path
import subprocess
import sys
from types import ModuleType
import unittest
from unittest.mock import MagicMock, patch

from bootstrap import main, task_transaction, trace_executor
from task_context import TaskContext, current_task, render_name, validate_template


class BootstrapTests(unittest.TestCase):
    def test_preserves_arguments_result_and_metadata(self) -> None:
        def execute(value: int, *, multiplier: int) -> tuple[int, str]:
            return value * multiplier, "result"

        transaction = MagicMock()
        traced = trace_executor(execute, transaction)
        self.assertEqual(traced(3, multiplier=2), (6, "result"))
        self.assertEqual(traced.__name__, execute.__name__)
        transaction.assert_called_once_with("n8n/Unknown/Unknown")
        transaction.return_value.__exit__.assert_called_once_with(None, None, None)

    def test_propagates_and_reports_execution_errors(self) -> None:
        error = RuntimeError("task failed")

        def execute() -> None:
            raise error

        transaction = MagicMock()
        with self.assertRaisesRegex(RuntimeError, "task failed"):
            trace_executor(execute, transaction)()
        exception_args = transaction.return_value.__exit__.call_args.args
        self.assertIs(exception_args[0], RuntimeError)
        self.assertIs(exception_args[1], error)

    def test_forkserver_import_does_not_initialize_agent(self) -> None:
        result = subprocess.run(
            [
                sys.executable, "-I", "-B", "-c",
                "import runpy, sys; "
                f"runpy.run_path({str(Path(__file__).with_name('bootstrap.py'))!r}, "
                "run_name='__mp_main__'); "
                "assert 'appdynamics.agent' not in sys.modules",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_uninitialized_agent_fails_explicitly(self) -> None:
        api = MagicMock()
        api.start_bt.return_value = None
        agent = ModuleType("appdynamics.agent")
        agent.api = api
        with patch.dict(sys.modules, {
            "appdynamics": ModuleType("appdynamics"),
            "appdynamics.agent": agent,
        }), patch(
            "time.monotonic", side_effect=[0, 61]
        ):
            with self.assertRaisesRegex(RuntimeError, "could not start"):
                with task_transaction("test"):
                    self.fail("Uninstrumented task must not run")
        api.start_bt.assert_called_once_with("test")
        api.end_bt.assert_not_called()

    def test_main_wraps_dispatch_and_shuts_down_on_runner_error(self) -> None:
        api = MagicMock()
        api.init.return_value = False
        api.start_bt.side_effect = [None, 1234]
        agent = ModuleType("appdynamics.agent")
        agent.api = api
        executor = ModuleType("src.task_executor")

        class TaskExecutor:
            @staticmethod
            def execute_process(value: int) -> int:
                return value

        executor.TaskExecutor = TaskExecutor

        def run_module(name: str, *, run_name: str) -> None:
            self.assertEqual((name, run_name), ("src.main", "__main__"))
            self.assertEqual(TaskExecutor.execute_process(7), 7)
            raise RuntimeError("runner stopped")

        with patch.dict(sys.modules, {
            "appdynamics": ModuleType("appdynamics"),
            "appdynamics.agent": agent,
            "src": ModuleType("src"),
            "src.task_executor": executor,
        }), patch("runpy.run_module", side_effect=run_module), patch("time.sleep"), patch(
            "bootstrap.install_task_context"
        ):
            with self.assertRaisesRegex(RuntimeError, "runner stopped"):
                main()
        api.init.assert_called_once_with()
        self.assertEqual(api.start_bt.call_count, 2)
        api.start_bt.assert_called_with("n8n/Unknown/Unknown")
        api.end_bt.assert_called_once_with(1234, None)
        api.shutdown.assert_called_once_with(timeout_ms=5_000)

    def test_transaction_ends_with_original_exception(self) -> None:
        api = MagicMock()
        api.start_bt.return_value = 1234
        agent = ModuleType("appdynamics.agent")
        agent.api = api
        error = ValueError("code failed")
        with patch.dict(sys.modules, {
            "appdynamics": ModuleType("appdynamics"),
            "appdynamics.agent": agent,
        }):
            with self.assertRaisesRegex(ValueError, "code failed"):
                with task_transaction("test"):
                    raise error
        api.end_bt.assert_called_once_with(1234, error)

    def test_name_templates(self) -> None:
        context = TaskContext(workflow_name="Orders", workflow_id="wf1", node_name="Validate", node_id="n1")
        for template, expected in [
            ("n8n/{workflow_name}/{node_name}", "n8n/Orders/Validate"),
            ("{workflow_id}/{node_id}", "wf1/n1"),
            ("{workflow_name}", "Orders"),
            ("literal", "literal"),
        ]:
            self.assertEqual(render_name(validate_template(template), context), expected)
        for invalid in ("", " ", "{task_id}", "{execution_id}", "{node_name", "{{node_name}}"):
            with self.assertRaises(ValueError):
                validate_template(invalid)

    def test_correlation_and_snapshot_metadata(self) -> None:
        api = MagicMock()
        api.start_bt.return_value = 12
        agent = ModuleType("appdynamics.agent")
        agent.api = api
        token = current_task.set(TaskContext(
            workflow_name="Orders", node_name="Validate", task_id="t1",
            execution_id="e1", correlation_header="opaque-test",
        ))
        try:
            with patch.dict(sys.modules, {
                "appdynamics": ModuleType("appdynamics"), "appdynamics.agent": agent,
            }):
                with task_transaction("Orders/Validate"):
                    pass
        finally:
            current_task.reset(token)
        api.start_bt.assert_called_once_with("Orders/Validate", correlation_header="opaque-test")
        api.add_snapshot_data.assert_any_call(12, "n8n.task.id", "t1")
        api.add_snapshot_data.assert_any_call(12, "n8n.execution.id", "e1")
        api.end_bt.assert_called_once_with(12, None)

    def test_optional_correlation_falls_back_without_waiting(self) -> None:
        api = MagicMock()
        api.start_bt.side_effect = [None, 12]
        agent = ModuleType("appdynamics.agent")
        agent.api = api
        token = current_task.set(TaskContext(correlation_header="unusable-test"))
        try:
            with patch.dict(sys.modules, {
                "appdynamics": ModuleType("appdynamics"), "appdynamics.agent": agent,
            }), patch("time.sleep") as sleep, self.assertLogs("appdynamics.agent", level="WARNING"):
                with task_transaction("test"):
                    pass
            sleep.assert_not_called()
        finally:
            current_task.reset(token)
        self.assertEqual(api.start_bt.call_count, 2)
        api.start_bt.assert_called_with("test")

    def test_decoder_and_concurrent_dispatch_context(self) -> None:
        import asyncio
        from src import message_serde
        from src.task_runner import TaskRunner
        from task_context import install_task_context

        observed = []

        async def original(runner, task_id, settings):
            await asyncio.sleep(0)
            observed.append(await asyncio.to_thread(current_task.get))
            if task_id == "bad":
                raise RuntimeError("original error")

        parser = message_serde.MESSAGE_TYPE_MAP["broker:tasksettings"]
        execute = TaskRunner._execute_task
        try:
            TaskRunner._execute_task = original
            install_task_context()
            items = [{"json": {"unchanged": True}}]

            def message(task_id, node, header):
                return message_serde.MESSAGE_TYPE_MAP["broker:tasksettings"]({
                    "type": "broker:tasksettings", "taskId": task_id,
                    "settings": {
                        "code": "return []", "nodeMode": "runOnceForAllItems", "items": items,
                        "workflowName": "Orders", "nodeName": node,
                        "__appdynamics": {"correlationHeader": header, "executionId": "e1"},
                    },
                })

            first, second = message("a", "A", "header-a"), message("b", "B", "header-b")
            self.assertIs(first.settings.items, items)

            async def check():
                await asyncio.gather(
                    TaskRunner._execute_task(None, first.task_id, first.settings),
                    TaskRunner._execute_task(None, second.task_id, second.settings),
                )
                self.assertIsNone(current_task.get())
                with self.assertRaisesRegex(RuntimeError, "original error"):
                    await TaskRunner._execute_task(None, "bad", first.settings)
                self.assertIsNone(current_task.get())

            asyncio.run(check())
            self.assertEqual([(c.node_name, c.correlation_header) for c in observed[:2]],
                             [("A", "header-a"), ("B", "header-b")])
            with self.assertLogs("appdynamics.agent", level="WARNING"):
                invalid = message("c", "C", {"not": "a string"})
            self.assertNotIn("correlationHeader", invalid.settings.appdynamics)
        finally:
            message_serde.MESSAGE_TYPE_MAP["broker:tasksettings"] = parser
            TaskRunner._execute_task = execute


if __name__ == "__main__":
    unittest.main()
