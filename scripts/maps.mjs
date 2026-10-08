import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';

export const MAX_MAP_BYTES = 16 * 1024 * 1024;
export const MAP_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Must match MapJsonLoader.ComputeContentHash: UTF-8, FNV-1a 64, lowercase hex. */
export function contentHash(text) {
  let hash = 14695981039346656037n;
  for (const byte of Buffer.from(text, 'utf8')) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return hash.toString(16).padStart(16, '0');
}

export function normalizeMapEntry(id, raw) {
  const errors = [];
  if (!MAP_ID.test(id)) errors.push('file name must be 1–80 lowercase letters, digits and dashes');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [...errors, 'entry must be an object'] };
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.trim().length > 80) errors.push('title: required, max 80 characters');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') errors.push('enabled: must be boolean');
  const order = raw.order ?? 0;
  if (!Number.isSafeInteger(order) || order < 0) errors.push('order: must be a nonnegative integer');
  if (typeof raw.file !== 'string' || !/^\/map-files\/.+\.json$/.test(raw.file) || /[\\\x00]/.test(raw.file)) errors.push('file: must refer to /map-files/*.json');
  return { errors, entry: { id, name: typeof raw.title === 'string' ? raw.title.trim() : undefined, enabled: raw.enabled ?? true, order, file: raw.file } };
}

export function validateMapText(text, validate) {
  const errors = [];
  const byteSize = Buffer.byteLength(text, 'utf8');
  if (byteSize > MAX_MAP_BYTES) errors.push(`map exceeds ${MAX_MAP_BYTES} bytes`);
  let map;
  try { map = JSON.parse(text); } catch (e) { return { errors: [`invalid map JSON: ${e.message}`] }; }
  if (!validate(map)) errors.push(...validate.errors.map(e => `${e.instancePath || '/'}: ${e.message}`));
  if (errors.length) return { errors };
  if (map.players.length !== map.maxPlayers) errors.push('players: length must equal maxPlayers');
  if (map.terrain.cells.length !== map.terrain.gridWidth * map.terrain.gridHeight) errors.push('terrain.cells: length must equal gridWidth × gridHeight');
  return { errors, map, byteSize };
}

/** Canonical containment also rejects symlinks escaping the upload directory. */
export async function resolveMapFile(root, file) {
  if (typeof file !== 'string' || !file.startsWith('/map-files/') || /[\\\x00]/.test(file)) throw new Error('invalid map upload path');
  const directory = await realpath(path.join(root, 'content/map-files'));
  const resolved = await realpath(path.resolve(directory, file.slice('/map-files/'.length)));
  const relative = path.relative(directory, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(resolved) !== '.json') throw new Error('map path escapes content/map-files or is not JSON');
  return resolved;
}

export async function buildMaps(root, now = new Date()) {
  const validate = new Ajv({ allErrors: true }).compile(JSON.parse(await readFile(path.join(root, 'schema/map.schema.json'), 'utf8')));
  const directory = path.join(root, 'content/maps');
  const files = (await readdir(directory)).filter(f => f.endsWith('.json')).sort();
  const entries = [], problems = [], payloads = new Map();
  for (const file of files) {
    const label = `content/maps/${file}`;
    try {
      const result = normalizeMapEntry(file.slice(0, -5), JSON.parse(await readFile(path.join(directory, file), 'utf8')));
      if (result.errors.length) throw new Error(result.errors.join('; '));
      const entry = result.entry;
      if (!entry.enabled) continue;
      const source = await resolveMapFile(root, entry.file);
      const bytes = await readFile(source);
      if (bytes.length > MAX_MAP_BYTES) throw new Error(`map exceeds ${MAX_MAP_BYTES} bytes`);
      const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
      const checked = validateMapText(text, validate);
      if (checked.errors.length) throw new Error(checked.errors.join('; '));
      const hash = contentHash(text);
      payloads.set(hash, text);
      entries.push({ order: entry.order, item: {
        id: entry.id, name: entry.name, maxPlayers: checked.map.maxPlayers,
        maxUnitsPerPlayer: checked.map.maxUnitsPerPlayer ?? 0,
        url: `maps/${hash}.json`, hash, byteSize: checked.byteSize,
      } });
    } catch (e) { problems.push(`${label}: ${e.message}`); }
  }
  entries.sort((a, b) => a.order - b.order || a.item.id.localeCompare(b.item.id, 'en'));
  return { feed: { schemaVersion: 1, generatedAt: now.toISOString(), items: entries.map(e => e.item) }, payloads, problems };
}
