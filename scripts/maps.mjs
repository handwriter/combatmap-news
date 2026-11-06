import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { normalizeMapEntry } from '../site/maps-model.js';
export { MAP_ID, normalizeMapEntry } from '../site/maps-model.js';

export const MAX_MAP_BYTES = 16 * 1024 * 1024;

// These limits and binary layouts mirror TerrainRle, MapValidation and UrbanCodec in the game.
const MAX_URBAN_ITEMS = 200000;
const URBAN_ROOF_COUNTS = [4, 4, 3, 3, 3, 3, 2, 1, 3, 1];

function base64Bytes(text) {
  const compact = text.replace(/[\t\n\r ]/g, '');
  // Buffer.from alone silently accepts malformed/truncated base64; the game rejects it.
  if (compact.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  return Buffer.from(compact, 'base64');
}

function validRle(text, count, maxType) {
  const raw = base64Bytes(text);
  if (!raw?.length) return false;
  let at = 0, written = 0;
  while (at < raw.length) {
    if (raw[at++] > maxType) return false;
    let run = 0, shift = 0, byte;
    do {
      if (at >= raw.length || shift > 28) return false;
      byte = raw[at++];
      run += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    if (!run || run > count - written) return false;
    written += run;
  }
  return written === count;
}

function validUrbanGeometry(urban) {
  const houses = base64Bytes(urban.houses), streets = base64Bytes(urban.streets), squares = base64Bytes(urban.squares);
  if (!houses || !streets || !squares || houses.length % 8 || houses.length / 8 > MAX_URBAN_ITEMS) return false;
  for (let i = 0; i < houses.length; i += 8) {
    const type = houses[i + 5];
    if (type >= URBAN_ROOF_COUNTS.length || houses[i + 6] >= URBAN_ROOF_COUNTS[type] || houses[i + 7] > 1) return false;
  }
  const positiveSize = v => v > 0 && v <= 100 && Number.isFinite(v);
  if (streets.length < 4) return false;
  const count = streets.readInt32LE(0);
  if (count < 0 || count > MAX_URBAN_ITEMS) return false;
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + 9 > streets.length || streets[at] > 2 || !positiveSize(streets.readFloatLE(at + 1))) return false;
    const points = streets.readInt32LE(at + 5);
    at += 9;
    if (points < 2 || points > Math.floor((streets.length - at) / 4)) return false;
    at += points * 4;
  }
  if (at !== streets.length || squares.length % 8 || squares.length / 8 > MAX_URBAN_ITEMS) return false;
  for (let i = 0; i < squares.length; i += 8) if (!positiveSize(squares.readFloatLE(i + 4))) return false;
  return true;
}

/** Must match MapJsonLoader.ComputeContentHash: UTF-8, FNV-1a 64, lowercase hex. */
export function contentHash(text) {
  let hash = 14695981039346656037n;
  for (const byte of Buffer.from(text, 'utf8')) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return hash.toString(16).padStart(16, '0');
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
  const terrain = map.terrain, count = terrain.gridWidth * terrain.gridHeight;
  const hasCells = terrain.cells != null, hasRle = terrain.rle != null;
  if (hasCells === hasRle) errors.push('terrain: supply exactly one of cells or rle');
  else if (hasCells && terrain.cells.length !== count) errors.push('terrain.cells: length must equal gridWidth × gridHeight');
  else if (hasRle && !validRle(terrain.rle, count, 7)) errors.push('terrain.rle: invalid terrain encoding or cell count');
  if (terrain.urban != null) {
    if (terrain.format !== 2) errors.push('terrain.urban: requires terrain format 2');
    if (!validRle(terrain.urban.rle, count, 1)) errors.push('terrain.urban.rle: invalid mask encoding or cell count');
    if (!validUrbanGeometry(terrain.urban)) errors.push('terrain.urban: invalid houses, streets or squares');
  }
  if (map.zones != null && !validRle(map.zones.rle, map.zones.width * map.zones.height, 8)) errors.push('zones.rle: invalid zone encoding or cell count');
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
