'use strict';

const express = require('express');
const dns = require('dns').promises;
const { mountInternetRelayRoute } = require('../src/victus/internet/node');

const fetchImpl = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const port = Math.max(1, Math.min(65535, Number(process.env.VICTUS_INTERNET_NODE_PORT) || 5090));
const secret = String(process.env.VICTUS_INTERNET_NODE_KEY || '');
const allowPublicInternet = String(process.env.VICTUS_INTERNET_ALLOW_PUBLIC || '').toLowerCase() === 'true';
const allowedDomains = String(process.env.VICTUS_INTERNET_ALLOWLIST || '')
  .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);

if (!secret) console.warn('[WARN] VICTUS_INTERNET_NODE_KEY is empty — relay authentication is disabled. Use a secret in production.');
if (!allowPublicInternet && !allowedDomains.length) console.warn('[WARN] No VICTUS_INTERNET_ALLOWLIST configured — relay fetches will be disabled.');

mountInternetRelayRoute(app, { secret, allowPublicInternet, allowedDomains, fetchImpl, lookup: dns.lookup });

app.listen(port, () => {
  console.log(`[OK] Victus Internet Node listening on ${port}`);
  console.log(`[OK] Mode: ${allowPublicInternet ? 'public internet (SSRF protections remain enabled)' : 'allowlisted'}`);
});
