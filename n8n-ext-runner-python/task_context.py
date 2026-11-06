from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import wraps
import logging
import re

DEFAULT_TEMPLATE = "n8n/{workflow_name}/{node_name}"
PLACEHOLDER = re.compile(r"\{(workflow_name|workflow_id|node_name|node_id)\}")


def validate_template(template: str) -> str:
    if not template.strip() or re.search(r"[{}]", PLACEHOLDER.sub("", template)):
        raise ValueError(
            "Invalid N8N_APPDYNAMICS_BT_NAME_TEMPLATE; supported placeholders: "
            "workflow_name, workflow_id, node_name, node_id"
        )
    return template


@dataclass(frozen=True)
class TaskContext:
    workflow_name: str = "Unknown"
    workflow_id: str = "Unknown"
    node_name: str = "Unknown"
    node_id: str = "Unknown"
    task_id: str = ""
    execution_id: str = ""
    correlation_header: str = ""


current_task: ContextVar[TaskContext | None] = ContextVar("appdynamics_task", default=None)


def render_name(template: str, context: TaskContext) -> str:
    return PLACEHOLDER.sub(
        lambda match: getattr(context, match.group(1)) or "Unknown", template
    )


def install_task_context() -> None:
    from src import message_serde
    from src.message_types.broker import BrokerTaskSettings, TaskSettings
    from src.task_runner import TaskRunner

    @dataclass
    class InstrumentedSettings(TaskSettings):
        appdynamics: dict[str, str] = field(default_factory=dict)

    parse = message_serde.MESSAGE_TYPE_MAP["broker:tasksettings"]

    @wraps(parse)
    def parse_settings(data: dict) -> BrokerTaskSettings:
        message = parse(data)
        extra = data["settings"].get("__appdynamics", {})
        metadata: dict[str, str] = {}
        if isinstance(extra, dict):
            for key in ("correlationHeader", "executionId"):
                value = extra.get(key, "")
                if isinstance(value, str) and len(value) <= 8192:
                    metadata[key] = value
                else:
                    logging.getLogger("appdynamics.agent").warning(
                        "Ignoring invalid optional task metadata field %s", key
                    )
        else:
            logging.getLogger("appdynamics.agent").warning(
                "Ignoring invalid optional AppDynamics task metadata"
            )
        # Keep the original code/items objects; do not copy or modify user data.
        message.settings = InstrumentedSettings(**vars(message.settings), appdynamics=metadata)
        return message

    execute = TaskRunner._execute_task

    @wraps(execute)
    async def execute_task(
        runner: TaskRunner, task_id: str, settings: TaskSettings
    ) -> None:
        extra = settings.appdynamics if isinstance(settings, InstrumentedSettings) else {}
        token = current_task.set(TaskContext(
            workflow_name=settings.workflow_name,
            workflow_id=settings.workflow_id,
            node_name=settings.node_name,
            node_id=settings.node_id,
            task_id=task_id,
            execution_id=extra.get("executionId", ""),
            correlation_header=extra.get("correlationHeader", ""),
        ))
        try:
            await execute(runner, task_id, settings)
        finally:
            current_task.reset(token)

    message_serde.MESSAGE_TYPE_MAP["broker:tasksettings"] = parse_settings
    TaskRunner._execute_task = execute_task
