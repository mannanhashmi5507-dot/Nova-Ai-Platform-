'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUaclWorkerAgent } = require('../src/victus/cloud/workerAgent');

test('UACL worker agent registers capabilities and executes only a typed handler', async () => {
  const calls = [];
  const responses = [
    { ok: true, json: async () => ({ worker: { workerId: 'gpu-1' } }) },
    { ok: true, json: async () => ({ worker: { workerId: 'gpu-1' } }) },
    { ok: true, json: async () => ({ job: { id: 'job_1', workloadType: 'inference', spec: { prompt: 'hi' } } }) },
    { ok: true, json: async () => ({ job: { id: 'job_1', state: 'succeeded' } }) },
  ];
  const agent = createUaclWorkerAgent({
    baseUrl: 'https://nova.example',
    workerId: 'gpu-1',
    workerKey: 'secret',
    capabilities: { accelerators: ['cuda'], acceleratorMemoryGb: 24 },
    handlers: { inference: async job => ({ echo: job.spec.prompt }) },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
  });
  await agent.register();
  await agent.heartbeat();
  await agent.pollOnce();
  assert.equal(calls[0].options.headers['x-victus-worker-key'], 'secret');
  assert.match(calls[0].url, /workers\/register$/);
  assert.match(calls[2].url, /\/claim$/);
  assert.match(calls[3].url, /\/complete$/);
  assert.equal(agent.stopped, false);
});

test('UACL worker agent fails a job when the handler throws', async () => {
  const urls = [];
  const responses = [
    { ok: true, json: async () => ({ job: { id: 'job_2', workloadType: 'training', spec: {} } }) },
    { ok: true, json: async () => ({ job: { id: 'job_2', state: 'failed' } }) },
  ];
  const agent = createUaclWorkerAgent({
    baseUrl: 'https://nova.example', workerId: 'w',
    handlers: { training: async () => { throw new Error('GPU out of memory'); } },
    fetchImpl: async (url) => { urls.push(url); return responses.shift(); },
  });
  await agent.pollOnce();
  assert.match(urls[0], /\/claim$/);
  assert.match(urls[1], /\/fail$/);
});
