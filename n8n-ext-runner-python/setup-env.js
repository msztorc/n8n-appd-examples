const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseEnv } = require('node:util');

const target = path.join(__dirname, '.env');
if (process.argv.length > 3) {
    throw new Error('Usage: node setup-env.js [source-env-file]');
}
if (fs.existsSync(target)) {
    throw new Error('Python example .env already exists; refusing to overwrite its secrets.');
}

const values = {
    POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
    N8N_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    N8N_RUNNERS_AUTH_TOKEN: randomBytes(32).toString('hex')
};
let certificate;
if (process.argv[2]) {
    const source = path.resolve(process.argv[2]);
    const sourceEnv = parseEnv(fs.readFileSync(source, 'utf8'));
    if (Object.keys(sourceEnv).some(key => /^APPD_(ACCOUNT_NAME|ACCESS_KEY|CONTROLLER_HOST|CONTROLLER_PORT)$/.test(key))) {
        throw new Error('Source uses legacy AppDynamics connection names; migrate to standard APPDYNAMICS_* names before initialization.');
    }
    for (const key of [
        'APPD_INIT_IMAGE',
        'APPDYNAMICS_AGENT_ACCOUNT_NAME',
        'APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY',
        'APPDYNAMICS_CONTROLLER_HOST_NAME',
        'APPDYNAMICS_CONTROLLER_PORT',
        'APPDYNAMICS_CONTROLLER_SSL_ENABLED'
    ]) {
        if (sourceEnv[key]) values[key] = sourceEnv[key];
    }
    certificate = fs.readFileSync(path.join(path.dirname(source), 'certs/corporate-ca.pem'));
    if (fs.existsSync(path.join(__dirname, 'certs/corporate-ca.pem'))) {
        throw new Error('Python example CA certificate already exists; refusing to overwrite it.');
    }
}

const template = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
const content = template.replace(/^([A-Z][A-Z0-9_]*)=.*$/gm, (line, key) => {
    if (!(key in values)) return line;
    if (/[\r\n']/.test(values[key])) {
        throw new Error(`Unsupported newline or quote in ${key}; configure this value manually.`);
    }
    return `${key}='${values[key]}'`;
});
fs.mkdirSync(path.join(__dirname, 'certs'), { recursive: true });
fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
if (certificate) {
    fs.writeFileSync(path.join(__dirname, 'certs/corporate-ca.pem'), certificate, { flag: 'wx', mode: 0o644 });
}
console.info('Created Python example .env with new database, encryption, and broker secrets.');
console.info(certificate
    ? 'Copied only AppDynamics connection settings and the CA certificate; source files were not changed.'
    : 'Set AppDynamics connection settings and place your CA at certs/corporate-ca.pem before starting.');
