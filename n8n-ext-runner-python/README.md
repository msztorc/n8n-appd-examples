# n8n with an external Python runner and AppDynamics

An independent local-development example:

- **n8n main process:** AppDynamics Node.js agent.
- **External Python runner:** AppDynamics Python agent and a separate `dl-proxy`
  container, following the manual-proxy pattern in
  [the Python sidecar example](../../python-sidecar-init-container/).
- **No JavaScript task runner.** Select **Python** in Code nodes. Ordinary n8n
  nodes still run normally; JavaScript Code nodes require a different example.

> **Educational use only.** Task-runner instrumentation in this example is not
> recommended for production use. It preserves
> [n8n's sandbox protections](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/task-runners)
> but uses custom parent-process instrumentation outside the sandbox, not
> instrumentation of the user code inside it. This is a community-created
> example, not an official integration supported, certified, or endorsed by
> Cisco, Splunk, or AppDynamics, and is provided "as is" without warranty.

The project name is `n8n-ext-runner-python` and its editor defaults to
<http://localhost:5678>. Its database, encryption key, broker token, volumes,
and networks are independent of the
[internal](../n8n-simple/) and
[external JavaScript](../n8n-ext-runner-nodejs/) examples.
All three examples default to port 5678; run one at a time, or set distinct
`N8N_HTTP_PORT` values for concurrent deployments.

## Runtime and compatibility

| Component | Default image / package / runtime |
| --- | --- |
| n8n and upstream task runner | 2.45.5 |
| Node.js agent image | `appdynamics/nodejs-agent:latest` |
| Python agent (pip) | `appdynamics==26.7.2.9185` |
| Python proxy image | `appdynamics/dl-proxy:26.7.2` |
| Custom Python runner | Python 3.13, Debian Bookworm, `linux/amd64` |

[The Dockerfile](./Dockerfile) copies the Python runner package and launcher
from the matching official n8n runners image, then installs the agent and pinned
runner dependencies from [requirements.txt](./requirements.txt). Python packages
are installed at build time, not downloaded into a running container. The main
n8n image can use the host's native architecture.

This example targets `linux/amd64` with a glibc-based Python runner. On an
Apple Silicon Mac, amd64 emulation must be available; native ARM64 execution
of the Python runner is outside this example's validated scope. Check the
[AppDynamics Python supported environments](https://help.splunk.com/en/appdynamics-saas/application-performance-monitoring/26.7.0/install-app-server-agents/python-agent/python-supported-environments)
before changing the runtime or architecture.

The custom image and task hooks depend on n8n and agent APIs. n8n, the Python
pip package, and its proxy image remain pinned. `APPD_PYTHON_PROXY_IMAGE` selects
the proxy's matching `26.7.2` release; the pip version additionally includes
the build suffix `.9185`. Only the Node.js agent image follows `:latest`,
through `APPD_INIT_IMAGE`.
Recheck the upstream package layout, dependencies, task requester, message
decoder, dispatch signatures, and agent APIs when upgrading. In particular,
verify Python agent/proxy compatibility when changing either pin.
The Node.js agent's moving image tag is not a tested compatibility guarantee.
This is an instrumentation example, not an official n8n runner image.

## Setup and start

From the parent [n8n-appd-examples directory](../), using Node.js 20.12+:

```sh
node n8n-ext-runner-python/setup-env.js n8n-simple/.env
./deploy.sh n8n-ext-runner-python config
./build.sh n8n-ext-runner-python
./deploy.sh n8n-ext-runner-python
./deploy.sh n8n-ext-runner-python ps
```

The initializer copies only the AppDynamics connection settings and CA
certificate. It generates new database, encryption, and broker secrets, writes
`.env` with mode `0600`, and refuses to overwrite an existing configuration.
It does not modify the source example.

Alternatively, run `node setup-env.js` inside this directory, populate the
AppDynamics connection settings in `.env`, and place your CA certificate at
`certs/corporate-ca.pem`. Neither the private environment file nor certificates
are included in the build context or intended for Git. The entire `certs/`
directory and private `.env.*` variants are excluded; `.env.example` is explicitly
allowed by [.gitignore](./.gitignore).

The scripts auto-detect a reachable Podman or Docker runtime with Compose.
To explicitly select Docker for both image preparation and deployment:

```sh
CONTAINER_RUNTIME=docker ./build.sh n8n-ext-runner-python
CONTAINER_RUNTIME=docker ./deploy.sh n8n-ext-runner-python
```

Or, from this directory:

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f --tail 100 n8n task-runners appd-proxy
```

From the parent directory, `./deploy.sh n8n-ext-runner-python stop` stops only
this example. The `down` action removes its containers and networks but preserves
its data volumes. The build script starts no services; deployment uses prepared
images without building or pulling.

## How Python instrumentation works

[n8n-task-runners.json](./n8n-task-runners.json) is the official launcher's child
process configuration. It enables only Python and explicitly forwards the
Controller, naming, and proxy environment variables. The launcher still obtains
and injects per-runner grants; the long-lived broker token is not forwarded
through the allowlist.

The launcher starts:

```text
/opt/venv/bin/python -I -B -X disable_remote_debug /opt/runner/bootstrap.py
```

`pyagent run` normally adds an autoinjection directory to `PYTHONPATH`. Python
`-I` ignores that environment variable, so simply wrapping the default runner
command in `pyagent run` would not instrument the isolated interpreter.

Instead, [bootstrap.py](./bootstrap.py):

1. Calls the public `appdynamics.agent.api.init()` API once. Initialization is
   asynchronous; the bootstrap manages readiness separately from this initial
   call.
2. Starts the runner immediately so Controller initialization does not delay
   broker registration or launcher health checks.
3. Retains workflow/node metadata through the task-settings decoder and dispatch
   adapters in [task_context.py](./task_context.py). A task-local `ContextVar`
   carries it into n8n's execution thread, including concurrent tasks.
4. Wraps `TaskExecutor.execute_process` using the public `api.start_bt` /
   `api.end_bt` APIs, with configurable task names and optional correlation.
   Before executing user code, the wrapper waits up to 60 seconds for a
   transaction handle. If none becomes available, the task fails explicitly
   instead of running uninstrumented. Keep this custom transaction enabled in
   the Controller; a disabled agent or unavailable transaction also fails this
   check.
5. Runs the original `src.main` entrypoint and shuts down the agent on exit.

The agent and proxy share a network namespace, like containers in the reference
Kubernetes Pod. They communicate on `127.0.0.1:9091` and the proxy's dynamic port
range `10000-10100`; none of these ports is published. Both containers mount the
same CA path. The Python runner does not join the database network.

### Secure-mode boundary and limitations

Unlike the Node.js agent's JavaScript-runner compatibility workaround, this
variant **does not enable `N8N_RUNNERS_INSECURE_MODE`**:

- Python isolation flags are retained.
- Standard-library and external-module allowlists remain empty.
- The runner retains its non-root user, read-only root filesystem, dropped
  capabilities, no-new-privileges setting, and `noexec` temporary filesystem.
- The bootstrap's `__main__` guard prevents agent initialization when Python's
  forkserver imports the file in a child process.

n8n executes user Python code in separate, sandboxed subprocesses. The custom
transaction measures **parent-side task execution/wait duration**, not
line-by-line work or outbound calls inside those subprocesses. The example does
not inject the agent into them or loosen their import/environment restrictions.
Node-to-Python correlation is implemented only at the task boundary described
below, not inside the sandboxed subprocess.

Keep the installed agent and dependencies read-only, with runtime logs in the
configured writable location. Verify the Controller-ready message and a real
workflow. This example uses explicit task transactions rather than relying on
automatic web-framework instrumentation.

The Python runner is started on demand. Before the first Python task, no Python
agent node is expected. `N8N_RUNNERS_AUTO_SHUTDOWN_TIMEOUT=0` keeps a started
runner alive while idle; it does not make the launcher start one eagerly.

This is a loopback-bound HTTP development deployment, not a complete production
hardening or support certification.

## Names in AppDynamics

Default application: **`n8n-ext-runner-python`**.

| Process | Tier | Reuse-node prefix |
| --- | --- | --- |
| Main n8n | `n8n-node` | `n8n-node` |
| Python runner | `n8n-runner` | `n8n-node` |

`APPDYNAMICS_AGENT_NODE_NAME=n8n-node` is forwarded to both processes. Node reuse
is enabled, so the actual displayed names are assigned by the agents/Controller.
All standard AppDynamics connection, naming, SSL, logging, and proxy settings
are supplied through same-named variables in `.env`. See the
[shared environment guide](../README.md#appdynamics-environment-configuration)
for details.

Optional runner overrides:

```dotenv
N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX=
N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME=n8n-runner
```

Leave either override empty to inherit its standard
`APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX` or `APPDYNAMICS_AGENT_TIER_NAME`
value. These are mapped to standard agent variables in the runner container.

### Configurable transaction names

Set this in `.env` (also shown in [.env.example](./.env.example)):

```dotenv
N8N_APPDYNAMICS_BT_NAME_TEMPLATE=n8n/{workflow_name}/{node_name}
```

This is the default when the variable is absent. Supported placeholders:

| Placeholder | Task-settings field |
| --- | --- |
| `{workflow_name}` | Workflow name |
| `{workflow_id}` | Workflow ID |
| `{node_name}` | Code-node name |
| `{node_id}` | Code-node ID |

For example, `custom/{workflow_id}/{node_name}` uses the stable workflow ID
instead of its editable name. Missing or empty values become `Unknown`.
Blank templates, unknown placeholders, and unmatched braces fail configuration
validation. Templates perform literal replacement, not expression evaluation.
Apply environment changes with `docker compose up -d`.

Avoid high-cardinality names. Task and execution IDs are deliberately not
naming placeholders. Snapshot data includes `n8n.workflow.name`,
`n8n.workflow.id`, `n8n.node.name`, `n8n.node.id`, `n8n.task.id`,
`n8n.execution.id` (when available), and the rendered `n8n.task.name`.

### Optional Node-to-Python correlation

Enabled by default:

```dotenv
N8N_APPDYNAMICS_CORRELATION_ENABLED=true
```

[task-instrumentation.js](./task-instrumentation.js), loaded by
[shim.js](./shim.js), wraps only Python calls to n8n's
`TaskRequester.startTask`. It reuses an available Node transaction or creates a
task-only transaction with the configured name. A custom exit call to
`n8n-python-runner` supplies an opaque SDK-generated correlation value.

n8n communicates with its runner over a persistent WebSocket through the task
broker on port 5679 (`/runners/_ws`). Each task needs its own correlation value;
a connection-level HTTP header would not distinguish tasks. The adapter adds a
private extension to a shallow copy of that task's settings:

```json
{
  "__appdynamics": {
    "correlationHeader": "<opaque SDK-generated value>",
    "executionId": "<execution ID, when available>"
  }
}
```

The broker forwards these settings unchanged in `broker:tasksettings`. The
Python decoder adapter retains the extension, and the execution-thread wrapper
passes it to `api.start_bt(name, correlation_header=...)`. No user code, items,
sandbox subprocess arguments, broker authentication, or vendor files are
modified. The SDK-facing copy of a serialized task error is normalized to an
`Error`; n8n receives its original result or exception unchanged.

Correlation is **best-effort**: instrumentation errors are reported without
waiting, retrying the task, or replacing its result. A missing or declined
correlation value falls back to an independent Python transaction. This does
not remove the pre-existing Python agent-readiness requirement: if neither a
correlated nor independent transaction can start within 60 seconds, the task
still fails explicitly.

Both tiers must use the same AppDynamics application for this example's
continuation behavior. A correlated Python segment retains the **upstream
business transaction identity**; it does not rename an existing HTTP/root BT.
The configured task name remains in logs and snapshot data. Without an existing
Node parent, the task-only Node BT uses the template itself.

Set `N8N_APPDYNAMICS_CORRELATION_ENABLED=false` to skip the Node task hook.
Main-process Node instrumentation and independently named Python transactions
remain enabled. Execution IDs forwarded by that hook are then unavailable,
but native workflow, node, and task metadata remain available.

## Tests and smoke workflow

After building the image, from this example directory:

```sh
NODE_OPTIONS= node --test *.test.js
podman compose run --rm --no-deps --entrypoint /opt/venv/bin/python \
  -v "$PWD/test_bootstrap.py:/opt/runner/test_bootstrap.py:ro" \
  task-runners -I -B -m unittest discover -s /opt/runner -p test_bootstrap.py
```

Use `docker compose` instead if the image was built with Docker.

The tests cover secure launcher settings, environment forwarding, main-process
preloading, independent secret generation, result/error preservation in the
dispatch wrapper, forkserver import behavior, and unavailable transactions.
They also cover template validation, snapshot metadata, optional correlation,
parent-transaction ownership, SDK failures, serialized errors, and concurrent
task-context isolation.
The Python tests run inside the actual runner image, not the Mac's interpreter.

Import [smoke-workflow.json](./smoke-workflow.json) into this n8n instance and run
it. Its native Python Code node requires no additional module permissions and
returns:

```json
{
  "result": 5,
  "sum": 17,
  "squares": [4, 9, 25, 49],
  "runner": "python"
}
```

Check the Python agent log under `/tmp/appd/logs` in the runner container for:

```text
[appdynamics-python] Controller configuration received.
```

Then check the Python tier/node and the transaction named by your template in
AppDynamics (or the upstream BT when correlated).
A healthy launcher or successful workflow by itself is not proof of agent
registration. The launcher may omit runner stdout at its default log level;
use the agent log for this check. Proxy logs are available through
`docker compose logs appd-proxy`.

To validate optional correlation, execute a workflow with Python Code nodes and
inspect the corresponding cross-tier transaction segments in AppDynamics.
Also verify that disabling correlation leaves independently named Python
transactions available. A missing continuation may use the documented
independent-transaction fallback; correlation is not guaranteed for every task.

### References

- [n8n task runners](https://docs.n8n.io/hosting/configuration/task-runners/)
- [AppDynamics Python supported environments](https://help.splunk.com/en/appdynamics-saas/application-performance-monitoring/26.7.0/install-app-server-agents/python-agent/python-supported-environments)
- [Starting the Python proxy manually](https://help.splunk.com/en/appdynamics-on-premises/application-performance-monitoring/25.12.0/install-app-server-agents/python-agent/start-the-python-agent-proxy-manually)
