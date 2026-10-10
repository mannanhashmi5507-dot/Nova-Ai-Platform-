'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { VictusWorldModel, InMemoryWorldRepository } = require('../src/victus/world/model');
const { mountWorldModelRoutes } = require('../src/victus/world/routes');

async function request(app, method, path, body, userId) {
  const server = http.createServer((req, res) => { req.dbUser = userId ? { id: userId } : null; app(req, res); });
  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally { server.close(); }
}

test('world routes require login and enforce tenant scope', async () => {
  const model = new VictusWorldModel({ repository: new InMemoryWorldRepository() });
  const app = express();
  app.use(express.json());
  mountWorldModelRoutes(app, model);
  const denied = await request(app, 'GET', '/api/victus/world/entities', null, null);
  assert.equal(denied.status, 401);
  const created = await request(app, 'POST', '/api/victus/world/entities', { id: 'p1', type: 'PROJECT', name: 'My Project' }, 7);
  assert.equal(created.status, 200);
  const own = await request(app, 'GET', '/api/victus/world/entities', null, 7);
  assert.equal(own.body.entities.length, 1);
  const other = await request(app, 'GET', '/api/victus/world/entities', null, 8);
  assert.equal(other.body.entities.length, 0);
});
