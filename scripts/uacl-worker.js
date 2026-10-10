#!/usr/bin/env node
'use strict';

const { createUaclWorkerAgent } = require('../src/victus/cloud/workerAgent');

const UACL_URL = (process.env.UACL_URL || '').trim();
const UACL_WORKER_ID = (process.env.UACL_WORKER_ID || '').trim();
const UACL_WORKER_KEY = (process.env.UACL_WORKER_KEY || '').trim();

if (!UACL_URL || !UACL_WORKER_ID) {
  console.error('Set UACL_URL and UACL_WORKER_ID before starting a worker.');
  process.exit(1);
}

// This launcher intentionally has no shell/command-execution handler.
// Deploy a host-specific process that supplies typed handlers for the
// workload types it is authorized to run (inference/training/evaluation/embedding).
const agent = createUaclWorkerAgent({
  baseUrl: UACL_URL,
  workerId: UACL_WORKER_ID,
  workerKey: UACL_WORKER_KEY,
  provider: process.env.UACL_PROVIDER || 'self-hosted',
  region: process.env.UACL_REGION || 'unknown',
  pricePerHour: Number(process.env.UACL_PRICE_PER_HOUR || 0),
  preemptible: process.env.UACL_PREEMPTIBLE === 'true',
  capabilities: {
    accelerators: String(process.env.UACL_ACCELERATORS || '').split(',').map(s => s.trim()).filter(Boolean),
    acceleratorMemoryGb: Number(process.env.UACL_ACCELERATOR_MEMORY_GB || 0),
    cpuCores: Number(process.env.UACL_CPU_CORES || 1),
    ramGb: Number(process.env.UACL_RAM_GB || 1),
    storageGb: Number(process.env.UACL_STORAGE_GB || 1),
    internet: process.env.UACL_INTERNET !== 'false',
  },
});

agent.start().then(() => {
  console.log(`[UACL] Worker ${UACL_WORKER_ID} connected to ${UACL_URL}`);
}).catch(err => {
  console.error(`[UACL] Failed to start: ${err.message}`);
  process.exit(1);
});

// Graceful: stop taking work, let running jobs report, then exit.
const shutdown = () => agent.stop().finally(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
