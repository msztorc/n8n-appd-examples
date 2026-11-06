const enabled = process.env.N8N_APPDYNAMICS_ENABLED ?? 'true';

if (enabled !== 'true' && enabled !== 'false') {
    throw new Error('N8N_APPDYNAMICS_ENABLED must be "true" or "false".');
}

if (enabled === 'false') {
    console.info(`[appdynamics-shim] Instrumentation disabled (pid ${process.pid}).`);
} else {
    console.info(`[appdynamics-shim] Preloading agent (pid ${process.pid}).`);
    require('appdynamics').profile({
        debug: true,
        reuseNode: true,
        reuseNodePrefix: process.env.APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX,
        tierName: process.env.APPDYNAMICS_AGENT_TIER_NAME
    });
}
