const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const examples = ['n8n-simple', 'n8n-ext-runner-nodejs', 'n8n-ext-runner-python'];

function fixture(t, runtimes = ['podman', 'docker']) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-scripts-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'examples with spaces');
    const bin = path.join(directory, 'bin');
    const log = path.join(directory, 'calls.jsonl');
    fs.mkdirSync(root);
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
    for (const file of ['build.sh', 'deploy.sh', 'compose-common.sh']) {
        fs.copyFileSync(path.join(__dirname, file), path.join(root, file));
    }
    for (const example of examples) {
        fs.mkdirSync(path.join(root, example));
        fs.writeFileSync(path.join(root, example, 'compose.yaml'), 'services: {}\n');
    }
    for (const runtime of runtimes) {
        fs.writeFileSync(path.join(bin, runtime), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const runtime = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({runtime, args, cwd: process.cwd()}) + '\\n');
process.exit(JSON.parse(process.env.FAILURES || '{}')[runtime + ' ' + args.join(' ')] || 0);
`, { mode: 0o755 });
    }
    return {
        root,
        run(script, args, overrides = {}) {
            fs.writeFileSync(log, '');
            const result = spawnSync('/bin/bash', [path.join(root, script), ...args], {
                cwd: directory,
                encoding: 'utf8',
                env: { ...process.env, PATH: bin, NODE_OPTIONS: '', CONTAINER_RUNTIME: '',
                    CALL_LOG: log, FAILURES: '{}', ...overrides }
            });
            const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
            return { ...result, calls };
        }
    };
}

test('help needs no runtime and invalid arguments do not call one', (t) => {
    const f = fixture(t, []);
    for (const script of ['build.sh', 'deploy.sh']) {
        const help = f.run(script, ['--help']);
        assert.equal(help.status, 0, help.stderr);
        assert.match(help.stdout, /Usage:/);
        for (const args of [[], ['../n8n-simple'], ['unknown'], [examples[0], 'up', 'extra']]) {
            const result = f.run(script, args);
            assert.equal(result.status, 2, result.stderr);
            assert.deepEqual(result.calls, []);
        }
    }
    assert.equal(f.run('deploy.sh', [examples[0], 'invalid']).status, 2);
    assert.equal(f.run('build.sh', [examples[0], 'extra']).status, 2);
});

test('build prefers Podman, resolves paths independently of cwd, and only prepares images', (t) => {
    const f = fixture(t);
    for (const example of examples) {
        const result = f.run('build.sh', [example]);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.calls.every(call => call.runtime === 'podman' && call.cwd === path.join(f.root, example)));
        const expected = [['info'], ['compose', 'version'], ['compose', 'config', '--quiet']];
        if (example === 'n8n-ext-runner-python') {
            expected.push(['compose', 'pull', '--ignore-buildable'], ['compose', 'build', 'task-runners']);
        } else {
            expected.push(['compose', 'pull']);
        }
        assert.deepEqual(result.calls.map(call => call.args), expected);
    }
});

test('Docker is selected when Podman is not installed', (t) => {
    const result = fixture(t, ['docker']).run('deploy.sh', [examples[0], 'config']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /podman is not installed/);
    assert.ok(result.calls.every(call => call.runtime === 'docker'));
});

test('unreachable Podman or missing Compose causes an explicit fallback', (t) => {
    const f = fixture(t);
    for (const failure of ['podman info', 'podman compose version']) {
        const result = f.run('deploy.sh', [examples[0], 'config'], {
            FAILURES: JSON.stringify({ [failure]: 1 })
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /podman is not reachable|podman Compose is unavailable/);
        assert.equal(result.calls.at(-1).runtime, 'docker');
    }
});

test('explicit runtime selection is honored without fallback', (t) => {
    const f = fixture(t);
    const selected = f.run('deploy.sh', [examples[0], 'ps'], { CONTAINER_RUNTIME: 'docker' });
    assert.equal(selected.status, 0, selected.stderr);
    assert.ok(selected.calls.every(call => call.runtime === 'docker'));
    const failed = f.run('deploy.sh', [examples[0]], {
        CONTAINER_RUNTIME: 'docker', FAILURES: '{"docker info":1}'
    });
    assert.equal(failed.status, 1);
    assert.ok(failed.calls.every(call => call.runtime === 'docker'));
    assert.match(failed.stderr, /No usable container runtime/);
    const invalid = f.run('build.sh', [examples[0]], { CONTAINER_RUNTIME: 'invalid' });
    assert.equal(invalid.status, 2);
    assert.deepEqual(invalid.calls, []);
});

test('no usable runtime fails without deployment', (t) => {
    const result = fixture(t, []).run('deploy.sh', [examples[0]]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No usable container runtime/);
    assert.deepEqual(result.calls, []);
});

test('deployment routes every action and never builds, pulls, or deletes volumes', (t) => {
    const f = fixture(t);
    const actions = {
        up: ['up', '-d', '--no-build', '--pull', 'never'],
        stop: ['stop'], down: ['down'], ps: ['ps'],
        logs: ['logs', '-f', '--tail', '100'], config: ['config', '--quiet']
    };
    for (const example of examples) {
        for (const [action, expected] of Object.entries(actions)) {
            const result = f.run('deploy.sh', action === 'up' ? [example] : [example, action]);
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(result.calls.at(-1).args, ['compose', ...expected]);
            assert.ok(result.calls.every(call => call.cwd === path.join(f.root, example)));
            assert.equal(result.calls.length, action === 'up' ? 4 : 3);
        }
    }
});

test('configuration and image failures stop subsequent commands', (t) => {
    const f = fixture(t);
    for (const [script, failure] of [
        ['build.sh', 'podman compose config --quiet'],
        ['build.sh', 'podman compose pull --ignore-buildable'],
        ['deploy.sh', 'podman compose config --quiet'],
        ['deploy.sh', 'podman compose up -d --no-build --pull never']
    ]) {
        const result = f.run(script, [examples[2]], { FAILURES: JSON.stringify({ [failure]: 23 }) });
        assert.equal(result.status, 23, result.stderr);
        const last = result.calls.at(-1);
        assert.equal(`${last.runtime} ${last.args.join(' ')}`, failure);
        assert.ok(result.calls.every(call => call.runtime === 'podman'));
    }
});
