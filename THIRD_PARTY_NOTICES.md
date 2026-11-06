# Third-party notices

The [MIT license](./LICENSE) covers the original deployment configuration,
scripts, custom instrumentation adapters, tests, and documentation in this
project. It does not relicense third-party software or materials.

## AppDynamics initialization reference

[n8n-simple/shim.orig.js](./n8n-simple/shim.orig.js) is an unmodified reference
copy of `/opt/appdynamics/shim.js` from the
`appdynamics/nodejs-agent:26.10.2` container image. It contains initialization
configuration, not the agent implementation. The default deployment loads the
shim supplied by the agent image rather than mounting this reference copy.

Cisco documents the same `require("appdynamics").profile(...)` initialization
pattern in [Install AppDynamics Node.js Agent](https://www.cisco.com/c/en/us/support/docs/security/endpoint-security-analytics-built-on-splunk/223128-install-appdynamics-node-js-agent.html).

The AppDynamics npm package version 26.10.2 declares its license as
`SEE LICENSE IN https://legal.appdynamics.com/SaaSandOnPremise_EULA.pdf`.
The reference copy is not relicensed under this project's MIT license.
Public documentation of an API pattern does not establish an independent
redistribution license for a file copied from the vendor image. Check the
applicable vendor terms before redistributing that copy.

## Dependencies and product screenshots

n8n, AppDynamics agents and proxies, container base images, and other dependencies
retain their respective licenses. This project does not grant licenses to those
products or redistribute their agent binaries.

Controller screenshots illustrate the educational examples. Product interfaces,
names, logos, and trademarks remain subject to their respective owners' rights;
the MIT license does not grant rights to those third-party materials.
