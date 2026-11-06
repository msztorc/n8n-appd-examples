const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseEnv } = require('node:util');
const { test } = require('node:test');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-external-setup-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const name of ['setup-env.js', '.env.example']) {
        fs.copyFileSync(path.join(__dirname, name), path.join(directory, name));
    }
    return directory;
}

function setup(directory, source) {
    return spawnSync(process.execPath, [
        path.join(directory, 'setup-env.js'),
        ...(source ? [source] : [])
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
}

test('generates distinct secrets, restricts permissions, and refuses to overwrite them', t => {
    const directory = fixture(t);
    const result = setup(directory);
    assert.equal(result.status, 0, result.stderr);
    const target = path.join(directory, '.env');
    const original = fs.readFileSync(target, 'utf8');
    const env = parseEnv(original);
    assert.equal(env.APPD_INIT_IMAGE, 'docker.io/appdynamics/nodejs-agent:latest');
    const secrets = [env.POSTGRES_PASSWORD, env.N8N_ENCRYPTION_KEY, env.N8N_RUNNERS_AUTH_TOKEN];
    secrets.forEach(value => assert.match(value, /^[a-f0-9]{64}$/));
    assert.equal(new Set(secrets).size, 3);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.notEqual(setup(directory).status, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('copies only agent connection settings and CA while preserving the source', t => {
    const directory = fixture(t);
    const sourceDirectory = path.join(directory, 'source');
    fs.mkdirSync(path.join(sourceDirectory, 'certs'), { recursive: true });
    const source = path.join(sourceDirectory, '.env');
    const original = [
        'APPD_INIT_IMAGE=docker.io/appdynamics/nodejs-agent:test-override',
        "APPDYNAMICS_AGENT_ACCOUNT_NAME='test-account'",
        "APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY='test$key'",
        'APPDYNAMICS_CONTROLLER_HOST_NAME=controller.invalid',
        'APPDYNAMICS_CONTROLLER_PORT=8443',
        'APPDYNAMICS_CONTROLLER_SSL_ENABLED=false',
        'APPDYNAMICS_AGENT_APPLICATION_NAME=do-not-copy',
        'APPDYNAMICS_AGENT_NODE_NAME=do-not-copy',
        'APPDYNAMICS_AGENT_TIER_NAME=do-not-copy',
        'POSTGRES_PASSWORD=do-not-copy',
        'N8N_ENCRYPTION_KEY=do-not-copy',
        'N8N_RUNNERS_AUTH_TOKEN=do-not-copy',
        'N8N_VERSION=do-not-copy'
    ].join('\n');
    fs.writeFileSync(source, original);
    fs.writeFileSync(path.join(sourceDirectory, 'certs/corporate-ca.pem'), 'test certificate');
    const result = setup(directory, source);
    assert.equal(result.status, 0, result.stderr);
    const env = parseEnv(fs.readFileSync(path.join(directory, '.env'), 'utf8'));
    assert.equal(env.APPD_INIT_IMAGE, 'docker.io/appdynamics/nodejs-agent:test-override');
    assert.equal(env.APPDYNAMICS_AGENT_ACCOUNT_NAME, 'test-account');
    assert.equal(env.APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY, 'test$key');
    assert.equal(env.APPDYNAMICS_CONTROLLER_HOST_NAME, 'controller.invalid');
    assert.equal(env.APPDYNAMICS_CONTROLLER_PORT, '8443');
    assert.equal(env.APPDYNAMICS_CONTROLLER_SSL_ENABLED, 'false');
    assert.equal(env.APPDYNAMICS_AGENT_APPLICATION_NAME, 'n8n-ext-runner-nodejs');
    assert.equal(env.APPDYNAMICS_AGENT_NODE_NAME, 'n8n-node');
    assert.equal(env.APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX, 'n8n-node');
    assert.equal(env.APPDYNAMICS_AGENT_TIER_NAME, 'n8n-node');
    assert.equal(env.N8N_APPDYNAMICS_TASK_RUNNER_TIER_NAME, 'n8n-runner');
    assert.notEqual(env.POSTGRES_PASSWORD, 'do-not-copy');
    assert.notEqual(env.N8N_ENCRYPTION_KEY, 'do-not-copy');
    assert.notEqual(env.N8N_RUNNERS_AUTH_TOKEN, 'do-not-copy');
    assert.equal(env.N8N_VERSION, '2.45.5');
    assert.equal(fs.readFileSync(source, 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(directory, 'certs/corporate-ca.pem'), 'utf8'), 'test certificate');
});

test('missing source CA fails before creating configuration', t => {
    const directory = fixture(t);
    const source = path.join(directory, 'source.env');
    fs.writeFileSync(source, 'APPDYNAMICS_AGENT_ACCOUNT_NAME=test');
    assert.notEqual(setup(directory, source).status, 0);
    assert.equal(fs.existsSync(path.join(directory, '.env')), false);
});

test('legacy source keys fail explicitly before creating configuration', t => {
    const directory = fixture(t);
    const source = path.join(directory, 'source.env');
    fs.writeFileSync(source, 'APPD_ACCOUNT_NAME=test');
    const result = setup(directory, source);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy AppDynamics connection names/);
    assert.equal(fs.existsSync(path.join(directory, '.env')), false);
});
