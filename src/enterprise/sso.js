// ─── Enterprise: SSO (SAML) ───────────────────────────────────
// Phase 15. HONEST SCOPE: real SAML 2.0 SSO, genuinely functional the
// moment a real enterprise identity provider is configured — same
// "slot" pattern as every other optional integration in this app.
// NOT pre-wired to any specific IdP — that requires the org admin's
// actual IdP metadata (entry point URL, certificate, issuer).
//
// The strategy is built LAZILY (only when configured) rather than at
// module load, so an app with no SSO configured never pays the cost of
// (or risks an error from) constructing a SAML strategy with missing
// config.

function getSamlConfig() {
  const entryPoint = (process.env.SAML_ENTRY_POINT || '').trim();
  const issuer = (process.env.SAML_ISSUER || '').trim();
  const cert = (process.env.SAML_CERT || '').trim();
  const callbackUrl = (process.env.SAML_CALLBACK_URL || '').trim();
  if (!entryPoint || !issuer || !cert || !callbackUrl) return null;
  return { entryPoint, issuer, cert, callbackUrl };
}

function isConfigured() {
  return getSamlConfig() !== null;
}

function setupSSO(app, passport, logger) {
  const config = getSamlConfig();
  if (!config) {
    logger?.info?.('sso.not_configured', { reason: 'SAML_ENTRY_POINT/ISSUER/CERT/CALLBACK_URL not fully set' });
    return false;
  }

  const { Strategy: SamlStrategy } = require('@node-saml/passport-saml');

  passport.use('saml', new SamlStrategy(
    {
      entryPoint: config.entryPoint,
      issuer: config.issuer,
      cert: config.cert,
      callbackUrl: config.callbackUrl,
    },
    (profile, done) => {
      done(null, { email: profile.email || profile.nameID, displayName: profile.displayName || profile.email, ssoProvider: 'saml' });
    }
  ));

  app.get('/auth/saml', passport.authenticate('saml'));
  app.post('/auth/saml/callback', passport.authenticate('saml', { failureRedirect: '/login?error=sso_failed' }), (req, res) => {
    res.redirect('/');
  });

  logger?.info?.('sso.configured', { issuer: config.issuer });
  return true;
}

module.exports = { getSamlConfig, isConfigured, setupSSO };
