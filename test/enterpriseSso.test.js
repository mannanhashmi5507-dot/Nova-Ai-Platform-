const test = require('node:test');
const assert = require('node:assert/strict');
const { getSamlConfig, isConfigured, setupSSO } = require('../src/enterprise/sso');

const SAML_VARS = ['SAML_ENTRY_POINT', 'SAML_ISSUER', 'SAML_CERT', 'SAML_CALLBACK_URL'];

function clearSamlEnv() {
  const originals = {};
  for (const v of SAML_VARS) { originals[v] = process.env[v]; delete process.env[v]; }
  return originals;
}
function restoreSamlEnv(originals) {
  for (const v of SAML_VARS) { if (originals[v] !== undefined) process.env[v] = originals[v]; else delete process.env[v]; }
}

test('isConfigured is false when no SAML env vars are set', () => {
  const originals = clearSamlEnv();
  try { assert.equal(isConfigured(), false); } finally { restoreSamlEnv(originals); }
});

test('isConfigured is false when only some required vars are set', () => {
  const originals = clearSamlEnv();
  try {
    process.env.SAML_ENTRY_POINT = 'https://idp.example.com/sso';
    process.env.SAML_ISSUER = 'nova-ai';
    assert.equal(isConfigured(), false);
  } finally { restoreSamlEnv(originals); }
});

test('isConfigured is true once all 4 required vars are set', () => {
  const originals = clearSamlEnv();
  try {
    process.env.SAML_ENTRY_POINT = 'https://idp.example.com/sso';
    process.env.SAML_ISSUER = 'nova-ai';
    process.env.SAML_CERT = 'fake-cert-content';
    process.env.SAML_CALLBACK_URL = 'https://app.example.com/auth/saml/callback';
    assert.equal(isConfigured(), true);
  } finally { restoreSamlEnv(originals); }
});

test('getSamlConfig returns null when not configured', () => {
  const originals = clearSamlEnv();
  try { assert.equal(getSamlConfig(), null); } finally { restoreSamlEnv(originals); }
});

test('getSamlConfig returns real values when configured', () => {
  const originals = clearSamlEnv();
  try {
    process.env.SAML_ENTRY_POINT = 'https://idp.example.com/sso';
    process.env.SAML_ISSUER = 'nova-ai';
    process.env.SAML_CERT = 'fake-cert-content';
    process.env.SAML_CALLBACK_URL = 'https://app.example.com/auth/saml/callback';
    const config = getSamlConfig();
    assert.equal(config.entryPoint, 'https://idp.example.com/sso');
    assert.equal(config.issuer, 'nova-ai');
  } finally { restoreSamlEnv(originals); }
});

test('setupSSO is a safe no-op when not configured', () => {
  const originals = clearSamlEnv();
  try {
    const fakeApp = { get: () => { throw new Error('should not register routes'); } };
    const fakePassport = { use: () => { throw new Error('should not register a strategy'); } };
    let loggedNotConfigured = false;
    const fakeLogger = { info: (msg) => { if (msg === 'sso.not_configured') loggedNotConfigured = true; } };
    const result = setupSSO(fakeApp, fakePassport, fakeLogger);
    assert.equal(result, false);
    assert.equal(loggedNotConfigured, true);
  } finally { restoreSamlEnv(originals); }
});
