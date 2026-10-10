'use strict';

const express = require('express');
const { createCloudMemoryNodeStore, createCloudMemoryNodeHandler, MAX_BODY_BYTES } = require('../src/victus/memory/node');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: `${Math.ceil(MAX_BODY_BYTES / 1024 / 1024)}mb` }));

const port = Math.max(1, Math.min(65535, Number(process.env.VICTUS_CLOUD_MEMORY_NODE_PORT) || 5091));
const secret = String(process.env.VICTUS_CLOUD_MEMORY_NODE_KEY || '').trim();
const maxEntries = Math.max(100, Math.min(100_000, Number(process.env.VICTUS_CLOUD_MEMORY_NODE_MAX_ENTRIES) || 10_000));
const maxBytes = Math.max(16 * 1024 * 1024, Math.min(4 * 1024 * 1024 * 1024, Number(process.env.VICTUS_CLOUD_MEMORY_NODE_MAX_BYTES) || 512 * 1024 * 1024));
const maxValueBytes = Math.max(1024, Math.min(10 * 1024 * 1024, Number(process.env.VICTUS_CLOUD_MEMORY_MAX_VALUE_BYTES) || 2 * 1024 * 1024));

if (!secret) {
  console.error('[ERR] VICTUS_CLOUD_MEMORY_NODE_KEY is missing. Refusing to start an unauthenticated cloud-memory node.');
  process.exit(1);
}

const store = createCloudMemoryNodeStore({ maxEntries, maxBytes });
const handlers = createCloudMemoryNodeHandler({ secret, store, maxValueBytes });
app.get('/health', handlers.health);
app.get('/status', handlers.status);
app.post('/memory/set', handlers.set);
app.post('/memory/get', handlers.get);
app.post('/memory/delete', handlers.delete);

app.listen(port, () => {
  console.log(`[OK] Victus Cloud Memory node listening on ${port}`);
  console.log(`[OK] Capacity: ${maxEntries.toLocaleString()} entries / ${(maxBytes / (1024 * 1024)).toFixed(0)} MiB`);
});
