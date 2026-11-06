const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_TEMPLATE, validateTemplate, renderName, wrapStartTask } = require('./task-instrumentation');

const settings = { workflowName: 'Orders', workflowId: 'w1', nodeName: 'Validate', nodeId: 'n1', items: [] };
const args = [{ executionId: 'e1' }, 'python', settings, 'untouched'];

function fixture() {
    const events = [];
    const txn = {
        startExitCall(info) { events.push(['startExit', info]); return { id: 'exit' }; },
        createCorrelationInfo(exit) { assert.equal(exit.id, 'exit'); return 'opaque-header'; },
        endExitCall(exit, error) { events.push(['endExit', error]); },
        end(error) { events.push(['end', error]); }
    };
    const agent = {
        getCurrentTransactionTimePromise() { return undefined; },
        startTransaction(info, callback) { events.push(['start', info]); callback(txn); return txn; }
    };
    return { events, txn, agent };
}

test('templates support only stable fields and do not evaluate field contents', () => {
    assert.equal(renderName(validateTemplate(DEFAULT_TEMPLATE), settings), 'n8n/Orders/Validate');
    assert.equal(renderName(validateTemplate('{workflow_id}/{node_id}'), settings), 'w1/n1');
    assert.equal(renderName('{node_name}', { nodeName: '{workflow_id}' }), '{workflow_id}');
    for (const invalid of ['', ' ', '{task_id}', '{execution_id}', '{node_name', '{{node_name}}']) {
        assert.throws(() => validateTemplate(invalid), /Invalid/);
    }
});

test('creates a task-only parent, sends metadata without mutating settings, and preserves result', async () => {
    const { events, agent } = fixture();
    const receiver = {};
    const result = { ok: true, result: 5 };
    const wrapped = wrapStartTask(async function (...actual) {
        assert.equal(this, receiver);
        assert.equal(actual[3], 'untouched');
        assert.equal(actual[2].items, settings.items);
        assert.deepEqual(actual[2].__appdynamics, { executionId: 'e1', correlationHeader: 'opaque-header' });
        return result;
    }, agent);
    assert.equal(await wrapped.apply(receiver, args), result);
    assert.ok(!('__appdynamics' in settings));
    assert.deepEqual(events.map(e => e[0]), ['start', 'startExit', 'endExit', 'end']);
    assert.equal(events[0][1].name, 'n8n/Orders/Validate');
});

test('uses but never ends an existing parent', async () => {
    const { agent, txn, events } = fixture();
    agent.getCurrentTransactionTimePromise = () => txn;
    await wrapStartTask(async () => 5, agent)(...args);
    assert.deepEqual(events.map(e => e[0]), ['startExit', 'endExit']);
});

test('reports returned task errors while returning the same result', async () => {
    const { agent, events } = fixture();
    const error = new Error('task error');
    const result = { ok: false, error };
    assert.equal(await wrapStartTask(async () => result, agent)(...args), result);
    assert.equal(events.find(e => e[0] === 'endExit')[1], error);
});

test('preserves task rejection even if agent cleanup fails', async () => {
    const { agent, txn } = fixture();
    const error = new Error('task error');
    const warnings = [];
    txn.endExitCall = () => { throw new Error('SDK error'); };
    txn.end = () => { throw new Error('SDK error'); };
    await assert.rejects(wrapStartTask(async () => { throw error; }, agent, {
        warn: value => warnings.push(value)
    })(...args), actual => actual === error);
    assert.equal(warnings.length, 2);
});

test('normalizes remote errors only for the SDK, preserving returned and rejected errors', async () => {
    for (const rejects of [false, true]) {
        const { agent, txn, events } = fixture();
        const error = Object.freeze({ name: 'SecurityError', message: 'Import is disallowed' });
        const result = { ok: false, error };
        txn.endExitCall = (exit, actual) => {
            assert.ok(actual instanceof Error);
            assert.equal(actual.name, error.name);
            assert.equal(actual.message, error.message);
            assert.equal(typeof actual.stack, 'string');
            events.push(['endExit', actual]);
        };
        const wrapped = wrapStartTask(async () => {
            if (rejects) throw error;
            return result;
        }, agent, { warn: message => assert.fail(message) });
        if (rejects) await assert.rejects(wrapped(...args), actual => actual === error);
        else assert.equal(await wrapped(...args), result);
        assert.ok(events.find(event => event[0] === 'end')[1] instanceof Error);
        assert.ok(!('stack' in error));
    }
});

test('missing or throwing SDK cannot prevent the original task', async () => {
    for (const agent of [
        { startTransaction() {} },
        { getCurrentTransactionTimePromise() { throw new Error('SDK'); } }
    ]) {
        let calls = 0;
        const warnings = [];
        assert.equal(await wrapStartTask(async () => ++calls, agent, {
            warn: value => warnings.push(value)
        })(...args), 1);
        assert.equal(calls, 1);
        assert.ok(warnings.length);
    }
});

test('SDK failure after invoking its callback does not execute the task twice', async () => {
    const { agent, txn } = fixture();
    let calls = 0;
    agent.startTransaction = (info, callback) => { callback(txn); throw new Error('SDK'); };
    assert.equal(await wrapStartTask(async () => ++calls, agent, { warn() {} })(...args), 1);
    assert.equal(calls, 1);
});

test('unrelated task types and existing metadata are left alone', async () => {
    const original = async (...actual) => actual[2];
    const wrapped = wrapStartTask(original, {}, { warn() {} });
    assert.equal(await wrapped({}, 'javascript', settings), settings);
    const custom = { __appdynamics: { existing: true } };
    assert.equal(await wrapped({}, 'python', custom), custom);
});

test('concurrent tasks retain distinct correlation values', async () => {
    let count = 0;
    const agent = {
        startTransaction(info, callback) {
            const id = ++count;
            callback({
                startExitCall() { return {}; },
                createCorrelationInfo() { return `header-${id}`; },
                endExitCall() {},
                end() {}
            });
        }
    };
    const wrapped = wrapStartTask(async (additional, type, actual) => {
        await new Promise(resolve => setTimeout(resolve, actual.nodeName === 'A' ? 10 : 0));
        return [actual.nodeName, actual.__appdynamics.correlationHeader];
    }, agent);
    assert.deepEqual(await Promise.all([
        wrapped({}, 'python', { ...settings, nodeName: 'A' }),
        wrapped({}, 'python', { ...settings, nodeName: 'B' })
    ]), [['A', 'header-1'], ['B', 'header-2']]);
});
