# n8n with external task runners and AppDynamics

A separate local example based on the working
[internal-runner example](../n8n-simple/README.md). It does not change or
reuse that deployment's database, encryption key, containers, or volumes.

> **Educational use only.** Task-runner instrumentation in this example is not
> recommended for production use. It relaxes
> [n8n's JavaScript sandbox protections](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/task-runners)
> for agent compatibility. External process isolation remains in place, but
> does not replace those protections. Run only trusted workflows and code.
> This is a community-created example, not an official integration supported,
> certified, or endorsed by Cisco, Splunk, or AppDynamics, and is provided
> "as is" without warranty.

| Setting | Internal example | This example |
| --- | --- | --- |
| Compose project | `n8n-simple` | `n8n-ext-runner-nodejs` |
| Editor URL | `http://localhost:5678` | `http://localhost:5678` |
| Runner location | Child of n8n | Separate official `n8nio/runners` container |
| AppDynamics application | `n8n-simple` | `n8n-ext-runner-nodejs` |
| Storage | `n8n-simple_*` volumes | `n8n-ext-runner-nodejs_*` volumes |

Both deployments default to port 5678; run one at a time, or assign distinct
`N8N_HTTP_PORT` values to run them concurrently. Only the editor port is published.
The task broker and launcher health ports are internal to the new Compose
networks. PostgreSQL is on a separate internal network that the runner container
does not join. The runner receives no database password or n8n encryption key.

## Setup

Requirements: Bash, Podman with a running machine on macOS/Windows and a Compose
provider (or Docker Compose), and Node.js 20.12+ for setup and isolated tests.

From the parent [n8n-appd-examples directory](../):

```sh
node n8n-ext-runner-nodejs/setup-env.js n8n-simple/.env
./deploy.sh n8n-ext-runner-nodejs config
./build.sh n8n-ext-runner-nodejs
./deploy.sh n8n-ext-runner-nodejs
./deploy.sh n8n-ext-runner-nodejs ps
```

The setup script generates **new** database, encryption, and broker-auth secrets.
When a source environment path is provided, it copies only the AppDynamics connection/image
settings and the sibling `certs/corporate-ca.pem`. It never modifies the source.
The new `.env` is created with mode `0600`, and initialization refuses to overwrite
an existing configuration or certificate. Secrets and the copied CA are ignored
by this example's `.gitignore`. The entire `certs/` directory and private `.env.*`
variants are excluded; `.env.example` remains available for version control.

Without an existing example, run `node n8n-ext-runner-nodejs/setup-env.js`, fill in the AppDynamics
connection values in the new `.env`, and put your CA certificate at
`certs/corporate-ca.pem`. Do not replace existing generated secrets on restart.

Open **http://localhost:5678** and create the new instance's owner account.
This instance does not contain the original deployment's workflows or credentials.

Alternatively, run `podman compose` directly from this directory.
The scripts auto-detect Podman or Docker. Set `CONTAINER_RUNTIME=docker` before
both script commands to explicitly select Docker.

## Starting and stopping independently

The parent [deploy.sh](../deploy.sh) provides:

```sh
./deploy.sh --help
./deploy.sh n8n-ext-runner-nodejs       # start using prepared images
./deploy.sh n8n-ext-runner-nodejs logs  # follow recent logs
./deploy.sh n8n-ext-runner-nodejs stop  # preserve containers and volumes
./deploy.sh n8n-ext-runner-nodejs down  # remove stack, preserve volumes
NODE_OPTIONS= node --test n8n-ext-runner-nodejs/*.test.js
```

Pass `n8n-simple` to operate on the internal example instead. There is no action
that stops both stacks or deletes their volumes. [build.sh](../build.sh) fetches
images; the `config` action validates Compose without printing credentials.

After editing the mounted shim or launcher JSON, recreate the affected services:

```sh
podman compose up -d --no-deps --force-recreate n8n task-runners
```

## How instrumentation is wired

- A one-shot init service copies AppDynamics into this project's own agent volume.
- n8n mounts it read-only and preloads this example's [shim.js](./shim.js).
- The external launcher uses [n8n-task-runners.json](./n8n-task-runners.json).
  Its JavaScript command explicitly preloads the same shim with `--require`.
- The launcher's `allowed-env` list explicitly forwards agent settings, `LIBC`,
  and `NODE_EXTRA_CA_CERTS`. Compose environment settings alone do not bypass
  launcher filtering.
- No `child_process.spawn` patch or runner-entrypoint detection is needed.
- Python retains its default isolated launch flags and is not instrumented by
  this Node.js agent. It does not receive AppDynamics credentials.
- Launcher runners start on demand. `N8N_RUNNERS_AUTO_SHUTDOWN_TIMEOUT=0` keeps a
  started runner alive so it can report agent metrics while idle.

Both n8n images use the same pinned `N8N_VERSION` (currently `2.45.5`). Upgrade
them together, and recheck the launcher config against the matching image.
The JavaScript runtime in the tested runner image is Node `v26.12.1` on Alpine.

The AppDynamics image defaults to `docker.io/appdynamics/nodejs-agent:latest`
through `APPD_INIT_IMAGE`, shared by n8n and the JavaScript runner. Revalidate
instrumentation after pulling updated images; `:latest` does not guarantee
compatibility with the runner sandbox.

### Prefix and tier settings

| Variable | Default |
| --- | --- |
| `APPDYNAMICS_AGENT_APPLICATION_NAME` | `n8n-ext-runner-nodejs` |
| `APPDYNAMICS_AGENT_NODE_NAME` | `n8n-node` |
| `APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX` | `n8n-node` |
| `APPDYNAMICS_AGENT_TIER_NAME` | `n8n-node` |
| `N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX` | Empty; shares the standard prefix |
| `N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME` | `n8n-runner`; empty/unset shares the standard tier |

The runner-specific settings affect only the external runner container, not
n8n's main process. Both profiles enable reuse-node naming, so the Controller
may assign a reused node name rather than the literal configured node name.
All standard AppDynamics connection, naming, SSL, and logging settings are
supplied through the same-named variables in `.env`. See the
[shared environment guide](../README.md#appdynamics-environment-configuration)
for all settings.

## Secure-mode compatibility and the local workaround

n8n's JavaScript sandbox restricts dynamic code generation and prototype
access/mutation. Instrumentation and external libraries that depend on those
features can be incompatible with these restrictions; this is not a limitation
defined by a particular AppDynamics agent version.

The [n8n task-runner environment reference](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/task-runners)
describes `N8N_RUNNERS_INSECURE_MODE` as disabling the runner's security measures
for compatibility with modules using insecure JavaScript features, and
discourages production use. Its `N8N_RUNNERS_ALLOW_PROTOTYPE_MUTATION` entry
gives **Puppeteer** as an example of a library that needs runtime prototype
mutation. See below for why that older setting is not an alternative here.

The default launcher JSON uses the **local-only**
compatibility mode: `N8N_RUNNERS_INSECURE_MODE=true`, with
`--disallow-code-generation-from-strings` and `--disable-proto=delete` omitted
from the JavaScript command. Both changes are required by this setup.
Python's isolated startup is unchanged. The container still uses a read-only
root filesystem, temporary writable `/tmp`, dropped Linux capabilities, and
`no-new-privileges`; these are not replacements for the removed JS safeguards.

`N8N_APPDYNAMICS_RUNNER_ENABLED` controls whether the JavaScript shim attempts to
load the agent. Disabling it does not disable instrumentation in the main n8n
service, and **does not by itself restore secure runner mode**. The main service
always profiles; the shim logs explicitly when runner instrumentation is disabled.

External process isolation does not remove the JavaScript sandbox restrictions.
Validate instrumentation with a real workflow and its captured transactions;
preload logs and task-broker registration alone are not sufficient.

### Why not `N8N_RUNNERS_ALLOW_PROTOTYPE_MUTATION`?

The [environment-variable reference](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/task-runners#task-runner-environment-variables-javascript)
lists this narrower setting, with Puppeteer as its example. However,
[n8n's 1.102.0 breaking-change notes](https://github.com/n8n-io/n8n/blob/n8n%402.45.5/packages/cli/BREAKING-CHANGES.md#11020)
state that it was replaced with `N8N_RUNNERS_INSECURE_MODE`, also naming
Puppeteer as an example. The pinned 2.45.5 runner does not implement the old
variable.

The example uses the documented replacement rather than setting the older
variable. Neither setting should be treated as a production-hardening measure.

### Restoring the default JavaScript protections

To restore the default JavaScript protections while keeping main-process
instrumentation:

1. Set `N8N_APPDYNAMICS_RUNNER_ENABLED=false` in `.env`.
2. In the JavaScript entry of `n8n-task-runners.json`, set
   `env-overrides.N8N_RUNNERS_INSECURE_MODE` to `"false"`.
3. Add `--disallow-code-generation-from-strings` and `--disable-proto=delete`
   before `--require` in that entry's `args`.
4. Recreate `task-runners`. Runner instrumentation with the default sandbox
   protections is outside this example's validated scope.

See the upstream [task-runner setup documentation](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-task-runners/)
and [launcher configuration reference](https://github.com/n8n-io/task-runner-launcher/blob/main/docs/setup.md#config-file).

## Smoke workflow

Import [smoke-workflow.json](./smoke-workflow.json) in the new editor and execute
it manually. The Code node runs JavaScript through the external runner, computes
`2 + 3`, and hashes a fixed string using the default allowed `crypto` module.
It waits ten seconds to exercise asynchronous execution and allow initial agent
communication. The output must contain
`result: 5`. It makes no external requests and uses no saved credentials.

The launcher initially reports that it is waiting for a task offer. Execute a
Code node before expecting a JavaScript runner process or agent node to appear.

## Troubleshooting

- Use `./deploy.sh n8n-ext-runner-nodejs logs` and
  `./deploy.sh n8n-ext-runner-nodejs ps` from the parent directory; do not operate on the
  `n8n-simple` containers to diagnose this example.
- The broker auth token must match in n8n and the launcher. The launcher obtains
  per-runner grants; its long-lived auth token is not forwarded to runner code.
- Health checks do not preload the agent, avoiding diagnostic processes
  registering extra AppDynamics nodes.
- Keep the agent volume read-only; use container logs to inspect initialization
  and reporting.
- `N8N_SECURE_COOKIE=false` is for localhost HTTP testing only. Add HTTPS and
  appropriate authentication/network controls before any non-local deployment.
