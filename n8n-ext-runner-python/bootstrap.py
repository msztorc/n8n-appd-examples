from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from functools import wraps
import logging
import os
import time

from task_context import (
    DEFAULT_TEMPLATE, TaskContext, current_task, install_task_context,
    render_name, validate_template,
)

def trace_executor[**P, R](
    execute: Callable[P, R],
    transaction: Callable[[str], AbstractContextManager[object]],
    template: str = DEFAULT_TEMPLATE,
) -> Callable[P, R]:
    validate_template(template)
    @wraps(execute)
    def traced(*args: P.args, **kwargs: P.kwargs) -> R:
        with transaction(render_name(template, current_task.get() or TaskContext())):
            return execute(*args, **kwargs)

    return traced


@contextmanager
def task_transaction(name: str) -> Iterator[object]:
    from appdynamics.agent import api

    context = current_task.get()
    header = context.correlation_header if context else ""
    logger = logging.getLogger("appdynamics.agent")
    deadline = time.monotonic() + 60
    while True:
        handle = api.start_bt(name, correlation_header=header) if header else api.start_bt(name)
        if handle is None and header:
            handle = api.start_bt(name)
            if handle is not None:
                logger.warning("Task correlation unavailable; using an independent Python transaction")
                header = ""
        if handle is not None:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError(
                "AppDynamics could not start the Python task transaction within "
                "60 seconds. Check agent readiness and Controller configuration."
            )
        time.sleep(min(1, remaining))

    logger.info(
        "[appdynamics-python] Controller configuration received. Task=%s correlation=%s",
        name, "supplied" if header else "none",
    )
    if context:
        for key, value in {
            "n8n.workflow.name": context.workflow_name,
            "n8n.workflow.id": context.workflow_id,
            "n8n.node.name": context.node_name,
            "n8n.node.id": context.node_id,
            "n8n.task.id": context.task_id,
            "n8n.execution.id": context.execution_id,
            "n8n.task.name": name,
        }.items():
            if value:
                api.add_snapshot_data(handle, key, value)
    error: Exception | None = None
    try:
        yield handle
    except Exception as exception:
        error = exception
        raise
    finally:
        api.end_bt(handle, error)


def main() -> None:
    template = validate_template(os.environ.get("N8N_APPDYNAMICS_BT_NAME_TEMPLATE", DEFAULT_TEMPLATE))
    from appdynamics.agent import api

    # Initialization is asynchronous. Gate task execution, not broker registration,
    # and do not repeatedly reconfigure the agent while waiting for readiness.
    api.init()
    try:
        from src.task_executor import TaskExecutor
        import runpy

        install_task_context()
        TaskExecutor.execute_process = staticmethod(
            trace_executor(TaskExecutor.execute_process, task_transaction, template)
        )
        runpy.run_module("src.main", run_name="__main__")
    finally:
        api.shutdown(timeout_ms=5_000)


# Forkserver children import this file as __mp_main__; only the broker-facing
# parent initializes the agent, leaving n8n's per-task sandbox unchanged.
if __name__ == "__main__":
    main()
