const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'shim.js'), 'utf8');
const runner = '/usr/local/lib/node_modules/n8n/node_modules/.pnpm/runner/node_modules/@n8n/task-runner/dist/start.js';
const shim = '/opt/appdynamics/shim.js';

test('stock shim initializes the main agent without runner hooks', () => {
    const profiles = [];
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'shim.orig.js'), 'utf8'), {
        process: { env: { APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX: 'main-prefix' } },
        require(name) {
            assert.equal(name, 'appdynamics');
            return { profile(config) { profiles.push(config); } };
        }
    });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].reuseNodePrefix, 'main-prefix');
    assert.equal(profiles[0].reuseNode, true);
});

function loadShim({ entrypoint = '/usr/local/bin/n8n', env = {} } = {}) {
    const calls = [];
    const profiles = [];
    const child = {};
    const originalSpawn = function (...args) {
        calls.push({ receiver: this, args });
        return child;
    };
    const childProcess = { spawn: originalSpawn };
    vm.runInNewContext(source, {
        __filename: shim,
        console: { info() {} },
        process: {
            argv: ['/usr/local/bin/node', entrypoint],
            execPath: '/usr/local/bin/node',
            pid: 123,
            env
        },
        require(name) {
            if (name === 'node:child_process') return childProcess;
            if (name === 'appdynamics') {
                return { profile(config) { profiles.push(config); } };
            }
            throw new Error(`Unexpected module: ${name}`);
        }
    });
    return { calls, profiles, child, childProcess, originalSpawn };
}

test('uses standard environment settings for main and ignores runner overrides', () => {
    const state = loadShim({
        env: {
            APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX: 'custom-app',
            APPDYNAMICS_AGENT_TIER_NAME: 'app-tier',
            N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX: 'custom-runner',
            N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME: 'runner-tier'
        }
    });
    assert.equal(state.profiles[0].reuseNodePrefix, 'custom-app');
    assert.equal(state.profiles[0].tierName, 'app-tier');
    assert.equal(state.profiles[0].nodeName, undefined);
    assert.equal(state.profiles[0].reuseNode, true);
    assert.equal(state.childProcess.spawn, state.originalSpawn);
});

test('recognizes the runner, uses its standard environment, and does not install a nested hook', () => {
    const state = loadShim({
        entrypoint: runner,
        env: {
            N8N_APPDYNAMICS_INTERNAL_RUNNER_ENABLED: 'true',
            APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX: 'custom-runner',
            APPDYNAMICS_AGENT_TIER_NAME: 'runner-tier'
        }
    });
    assert.equal(state.profiles[0].reuseNodePrefix, 'custom-runner');
    assert.equal(state.profiles[0].tierName, 'runner-tier');
    assert.equal(state.profiles[0].reuseNode, true);
    assert.equal(state.profiles[0].nodeName, undefined);
    assert.equal(state.childProcess.spawn, state.originalSpawn);
});

for (const { name, overrides, prefix, tier } of [
    { name: 'unset overrides', overrides: {}, prefix: 'shared-app', tier: 'shared-tier' },
    {
        name: 'empty overrides',
        overrides: {
            N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX: '',
            N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME: ''
        },
        prefix: 'shared-app',
        tier: 'shared-tier'
    },
    {
        name: 'prefix override only',
        overrides: { N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX: 'custom-runner' },
        prefix: 'custom-runner',
        tier: 'shared-tier'
    },
    {
        name: 'tier override only',
        overrides: { N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME: 'runner-tier' },
        prefix: 'shared-app',
        tier: 'runner-tier'
    },
    {
        name: 'both overrides',
        overrides: {
            N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX: 'custom-runner',
            N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME: 'runner-tier'
        },
        prefix: 'custom-runner',
        tier: 'runner-tier'
    }
]) {
    test(`passes effective runner naming settings through spawn and preload: ${name}`, () => {
        const state = loadShim({
            env: {
                N8N_APPDYNAMICS_INTERNAL_RUNNER_ENABLED: 'true',
                APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX: 'shared-app',
                APPDYNAMICS_AGENT_TIER_NAME: 'shared-tier',
                ...overrides
            }
        });
        state.childProcess.spawn('node', [runner], { env: {} });
        const runnerEnv = state.calls[0].args[2].env;
        assert.equal(runnerEnv.APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX, prefix);
        assert.equal(runnerEnv.APPDYNAMICS_AGENT_TIER_NAME, tier);
        assert.equal(runnerEnv.N8N_APPDYNAMICS_TASK_RUNNER_REUSE_NODE_NAME_PREFIX, undefined);
        assert.equal(runnerEnv.N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME, undefined);
        const runnerState = loadShim({ entrypoint: runner, env: runnerEnv });
        assert.equal(runnerState.profiles[0].reuseNodePrefix, prefix);
        assert.equal(runnerState.profiles[0].tierName, tier);
        assert.equal(state.profiles[0].reuseNodePrefix, 'shared-app');
        assert.equal(state.profiles[0].tierName, 'shared-tier');
    });
}

test('does not invent naming defaults when standard environment settings are absent', () => {
    const state = loadShim();
    assert.equal(state.profiles[0].reuseNodePrefix, undefined);
    assert.equal(state.profiles[0].tierName, undefined);
});

test('forwards only instrumentation settings and preserves runner options', () => {
    const state = loadShim({
        env: {
            N8N_APPDYNAMICS_INTERNAL_RUNNER_ENABLED: 'true',
            NODE_OPTIONS: '--trace-warnings',
            APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY: 'test-key',
            APPDYNAMICS_AGENT_TIER_NAME: 'main-tier',
            LIBC: 'musl',
            NODE_EXTRA_CA_CERTS: '/opt/certs/corporate-ca.pem',
            DB_POSTGRESDB_PASSWORD: 'must-not-inherit',
            N8N_ENCRYPTION_KEY: 'must-not-inherit'
        }
    });
    const env = Object.freeze({
        NODE_OPTIONS: '--max-old-space-size=256',
        APPDYNAMICS_AGENT_TIER_NAME: 'runner-tier',
        N8N_RUNNERS_GRANT_TOKEN: 'test-grant'
    });
    const options = Object.freeze({ env, stdio: 'pipe' });
    const args = ['--disallow-code-generation-from-strings', '--disable-proto=delete', runner];
    assert.equal(state.childProcess.spawn('node', args, options), state.child);
    const call = state.calls[0];
    assert.equal(call.receiver, state.childProcess);
    assert.deepEqual(Array.from(call.args[1]), ['--require', shim, ...args]);
    assert.equal(call.args[2].stdio, 'pipe');
    assert.notEqual(call.args[2], options);
    const forwarded = call.args[2].env;
    assert.equal(forwarded.NODE_OPTIONS, '--max-old-space-size=256');
    assert.equal(forwarded.APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY, 'test-key');
    assert.equal(forwarded.APPDYNAMICS_AGENT_TIER_NAME, 'runner-tier');
    assert.equal(forwarded.LIBC, 'musl');
    assert.equal(forwarded.NODE_EXTRA_CA_CERTS, '/opt/certs/corporate-ca.pem');
    assert.equal(forwarded.N8N_RUNNERS_GRANT_TOKEN, 'test-grant');
    assert.equal(forwarded.DB_POSTGRESDB_PASSWORD, undefined);
    assert.equal(forwarded.N8N_ENCRYPTION_KEY, undefined);
    assert.equal(forwarded.N8N_APPDYNAMICS_INTERNAL_RUNNER_ENABLED, undefined);
});

test('adds preload without a memory override and accepts the absolute node executable', () => {
    const state = loadShim({ env: { N8N_APPDYNAMICS_INTERNAL_RUNNER_ENABLED: 'true' } });
    state.childProcess.spawn('/usr/local/bin/node', [runner], { env: {} });
    assert.deepEqual(Array.from(state.calls[0].args[1]), ['--require', shim, runner]);
    assert.equal(state.calls[0].args[2].env.NODE_OPTIONS, undefined);
});

test('leaves unrelated commands and spawn overloads unchanged', () => {
    const state = loadShim({ env: { N8N_APPDYNAMICS_INTERNAL_RUNNER_ENABLED: 'true' } });
    const invocations = [
        ['node', ['/app/start.js'], { env: {} }],
        ['node', ['/app/task-runner.js'], { env: {} }],
        ['python', [runner], { env: {} }],
        ['node', { env: {} }],
        ['node']
    ];
    for (const invocation of invocations) {
        state.childProcess.spawn(...invocation);
        assert.deepEqual(state.calls.at(-1).args, invocation);
    }
});

test('fails explicitly if n8n changes the expected runner environment contract', () => {
    const state = loadShim({ env: { N8N_APPDYNAMICS_INTERNAL_RUNNER_ENABLED: 'true' } });
    assert.throws(
        () => state.childProcess.spawn('node', [runner]),
        /Expected an explicit internal runner environment/
    );
    assert.equal(state.calls.length, 0);
});
