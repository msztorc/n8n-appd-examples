function isTaskRunnerScript(script) {
    return typeof script === 'string' &&
        script.endsWith('/@n8n/task-runner/dist/start.js');
}

const isTaskRunner = isTaskRunnerScript(process.argv[1]);
const processRole = isTaskRunner ? 'task-runner' : 'main';

console.info(`[appdynamics-shim] Preloading agent for ${processRole} (pid ${process.pid}).`);
require('appdynamics').profile({
    debug: true,
    reuseNode: true,
    reuseNodePrefix: process.env.APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX,
    tierName: process.env.APPDYNAMICS_AGENT_TIER_NAME,
    proxyHost: process.env.APPDYNAMICS_PROXY_HOST_NAME,
    proxyPort: process.env.APPDYNAMICS_PROXY_PORT
});

if (!isTaskRunner && process.env.N8N_APPDYNAMICS_INTERNAL_RUNNER_ENABLED === 'true') {
    const childProcess = require('node:child_process');
    const spawn = childProcess.spawn;

    // n8n 2.45.5 deliberately constructs a filtered environment for its internal runner.
    childProcess.spawn = function (command, args, options) {
        if ((command !== 'node' && command !== process.execPath) ||
            !Array.isArray(args) || !isTaskRunnerScript(args.at(-1))) {
            return spawn.apply(this, arguments);
        }
        if (!options || !options.env) {
            throw new Error('[appdynamics-shim] Expected an explicit internal runner environment.');
        }

        const env = { ...options.env };
        for (const [key, value] of Object.entries(process.env)) {
            if (key.startsWith('APPDYNAMICS_') ||
                key === 'LIBC' || key === 'NODE_EXTRA_CA_CERTS') {
                if (env[key] === undefined) env[key] = value;
            }
        }
        const overrides = {
            APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX: process.env.N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX,
            APPDYNAMICS_AGENT_TIER_NAME: process.env.N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME
        };
        for (const [key, value] of Object.entries(overrides)) {
            if (value) env[key] = value;
        }

        // Direct flags avoid the agent's NODE_OPTIONS shim.js guard mistaking .pnpm for npm.
        const runnerArgs = ['--require', __filename, ...args];
        console.info('[appdynamics-shim] Applying preload to internal JavaScript task runner.');
        return spawn.call(this, command, runnerArgs, { ...options, env });
    };
}