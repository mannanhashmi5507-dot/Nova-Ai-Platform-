'use strict';

const crypto = require('crypto');

const ENTITY_TYPES = Object.freeze([
  'USER', 'PROJECT', 'TASK', 'KNOWLEDGE', 'RESOURCE', 'TOOL', 'DEPENDENCY', 'EVENT', 'RESULT',
]);

const RELATIONS = Object.freeze([
  'OWNS', 'MEMBER_OF', 'CONTAINS', 'DEPENDS_ON', 'BLOCKS', 'USES', 'PRODUCES',
  'DERIVED_FROM', 'REFERENCES', 'TRIGGERS', 'PART_OF', 'ASSIGNED_TO', 'RELATED_TO',
  'SUPPORTS', 'INVALIDATES', 'SUCCEEDED_BY', 'FAILED_BY', 'PRECEDES', 'FOLLOWS',
]);

const MAX_ID = 160;
const MAX_NAME = 240;
const MAX_STATUS = 80;
const MAX_QUERY = 240;
const MAX_ATTRIBUTES_BYTES = 32 * 1024;
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|credential|authorization|cookie|private[_-]?key|session)/i;

function requiredString(value, field, max = MAX_ID) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  const out = value.trim();
  if (out.length > max) throw new RangeError(`${field} exceeds ${max} characters`);
  return out;
}

function optionalString(value, field, max) {
  if (value == null || value === '') return null;
  return requiredString(String(value), field, max);
}

function clamp01(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function safeAttributes(input, depth = 0) {
  if (depth > 5) throw new RangeError('attributes nesting exceeds limit');
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('attributes must be an object');

  const clean = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = String(rawKey).slice(0, 80);
    if (SENSITIVE_KEY.test(key)) continue;
    if (rawValue == null || typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      clean[key] = typeof rawValue === 'string' ? rawValue.slice(0, 4000) : rawValue;
      continue;
    }
    if (Array.isArray(rawValue)) {
      clean[key] = rawValue.slice(0, 100).map(v => {
        if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return typeof v === 'string' ? v.slice(0, 2000) : v;
        if (typeof v === 'object' && !Array.isArray(v)) return safeAttributes(v, depth + 1);
        return null;
      });
      continue;
    }
    if (typeof rawValue === 'object') clean[key] = safeAttributes(rawValue, depth + 1);
  }

  const encoded = JSON.stringify(clean);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ATTRIBUTES_BYTES) throw new RangeError('attributes exceed 32KB');
  return clean;
}

function normalizeEntity(input = {}, tenantId) {
  const tenant = requiredString(tenantId, 'tenantId');
  const type = requiredString(input.type, 'type').toUpperCase();
  if (!ENTITY_TYPES.includes(type)) throw new TypeError(`unsupported entity type: ${type}`);
  const id = optionalString(input.id, 'id', MAX_ID) || crypto.randomUUID();
  const now = new Date().toISOString();
  return {
    id,
    tenantId: tenant,
    type,
    name: requiredString(input.name || `${type}:${id}`, 'name', MAX_NAME),
    status: optionalString(input.status, 'status', MAX_STATUS),
    confidence: clamp01(input.confidence),
    attributes: safeAttributes(input.attributes),
    createdAt: input.createdAt || now,
    updatedAt: now,
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1,
  };
}

function normalizeRelation(input = {}, tenantId) {
  const tenant = requiredString(tenantId, 'tenantId');
  const fromId = requiredString(input.fromId, 'fromId');
  const toId = requiredString(input.toId, 'toId');
  const relation = requiredString(input.relation, 'relation').toUpperCase();
  if (!RELATIONS.includes(relation)) throw new TypeError(`unsupported relation: ${relation}`);
  if (fromId === toId && relation !== 'RELATED_TO') throw new TypeError('self-relation is not allowed for this relation');
  return {
    id: input.id || crypto.randomUUID(),
    tenantId: tenant,
    fromId,
    toId,
    relation,
    attributes: safeAttributes(input.attributes),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

class InMemoryWorldRepository {
  constructor() {
    this.entities = new Map();
    this.edges = new Map();
  }

  async upsertEntity(entity) {
    const key = `${entity.tenantId}:${entity.id}`;
    const existing = this.entities.get(key);
    const row = existing ? { ...existing, ...entity, createdAt: existing.createdAt, version: existing.version + 1 } : entity;
    this.entities.set(key, row);
    return row;
  }
  async getEntity(tenantId, id) { return this.entities.get(`${tenantId}:${id}`) || null; }
  async listEntities(tenantId, { type, query, limit = 50 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    return [...this.entities.values()].filter(e => e.tenantId === tenantId && (!type || e.type === type) && (!q || `${e.name} ${JSON.stringify(e.attributes)}`.toLowerCase().includes(q))).slice(0, limit);
  }
  async upsertEdge(edge, from, to) {
    const key = `${edge.tenantId}:${edge.fromId}:${edge.toId}:${edge.relation}`;
    const existing = this.edges.get(key);
    const row = existing ? { ...existing, ...edge, createdAt: existing.createdAt } : edge;
    this.edges.set(key, { ...row, fromType: from.type, toType: to.type });
    return this.edges.get(key);
  }
  async neighbors(tenantId, id, { relation, direction = 'both', limit = 100 } = {}) {
    const rows = [...this.edges.values()].filter(e => e.tenantId === tenantId && (!relation || e.relation === relation) && ((direction !== 'in' && e.fromId === id) || (direction !== 'out' && e.toId === id)));
    return rows.slice(0, limit);
  }
  async snapshot(tenantId, { limit = 500 } = {}) {
    const entities = await this.listEntities(tenantId, { limit });
    const ids = new Set(entities.map(e => e.id));
    const edges = [...this.edges.values()].filter(e => e.tenantId === tenantId && ids.has(e.fromId) && ids.has(e.toId)).slice(0, limit * 2);
    return { entities, edges };
  }
}

class PostgresWorldRepository {
  constructor(pool) {
    if (!pool) throw new Error('Postgres pool is required');
    this.pool = pool;
  }
  async upsertEntity(entity) {
    const { rows } = await this.pool.query(
      `INSERT INTO victus_world_entities
       (id, tenant_id, entity_type, name, status, confidence, attributes, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         entity_type = EXCLUDED.entity_type,
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         confidence = EXCLUDED.confidence,
         attributes = EXCLUDED.attributes,
         version = victus_world_entities.version + 1,
         updated_at = now()
       RETURNING *`,
      [entity.id, entity.tenantId, entity.type, entity.name, entity.status, entity.confidence, JSON.stringify(entity.attributes), entity.version, entity.createdAt, entity.updatedAt]
    );
    return mapEntity(rows[0]);
  }
  async getEntity(tenantId, id) {
    const { rows } = await this.pool.query(`SELECT * FROM victus_world_entities WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return rows[0] ? mapEntity(rows[0]) : null;
  }
  async listEntities(tenantId, { type, query, limit = 50 } = {}) {
    const params = [tenantId];
    const where = ['tenant_id=$1'];
    if (type) { params.push(type); where.push(`entity_type=$${params.length}`); }
    if (query) { params.push(`%${String(query).slice(0, MAX_QUERY)}%`); where.push(`(name ILIKE $${params.length} OR attributes::text ILIKE $${params.length})`); }
    params.push(limit);
    const { rows } = await this.pool.query(`SELECT * FROM victus_world_entities WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT $${params.length}`, params);
    return rows.map(mapEntity);
  }
  async upsertEdge(edge) {
    const { rows } = await this.pool.query(
      `INSERT INTO victus_world_edges (id, tenant_id, from_id, to_id, relation, attributes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, from_id, to_id, relation) DO UPDATE SET attributes=EXCLUDED.attributes
       RETURNING *`,
      [edge.id, edge.tenantId, edge.fromId, edge.toId, edge.relation, JSON.stringify(edge.attributes), edge.createdAt]
    );
    return mapEdge(rows[0]);
  }
  async neighbors(tenantId, id, { relation, direction = 'both', limit = 100 } = {}) {
    const params = [tenantId, id];
    const clauses = ['tenant_id=$1', '(from_id=$2 OR to_id=$2)'];
    if (relation) { params.push(relation); clauses.push(`relation=$${params.length}`); }
    if (direction === 'in') clauses[1] = 'to_id=$2';
    if (direction === 'out') clauses[1] = 'from_id=$2';
    params.push(limit);
    const { rows } = await this.pool.query(`SELECT * FROM victus_world_edges WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(mapEdge);
  }
  async snapshot(tenantId, { limit = 500 } = {}) {
    const entities = await this.listEntities(tenantId, { limit });
    const ids = entities.map(e => e.id);
    if (!ids.length) return { entities, edges: [] };
    const { rows } = await this.pool.query(`SELECT * FROM victus_world_edges WHERE tenant_id=$1 AND from_id = ANY($2::text[]) AND to_id = ANY($2::text[]) ORDER BY created_at DESC LIMIT $3`, [tenantId, ids, limit * 2]);
    return { entities, edges: rows.map(mapEdge) };
  }
}

function mapEntity(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.entity_type,
    name: row.name,
    status: row.status,
    confidence: Number(row.confidence),
    attributes: row.attributes || {},
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
function mapEdge(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation,
    attributes: row.attributes || {},
    createdAt: new Date(row.created_at).toISOString(),
  };
}

class VictusWorldModel {
  constructor({ repository = new InMemoryWorldRepository(), maxEntitiesPerTenant = 5000, maxEdgesPerTenant = 15000 } = {}) {
    this.repository = repository;
    this.maxEntitiesPerTenant = Math.max(1, Math.min(100000, maxEntitiesPerTenant));
    this.maxEdgesPerTenant = Math.max(1, Math.min(300000, maxEdgesPerTenant));
  }

  async upsertEntity(input, tenantId) {
    const entity = normalizeEntity(input, tenantId);
    if (this.repository instanceof InMemoryWorldRepository) {
      const count = (await this.repository.listEntities(tenantId, { limit: this.maxEntitiesPerTenant + 1 })).length;
      if (!this.repository.entities.has(`${tenantId}:${entity.id}`) && count >= this.maxEntitiesPerTenant) throw new RangeError('world model entity limit reached');
    }
    return this.repository.upsertEntity(entity);
  }

  async link(input, tenantId) {
    const edge = normalizeRelation(input, tenantId);
    const [from, to] = await Promise.all([this.repository.getEntity(tenantId, edge.fromId), this.repository.getEntity(tenantId, edge.toId)]);
    if (!from || !to) throw new Error('both relation endpoints must exist in the same tenant');
    if (this.repository instanceof InMemoryWorldRepository) {
      const count = [...this.repository.edges.values()].filter(e => e.tenantId === tenantId).length;
      if (!this.repository.edges.has(`${tenantId}:${edge.fromId}:${edge.toId}:${edge.relation}`) && count >= this.maxEdgesPerTenant) throw new RangeError('world model edge limit reached');
    }
    return this.repository.upsertEdge(edge, from, to);
  }

  async getEntity(tenantId, id) {
    return this.repository.getEntity(requiredString(tenantId, 'tenantId'), requiredString(id, 'id'));
  }

  async listEntities(tenantId, options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
    const type = options.type ? requiredString(options.type, 'type').toUpperCase() : undefined;
    if (type && !ENTITY_TYPES.includes(type)) throw new TypeError(`unsupported entity type: ${type}`);
    const query = options.query ? requiredString(options.query, 'query', MAX_QUERY) : undefined;
    return this.repository.listEntities(requiredString(tenantId, 'tenantId'), { type, query, limit });
  }

  async neighbors(tenantId, id, options = {}) {
    const relation = options.relation ? requiredString(options.relation, 'relation').toUpperCase() : undefined;
    if (relation && !RELATIONS.includes(relation)) throw new TypeError(`unsupported relation: ${relation}`);
    const direction = ['in', 'out', 'both'].includes(options.direction) ? options.direction : 'both';
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 100));
    return this.repository.neighbors(requiredString(tenantId, 'tenantId'), requiredString(id, 'id'), { relation, direction, limit });
  }

  async context(tenantId, entityIds = [], { depth = 1, maxEntities = 100 } = {}) {
    const ids = [...new Set(entityIds.map(v => requiredString(v, 'entityId')))].slice(0, 50);
    const boundedMaxEntities = Math.max(1, Math.min(500, Number(maxEntities) || 100));
    const resultEntities = new Map();
    const resultEdges = new Map();
    let frontier = ids;
    for (let level = 0; level <= Math.min(3, Math.max(0, Number(depth) || 0)); level += 1) {
      const next = [];
      for (const id of frontier) {
        if (resultEntities.size >= boundedMaxEntities) break;
        const entity = await this.getEntity(tenantId, id);
        if (!entity || resultEntities.has(entity.id)) continue;
        resultEntities.set(entity.id, entity);
        const edges = await this.neighbors(tenantId, id, { limit: Math.min(100, boundedMaxEntities) });
        for (const edge of edges) {
          if (resultEdges.size < boundedMaxEntities * 2) resultEdges.set(edge.id, edge);
          const other = edge.fromId === id ? edge.toId : edge.fromId;
          if (!resultEntities.has(other) && next.length < boundedMaxEntities) next.push(other);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return { entities: [...resultEntities.values()], edges: [...resultEdges.values()] };
  }

  async snapshot(tenantId, { limit = 500 } = {}) {
    return this.repository.snapshot(requiredString(tenantId, 'tenantId'), { limit: Math.max(1, Math.min(1000, Number(limit) || 500)) });
  }
}

function createWorldModel({ db, ...options } = {}) {
  const repository = db?.getPool?.() ? new PostgresWorldRepository(db.getPool()) : new InMemoryWorldRepository();
  return new VictusWorldModel({ ...options, repository });
}

module.exports = {
  ENTITY_TYPES,
  RELATIONS,
  safeAttributes,
  normalizeEntity,
  normalizeRelation,
  InMemoryWorldRepository,
  PostgresWorldRepository,
  VictusWorldModel,
  createWorldModel,
};
