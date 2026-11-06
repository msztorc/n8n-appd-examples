const Module = require('node:module');

const DEFAULT_TEMPLATE = 'n8n/{workflow_name}/{node_name}';
const fields = {
    workflow_name: 'workflowName',
    workflow_id: 'workflowId',
    node_name: 'nodeName',
    node_id: 'nodeId'
};

function validateTemplate(template) {
    if (typeof template !== 'string' || !template.trim() ||
        /[{}]/.test(template.replace(/\{(workflow_name|workflow_id|node_name|node_id)\}/g, ''))) {
        throw new Error('Invalid N8N_APPDYNAMICS_BT_NAME_TEMPLATE; supported placeholders: ' +
            Object.keys(fields).join(', '));
    }
    return template;
}

function renderName(template, settings) {
    return template.replace(/\{(\w+)\}/g, (_, key) => {
        const value = settings[fields[key]];
        return typeof value === 'string' && value ? value : 'Unknown';
    });
}

function sdkError(error) {
    if (error === undefined || error instanceof Error) return error;
    // Normalize serialized task errors to Error instances before SDK calls.
    const message = typeof error === 'string' ? error :
        typeof error?.message === 'string' ? error.message : 'Python task failed';
    const normalized = new Error(message);
    if (typeof error?.name === 'string') normalized.name = error.name;
    return normalized;
}

function wrapStartTask(original, agent, { template = DEFAULT_TEMPLATE, warn = console.warn } = {}) {
    validateTemplate(template);
    const warning = (reason) => warn(`[appdynamics-task] ${reason}; n8n task behavior is unchanged.`);

    return function (...args) {
        if (args[1] !== 'python') return original.apply(this, args);
        const receiver = this;
        const settings = args[2];
        if (!settings || typeof settings !== 'object' || '__appdynamics' in settings) {
            warning('Cannot attach correlation metadata to these settings');
            return original.apply(receiver, args);
        }

        const name = renderName(template, settings);
        let pending;
        const run = async (transaction, owned) => {
            let exitCall;
            let failure;
            const metadata = {};
            const executionId = args[0]?.executionId;
            if (typeof executionId === 'string') metadata.executionId = executionId;
            try {
                if (transaction) {
                    exitCall = transaction.startExitCall({
                        exitType: 'EXIT_CUSTOM',
                        backendName: 'n8n-python-runner',
                        identifyingProperties: { VENDOR: 'n8n', TYPE: 'Python task runner' }
                    });
                    const header = transaction.createCorrelationInfo(exitCall);
                    if (typeof header === 'string' && header) metadata.correlationHeader = header;
                }
                if (!metadata.correlationHeader) warning('Correlation is unavailable for this Python task');
            } catch {
                // Only instrumentation errors are optional; never catch the task here.
                warning('Node agent could not create task correlation');
            }

            const forwarded = [...args];
            forwarded[2] = { ...settings, __appdynamics: metadata };
            try {
                const result = await original.apply(receiver, forwarded);
                if (result?.ok === false) failure = result.error;
                return result;
            } catch (error) {
                failure = error;
                throw error;
            } finally {
                if (exitCall) {
                    try { transaction.endExitCall(exitCall, sdkError(failure)); }
                    catch { warning('Node agent could not finish the task exit call'); }
                }
                if (owned) {
                    try { transaction.end(sdkError(failure)); }
                    catch { warning('Node agent could not finish the task transaction'); }
                }
            }
        };

        try {
            const current = agent.getCurrentTransactionTimePromise?.();
            if (current) return run(current, false);
            // The callback keeps only this task operation in the agent's async context.
            agent.startTransaction({ name }, (transaction) => {
                pending = run(transaction, true);
            });
            if (pending) return pending;
        } catch {
            warning('Node agent could not establish a task transaction');
            if (pending) return pending;
        }
        return run(undefined, false);
    };
}

function install(agent, env = process.env) {
    const template = validateTemplate(env.N8N_APPDYNAMICS_BT_NAME_TEMPLATE ?? DEFAULT_TEMPLATE);
    const enabled = env.N8N_APPDYNAMICS_CORRELATION_ENABLED ?? 'true';
    if (enabled !== 'true' && enabled !== 'false') {
        throw new Error('N8N_APPDYNAMICS_CORRELATION_ENABLED must be "true" or "false".');
    }
    if (enabled === 'false') return;
    const load = Module._load;
    const wrapped = new WeakSet();
    Module._load = function (request, parent, isMain) {
        const result = load.apply(this, arguments);
        if (!/(?:^|\/)task-requester(?:\.js)?$/.test(request)) return result;
        const filename = Module._resolveFilename(request, parent, isMain);
        if (!filename.endsWith('/task-runners/task-managers/task-requester.js')) return result;
        const prototype = result.TaskRequester?.prototype;
        if (!prototype || typeof prototype.startTask !== 'function') {
            console.warn('[appdynamics-task] Unsupported n8n task requester; correlation hook not installed.');
        } else if (!wrapped.has(prototype)) {
            prototype.startTask = wrapStartTask(prototype.startTask, agent, { template });
            wrapped.add(prototype);
        }
        return result;
    };
}

module.exports = { DEFAULT_TEMPLATE, validateTemplate, renderName, wrapStartTask, install };
