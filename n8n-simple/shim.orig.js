require("appdynamics").profile({
  debug: true,
  reuseNode: true,
  reuseNodePrefix: process.env.APPDYNAMICS_AGENT_REUSE_NODE_NAME_PREFIX,
  proxyHost: process.env.APPDYNAMICS_PROXY_HOST_NAME,
  proxyPort: process.env.APPDYNAMICS_PROXY_PORT
});