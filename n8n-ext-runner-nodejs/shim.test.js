const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'shim.js'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'n8n-task-runners.json'), 'utf8'));

function loadShim(env) {
    const profiles = [];
    const logs = [];
    vm.runInNewContext(source, {
        process: { env, pid: 123 },
        console: { info(message) { logs.push(message); } },
        require(name) {
            assert.equal(name, 'appdynamics');
            return { profile(options) { profiles.push(options); } };
        }
    });
    return { profiles, logs };
}

test('profiles using standard AppDynamics naming without spawn interception', () => {
    const { profiles } = loadShim({
        APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX: 'runner-prefix',
        APPDYNAMICS_AGENT_TIER_NAME: 'runner-tier'
    });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].reuseNode, true);
    assert.equal(profiles[0].reuseNodePrefix, 'runner-prefix');
    assert.equal(profiles[0].tierName, 'runner-tier');
});

test('disabled instrumentation does not load the agent and reports that state', () => {
    const { profiles, logs } = loadShim({ N8N_APPDYNAMICS_ENABLED: 'false' });
    assert.equal(profiles.length, 0);
    assert.match(logs[0], /Instrumentation disabled/);
});

test('rejects invalid instrumentation toggles', () => {
    assert.throws(() => loadShim({ N8N_APPDYNAMICS_ENABLED: 'yes' }), /must be "true" or "false"/);
});

test('JavaScript launcher explicitly uses the approved local compatibility mode', () => {
    const runner = config['task-runners'].find(r => r['runner-type'] === 'javascript');
    assert.deepEqual(runner.args, [
        '--require',
        '/opt/appdynamics/shim.js',
        '/opt/runners/task-runner-javascript/dist/start.js'
    ]);
    assert.equal(runner['env-overrides'].N8N_RUNNERS_INSECURE_MODE, 'true');
    assert.ok(runner['allowed-env'].includes('LIBC'));
    assert.ok(runner['allowed-env'].includes('NODE_EXTRA_CA_CERTS'));
    assert.ok(runner['allowed-env'].includes('N8N_APPDYNAMICS_ENABLED'));
    assert.ok(!runner['allowed-env'].includes('NODE_OPTIONS'));
    assert.ok(!runner['allowed-env'].includes('N8N_RUNNERS_AUTH_TOKEN'));
    assert.ok(!runner['allowed-env'].some(key => /DB_|PASSWORD|ENCRYPTION_KEY/.test(key)));
});

test('Python retains its isolated startup and receives no Node agent credentials', () => {
    const runner = config['task-runners'].find(r => r['runner-type'] === 'python');
    assert.ok(runner.args.includes('-I'));
    assert.ok(!runner['allowed-env'].some(key => key.startsWith('APPDYNAMICS_')));
});

test('smoke workflow returns the exact expected result using the allowed crypto module', async () => {
    const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, 'smoke-workflow.json'), 'utf8'));
    const code = workflow.nodes.find(node => node.type === 'n8n-nodes-base.code').parameters.jsCode;
    const result = await vm.runInNewContext(`(async () => { ${code} })()`, {
        require(name) {
            assert.equal(name, 'crypto');
            return require('node:crypto');
        },
        setTimeout(callback) { callback(); }
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].json.result, 5);
    assert.equal(result[0].json.checksum, '0ec9d9b46a52342aa89f5559609f9b555b3e72ac6e47a72069ff08428bf36ebc');
});
