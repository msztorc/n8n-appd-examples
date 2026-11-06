# Local n8n with Podman Compose

A **local testing-only** deployment with n8n, PostgreSQL, persistent volumes, and AppDynamics Node.js instrumentation. A one-shot init service copies the agent into a volume mounted read-only by n8n. HTTPS and an external domain are not required.

By default, only the **main n8n process** is instrumented: the editor/API server
and other work executed in that process. Internal task runners are not
instrumented and retain n8n's default sandbox protections.

The Compose project name is `n8n-simple`.

## Prerequisites

- Podman installed
- A Compose provider available (`podman compose version`)
- On macOS/Windows, a running Podman machine (`podman machine start`)

## Start

For a new deployment, copy [.env.example](./.env.example) to `.env` with file
permissions `0600`. Populate the Controller connection settings and set separate,
strong random values for `POSTGRES_PASSWORD` and `N8N_ENCRYPTION_KEY`. Place your
CA certificate at `certs/corporate-ca.pem`. Never overwrite an existing
deployment's secrets. Private environment files and everything under `certs/`
are excluded by [.gitignore](./.gitignore); the example template is not ignored.

All AppDynamics settings are read from `.env` using standard agent variable names.
The template sets `APPDYNAMICS_AGENT_APPLICATION_NAME=n8n-simple` and uses
`n8n-node` for the tier, node name, and reuse-node prefix. Set
`APPDYNAMICS_AGENT_ACCOUNT_NAME`, `APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY`, and
`APPDYNAMICS_CONTROLLER_HOST_NAME` for your Controller. See the
[shared environment guide](../README.md#appdynamics-environment-configuration)
for all settings.

The agent image defaults to `docker.io/appdynamics/nodejs-agent:latest` through
`APPD_INIT_IMAGE`. Revalidate instrumentation when pulling an updated image;
the moving tag is not a guarantee of sandbox compatibility.

For the shared build/deploy scripts and a comparison of instrumentation approaches, see
the [parent examples guide](../README.md).

From this directory:

```sh
podman compose config --quiet
podman compose pull
podman compose up -d
podman compose ps
```

Visit **http://localhost:5678** and create your n8n owner account.
All three examples default to port 5678. Run only one at a time, or override
`N8N_HTTP_PORT` for deployments that should run concurrently.

## Troubleshooting and inspection

The one-shot init service invokes `cp` directly and runs as `0:0` to populate
the named agent volume. n8n runs as a non-root user and mounts that volume
read-only.

The n8n service sets `LIBC: musl` to match its Alpine runtime. Keep this setting
alongside the `NODE_OPTIONS` preload. Review the libc setting if switching to a
glibc-based image such as Debian, and validate instrumentation after image updates.

```sh
podman compose logs -f n8n
podman compose exec n8n node --version
podman compose exec n8n printenv NODE_OPTIONS
podman compose exec n8n sh -c "cat /proc/1/cmdline | tr '\000' ' '; echo"
```

## Stop and reset

```sh
podman compose stop       # stop, preserving data
podman compose up -d      # start again
podman compose down       # remove containers and network, preserve volumes
podman compose down -v    # DELETE ALL local n8n and PostgreSQL data
```

## NODE_OPTIONS

The Compose file sets the preload directly on the n8n service:

```text
NODE_OPTIONS=--require /opt/appdynamics/shim.js
```

By default this loads the **stock shim from the agent volume**, not the custom
local shim. [shim.orig.js](./shim.orig.js) is an unmodified reference copy of
`/opt/appdynamics/shim.js` from an agent image; it is not bind-mounted or
automatically refreshed when `:latest` changes. See
[Third-party notices](../THIRD_PARTY_NOTICES.md) for its original image version
and licensing scope. The stock shim initializes the main agent without a
runner spawn hook.

The custom [shim.js](./shim.js) is retained for optional runner instrumentation,
but its bind mount is commented out in Compose. The insecure-mode setting and
custom runner environment settings are also commented out.

The init service must complete successfully before n8n starts. Changing
`NODE_OPTIONS` in `.env` alone does not override this explicit Compose setting.

### Optional internal JavaScript task runner instrumentation

n8n 2.45.5 starts its internal JavaScript runner with a filtered environment.
It does not inherit the parent's `NODE_OPTIONS`, `APPDYNAMICS_*`, `LIBC`, or
`NODE_EXTRA_CA_CERTS`. Its memory limit can also set a separate `NODE_OPTIONS`.

The following describes the retained **opt-in** setup, not the default. To enable
it for trusted local testing, uncomment the custom shim bind mount and all four
settings in the optional runner-instrumentation environment block, then recreate
n8n. This includes `N8N_RUNNERS_INSECURE_MODE: "true"`, with the limitations below.

The custom shim enables a version-dependent hook with
`N8N_APPDYNAMICS_INTERNAL_RUNNER_ENABLED: "true"` (a setting for this shim,
not a built-in n8n option). The hook only intercepts Node launches ending in
`/@n8n/task-runner/dist/start.js`. It adds `--require /opt/appdynamics/shim.js`
directly to Node's command-line arguments and forwards
`APPDYNAMICS_*`, `LIBC`, and `NODE_EXTRA_CA_CERTS`, preserving the runner's
existing environment, memory options, and security flags. It does not forward
the full parent environment, such as database credentials or the encryption key.
AppDynamics credentials are intentionally made available to the runner.

The runner preload is supplied through an explicit command-line flag,
independently of the parent's `NODE_OPTIONS`. The runner's `NODE_OPTIONS`
remains available for n8n-managed memory settings.

The shim recognizes the runner by its entrypoint, not its later process title.
Both processes use `reuseNode: true`. Names are configured through environment
variables, not hardcoded in the shim:

| Environment variable | Purpose | Value when optional setup is enabled |
| --- | --- | --- |
| `APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX` | Standard prefix for the main process and runner unless overridden. | `n8n-node` |
| `APPDYNAMICS_AGENT_NODE_NAME` | Standard configured node name; reuse mode assigns the actual displayed name. | `n8n-node` |
| `APPDYNAMICS_AGENT_TIER_NAME` | Standard tier for the main process and runner unless overridden. | `n8n-node` |
| `N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX` | Optional runner-only prefix override. | Empty (shared prefix) |
| `N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME` | Optional runner-only tier override. | `n8n-runner` from `.env.example` |

The two `N8N_APPDYNAMICS_TASK_RUNNER_*` settings belong to this shim, not n8n or
the agent. A nonempty override is copied to the corresponding standard
`APPDYNAMICS_AGENT_*` variable in the child environment only. Unset or empty
overrides leave the standard settings intact. Prefix and tier are independent;
no additional enable/disable booleans are needed.

The optional setup uses a separate runner tier. To share both prefix and tier
when that setup is enabled, set this in `.env`:

```dotenv
APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX=n8n-node
APPDYNAMICS_AGENT_TIER_NAME=n8n-node
N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX=
N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME=
```

To separate the runner again, set either or both overrides:

```dotenv
N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX=n8n-runner
N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME=n8n-runner
```

Recreate n8n after changing these values. The shim does not override
`APPDYNAMICS_AGENT_NODE_NAME`; the agent and Controller assign reused names.
Startup logs prefixed with `[appdynamics-shim]` identify the process role and PID,
independently of the Controller's assigned node names.
Python runners are not instrumented by this Node.js shim.

**n8n JavaScript sandbox compatibility limitation:**

n8n's JavaScript runner restricts dynamic code generation and prototype access
and mutation. These protections can conflict with instrumentation and external
libraries; the limitation is not specific to one AppDynamics agent version.
The [n8n task-runner environment reference](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/task-runners)
documents both:

- `N8N_RUNNERS_INSECURE_MODE`: disables the runner's security measures for
  compatibility with modules that rely on insecure JavaScript features.
  n8n discourages this mode for production use.
- `N8N_RUNNERS_ALLOW_PROTOTYPE_MUTATION`: describes libraries that need runtime
  prototype mutation, with **Puppeteer** as the example, at the cost of relaxing
  security. This older setting is not a working alternative in the pinned n8n
  release; see [the setting's replacement](../n8n-ext-runner-nodejs/README.md#why-not-n8n_runners_allow_prototype_mutation).

Preloading or Controller registration alone does not prove that instrumentation
works; validate a real workflow and its captured transactions. See
[Keeping the default runner protections](#keeping-the-default-runner-protections)
for main-process-only instrumentation without relaxing the runner sandbox.

For optional local compatibility testing, Compose retains a commented
`N8N_RUNNERS_INSECURE_MODE: "true"` setting. Enabling it asks n8n to relax its JavaScript
runner sandbox protections, including omitting its restrictive Node startup
flags. **Only run trusted workflows/code in this mode; do not use this setting
for a production or shared deployment.**
To return to the default main-only instrumentation, comment out the custom shim
mount and all four optional runner environment settings, then recreate n8n.
Verify agent initialization and Controller registration separately from the
runner's connection to n8n's task broker.

Insecure mode addresses the runner-security compatibility blocker, not agent
naming: a different reuse-node prefix does not remove the sandbox restrictions.
It is a local workaround, not a security-preserving fix.

#### Keeping the default runner protections

The default configuration already retains the JavaScript protections. If you
previously enabled the optional setup, comment out its custom shim mount and
runner environment block, then recreate n8n; main-process profiling remains
enabled. Runner instrumentation with the default sandbox protections is outside
this example's validated scope.
[External runners](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-task-runners/)
are recommended by n8n for production isolation, but a separate container does
not remove the JavaScript sandbox restrictions or make insecure mode suitable
for production.
See also the [runner security settings](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/task-runners).

After changing the shim or enabling the hook, recreate n8n:

```sh
podman compose up -d --no-deps --force-recreate n8n
```

This hook depends on n8n's internal launch implementation. Revalidate it after
upgrades, pin the n8n image for reproducibility, and prefer an external runner
with explicit instrumentation configuration for a long-term deployment. Keep
the optional mount and runner environment block commented for the default
main-process-only profiling.

Run the shim's isolated tests without loading the real agent:

```sh
NODE_OPTIONS= node --test shim.test.js
```

## Notes

- PostgreSQL is not exposed to the host.
- n8n is bound to `127.0.0.1:5678` (local-only).
- `.env` has example **development-only** secrets. Generate a stronger stable encryption key with `openssl rand -hex 32` if desired; do not rotate it once credentials have been saved.
- n8n defaults to the pinned `2.45.5` image tag. Set `N8N_VERSION` explicitly and
  revalidate instrumentation when upgrading.
- External webhook services cannot call `localhost` without a tunnel.
- If the Compose provider has trouble waiting for PostgreSQL health, run `podman compose up -d postgres`, wait until healthy, and then `podman compose up -d`.
