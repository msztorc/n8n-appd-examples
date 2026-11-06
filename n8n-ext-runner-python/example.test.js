const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseEnv } = require('node:util');
const vm = require('node:vm');
const test = require('node:test');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'n8n-task-runners.json'), 'utf8'));
const shim = fs.readFileSync(path.join(__dirname, 'shim.js'), 'utf8');

test('launcher enables only Python and retains isolated secure execution', () => {
    assert.equal(config['task-runners'].length, 1);
    const runner = config['task-runners'][0];
    assert.equal(runner['runner-type'], 'python');
    assert.deepEqual(runner.args, ['-I', '-B', '-X', 'disable_remote_debug', '/opt/runner/bootstrap.py']);
    assert.equal(runner['env-overrides'].N8N_RUNNERS_INSECURE_MODE, 'false');
    assert.equal(runner['env-overrides'].N8N_RUNNERS_STDLIB_ALLOW, '');
    assert.equal(runner['env-overrides'].N8N_RUNNERS_EXTERNAL_ALLOW, '');
    assert.ok(!runner['allowed-env'].includes('N8N_RUNNERS_AUTH_TOKEN'));
    assert.ok(!runner['allowed-env'].includes('NODE_OPTIONS'));
});

test('launcher forwards Python Controller, naming, and proxy settings', () => {
    for (const name of [
        'APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY',
        'APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX',
        'APPDYNAMICS_AGENT_TIER_NAME',
        'APPDYNAMICS_TCP_COMM_HOST',
        'APPDYNAMICS_TCP_COMM_PORT',
        'APPDYNAMICS_CONTROLLER_SSL_CERTFILE'
    ]) {
        assert.ok(config['task-runners'][0]['allowed-env'].includes(name), name);
    }
});

test('main Node shim passes through standard tier and prefix', () => {
    let options;
    vm.runInNewContext(shim, {
        process: { pid: 1, env: {
            APPDYNAMICS_AGENT_TIER_NAME: 'main-tier',
            APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX: 'main-prefix'
        } },
        console: { info() {} },
        require(name) {
            if (name === '/opt/n8n-appdynamics/task-instrumentation.js') return { install() {} };
            assert.equal(name, 'appdynamics');
            return { profile(value) { options = value; } };
        }
    });
    assert.equal(options.tierName, 'main-tier');
    assert.equal(options.reuseNodePrefix, 'main-prefix');
    assert.equal(options.reuseNode, true);
});

test('disabled Node instrumentation does not load the agent', () => {
    vm.runInNewContext(shim, {
        process: { pid: 1, env: { N8N_APPDYNAMICS_ENABLED: 'false' } },
        console: { info() {} },
        require() { assert.fail('Agent must not load'); }
    });
});

test('invalid instrumentation setting fails explicitly', () => {
    assert.throws(() => vm.runInNewContext(shim, {
        process: { env: { N8N_APPDYNAMICS_ENABLED: 'yes' } }
    }), /must be "true" or "false"/);
});

test('setup creates isolated secrets, copies only connection settings, and refuses overwrites', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-python-example-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const file of ['setup-env.js', '.env.example']) {
        fs.copyFileSync(path.join(__dirname, file), path.join(directory, file));
    }
    const source = path.join(directory, 'source');
    fs.mkdirSync(path.join(source, 'certs'), { recursive: true });
    fs.writeFileSync(path.join(source, 'certs/corporate-ca.pem'), 'test-certificate');
    fs.writeFileSync(path.join(source, '.env'), [
        'APPDYNAMICS_AGENT_ACCOUNT_NAME=test-account',
        'APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY=test-key',
        'APPDYNAMICS_CONTROLLER_HOST_NAME=controller.invalid',
        'APPDYNAMICS_CONTROLLER_PORT=8443',
        'APPDYNAMICS_CONTROLLER_SSL_ENABLED=false',
        'APPDYNAMICS_AGENT_APPLICATION_NAME=do-not-copy',
        'APPDYNAMICS_AGENT_NODE_NAME=do-not-copy',
        'APPDYNAMICS_AGENT_TIER_NAME=do-not-copy',
        'POSTGRES_PASSWORD=original-database-secret',
        'N8N_ENCRYPTION_KEY=original-encryption-secret',
        'N8N_RUNNERS_AUTH_TOKEN=original-broker-secret',
        'N8N_VERSION=1.0.0'
    ].join('\n'));
    const args = [path.join(directory, 'setup-env.js'), path.join(source, '.env')];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const target = path.join(directory, '.env');
    const content = fs.readFileSync(target, 'utf8');
    const values = parseEnv(content);
    assert.equal(values.APPD_INIT_IMAGE, 'docker.io/appdynamics/nodejs-agent:latest');
    assert.equal(values.APPD_PYTHON_PROXY_IMAGE, 'docker.io/appdynamics/dl-proxy:26.7.2');
    const secrets = ['POSTGRES_PASSWORD', 'N8N_ENCRYPTION_KEY', 'N8N_RUNNERS_AUTH_TOKEN'].map(key => values[key]);
    secrets.forEach(value => assert.match(value, /^[a-f0-9]{64}$/));
    assert.equal(new Set(secrets).size, 3);
    assert.equal(values.APPDYNAMICS_AGENT_ACCOUNT_NAME, 'test-account');
    assert.equal(values.APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY, 'test-key');
    assert.equal(values.APPDYNAMICS_CONTROLLER_HOST_NAME, 'controller.invalid');
    assert.equal(values.APPDYNAMICS_CONTROLLER_PORT, '8443');
    assert.equal(values.APPDYNAMICS_CONTROLLER_SSL_ENABLED, 'false');
    assert.equal(values.APPDYNAMICS_AGENT_APPLICATION_NAME, 'n8n-ext-runner-python');
    assert.equal(values.APPDYNAMICS_AGENT_NODE_NAME, 'n8n-node');
    assert.equal(values.APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX, 'n8n-node');
    assert.equal(values.APPDYNAMICS_AGENT_TIER_NAME, 'n8n-node');
    assert.equal(values.N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME, 'n8n-runner');
    assert.equal(values.N8N_VERSION, '2.45.5');
    assert.equal(values.N8N_HTTP_PORT, '5678');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(directory, 'certs/corporate-ca.pem'), 'utf8'), 'test-certificate');
    const repeated = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /refusing to overwrite/);
    assert.equal(fs.readFileSync(target, 'utf8'), content);
});

test('smoke workflow requests the native Python runner', () => {
    const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, 'smoke-workflow.json'), 'utf8'));
    const code = workflow.nodes.find(node => node.type === 'n8n-nodes-base.code');
    assert.equal(code.parameters.language, 'pythonNative');
    assert.equal(code.parameters.mode, 'runOnceForAllItems');
    assert.ok(!('jsCode' in code.parameters));
});

test('legacy source keys fail explicitly before creating configuration', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-python-legacy-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const file of ['setup-env.js', '.env.example']) {
        fs.copyFileSync(path.join(__dirname, file), path.join(directory, file));
    }
    const source = path.join(directory, 'source.env');
    fs.writeFileSync(source, 'APPD_ACCOUNT_NAME=test');
    const result = spawnSync(process.execPath, [path.join(directory, 'setup-env.js'), source], {
        encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy AppDynamics connection names/);
    assert.equal(fs.existsSync(path.join(directory, '.env')), false);
});
