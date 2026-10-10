import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, cp, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { buildMaps, contentHash, normalizeMapEntry, resolveMapFile, validateMapText } from './maps.mjs';
import { canonical, hash, resolveDefinition } from './balance.mjs';

const map = () => ({ id: 'Game map', name: 'Game map', maxPlayers: 2, maxUnitsPerPlayer: 80,
  cameraBounds: { cx: 0, cy: 0, sx: 20, sy: 13 }, terrain: { gridWidth: 2, gridHeight: 2, cells: [1, 2, 3, 4], trees: [] }, players: [{}, {}], bridges: [] });
const validate = new Ajv({ allErrors: true }).compile(JSON.parse(await readFile(new URL('../schema/map.schema.json', import.meta.url))));

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'combatmap-catalog-')));
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

test('failed publication preserves the last complete output', async t => {
  const root = await fixture(t);
  for (const folder of ['scripts', 'admin', 'site'])
    await cp(new URL(`../${folder}/`, import.meta.url), path.join(root, folder), { recursive: true });
  // The full publisher needs a valid balance revision, independent of the live promotion.
  const balanceDir = path.join(root, 'content/balance');
  await mkdir(balanceDir, { recursive: true });
  const baseline = await readFile(new URL('../content/balance/prod-bootstrap.json', import.meta.url), 'utf8');
  const catalog = JSON.parse(await readFile(path.join(root, 'schema/balance-catalog.json'), 'utf8'));
  await writeFile(path.join(balanceDir, 'test.json'), baseline);
  await writeFile(path.join(balanceDir, 'prod-bootstrap.json'), baseline);
  await writeFile(path.join(balanceDir, 'promotion.json'), JSON.stringify({
    sourceCommit: '', expectedHash: hash(canonical(resolveDefinition(JSON.parse(baseline), catalog).snapshot)),
    comment: 'Publication fixture',
  }));
  for (const args of [['init', '--quiet'], ['add', 'content/balance', 'schema/balance-catalog.json'], ['commit', '--quiet', '-m', 'Balance fixture']]) {
    const result = spawnSync('git', ['-c', 'user.name=Publication fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await symlink(fileURLToPath(new URL('../node_modules/', import.meta.url)), path.join(root, 'node_modules'), 'dir');
  await entry(root, 'map');
  await writeFile(path.join(root, 'content/map-files/payload.json'), JSON.stringify(map()));
  const publish = () => spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { encoding: 'utf8' });
  const first = publish();
  assert.equal(first.status, 0, first.stderr);
  const feedPath = path.join(root, 'dist/v1/maps.json');
  const previous = await readFile(feedPath, 'utf8');
  const payloadPath = path.join(root, 'dist/v1', JSON.parse(previous).items[0].url);
  const previousPayload = await readFile(payloadPath, 'utf8');
  await writeFile(path.join(root, 'content/map-files/payload.json'), '{broken');
  const failed = publish();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Content build failed/);
  assert.equal(await readFile(feedPath, 'utf8'), previous);
  assert.equal(await readFile(payloadPath, 'utf8'), previousPayload);
});
