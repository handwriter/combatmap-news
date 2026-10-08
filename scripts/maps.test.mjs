import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, cp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { buildMaps, contentHash, normalizeMapEntry, resolveMapFile, validateMapText } from './maps.mjs';

const map = () => ({ id: 'Game map', name: 'Game map', maxPlayers: 2, maxUnitsPerPlayer: 80,
  cameraBounds: { cx: 0, cy: 0, sx: 20, sy: 13 }, terrain: { gridWidth: 2, gridHeight: 2, cells: [1, 2, 3, 4], trees: [] }, players: [{}, {}], bridges: [] });
const validate = new Ajv({ allErrors: true }).compile(JSON.parse(await readFile(new URL('../schema/map.schema.json', import.meta.url))));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'combatmap-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'content/maps'), { recursive: true });
  await mkdir(path.join(root, 'content/map-files'), { recursive: true });
  await cp(new URL('../schema/', import.meta.url), path.join(root, 'schema'), { recursive: true });
  return root;
}
async function entry(root, id, overrides = {}) {
  await writeFile(path.join(root, 'content/maps', id + '.json'), JSON.stringify({ title: id, file: '/map-files/payload.json', enabled: true, order: 0, ...overrides }));
}

test('FNV hashes agree with the game, including UTF-8', () => {
  assert.equal(contentHash(''), 'cbf29ce484222325');
  assert.equal(contentHash('hello'), 'a430d84680aabd0b');
  assert.equal(contentHash('карта'), 'df351b8569c49b3d');
});
test('metadata rejects malformed values and external paths', () => {
  for (const bad of [{ enabled: 'false' }, { order: -1 }, { order: 0.5 }, { title: '' }, { file: 'https://example.com/map.json' }])
    assert.ok(normalizeMapEntry('map', { title: 'Map', file: '/map-files/map.json', ...bad }).errors.length);
  assert.ok(normalizeMapEntry('../map', { title: 'Map', file: '/map-files/map.json' }).errors.length);
});
test('map validation catches player/cell mismatches, invalid terrain and broken objects', () => {
  assert.deepEqual(validateMapText(JSON.stringify(map()), validate).errors, []);
  const changes = [m => m.players.pop(), m => m.terrain.cells.pop(), m => m.terrain.cells[0] = 9,
    m => m.cameraBounds.sx = 0, m => m.terrain.gridWidth = 0, m => m.players[0].cities = [{ x: 0, y: 0 }],
    m => m.players[0].spawnPoints = [{ x: 0, y: 0, unitTypeId: '' }], m => m.terrain.trees = [{ x: 0, y: 0, variant: 0, scale: -1, flipX: false }]];
  for (const change of changes) { const m = map(); change(m); assert.ok(validateMapText(JSON.stringify(m), validate).errors.length); }
});
test('catalog sorts, omits disabled maps and preserves exact payload bytes on replacement', async t => {
  const root = await fixture(t);
  const original = JSON.stringify(map(), null, 2) + '\n';
  await writeFile(path.join(root, 'content/map-files/payload.json'), original);
  await entry(root, 'b', { order: 10 }); await entry(root, 'a', { order: 10 });
  await entry(root, 'first', { order: 0 }); await entry(root, 'disabled', { enabled: false, file: '/map-files/missing.json' });
  const first = await buildMaps(root, new Date('2026-10-08T00:00:00Z'));
  assert.deepEqual(first.problems, []);
  assert.deepEqual(first.feed.items.map(m => m.id), ['first', 'a', 'b']);
  assert.equal(first.payloads.get(first.feed.items[0].hash), original);
  assert.equal(first.feed.items[0].byteSize, Buffer.byteLength(original));
  const next = map(); next.name = 'Updated';
  await writeFile(path.join(root, 'content/map-files/payload.json'), JSON.stringify(next));
  const replaced = await buildMaps(root);
  assert.equal(replaced.feed.items[0].id, first.feed.items[0].id);
  assert.notEqual(replaced.feed.items[0].hash, first.feed.items[0].hash);
});
test('deletion and empty pool are authoritative; missing active payload fails', async t => {
  const root = await fixture(t);
  assert.deepEqual((await buildMaps(root)).feed.items, []);
  await entry(root, 'missing');
  assert.equal((await buildMaps(root)).problems.length, 1);
  await rm(path.join(root, 'content/maps/missing.json'));
  assert.deepEqual((await buildMaps(root)).feed.items, []);
});
test('path traversal and escaping symlinks are rejected', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'content/outside.json'), JSON.stringify(map()));
  await assert.rejects(resolveMapFile(root, '/map-files/../outside.json'));
  await symlink('../outside.json', path.join(root, 'content/map-files/link.json'));
  await assert.rejects(resolveMapFile(root, '/map-files/link.json'));
});
