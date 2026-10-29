// Moves the editable test model to the current catalog after a Unity export raised the schema.
// Values whose field definition did not change are kept (including overrides and their absence);
// new fields and fields with a changed meaning take the values of the Unity export.
// Before that, the live snapshots of the old schema are frozen: the site keeps serving that schema
// to released clients and fills the fields the new model cannot express from these snapshots.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonical, convertSnapshot, resolveDefinition, sameDefinition } from '../site/balance-model.js';
import { execFileSync } from 'node:child_process';
import { buildBalance, hash } from './balance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const save = async (file, value) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), JSON.stringify(value, null, 2) + '\n');
};
const exists = file => access(path.join(root, file)).then(() => true, () => false);

const catalog = await read('schema/balance-catalog.json');
const test = await read('content/balance/test.json');
if (test.schemaVersion === catalog.schemaVersion) {
  console.log(`test.json уже в схеме ${catalog.schemaVersion}.`);
  process.exit(0);
}
const legacyFile = `schema/legacy/balance-catalog.v${test.schemaVersion}.json`;
if (!await exists(legacyFile)) throw Error(`${legacyFile} не найден: сначала экспортируйте каталог из Unity`);
const legacy = await read(legacyFile);
const exported = await read('content/balance/exported-baseline.json');
if (exported.schemaVersion !== catalog.schemaVersion) throw Error('exported-baseline.json не соответствует текущему каталогу');

// 1. Freeze what released clients of the old schema receive right now.
const frozen = `content/balance/legacy/v${legacy.schemaVersion}`;
if (!await exists(`${frozen}/test.json`) || !await exists(`${frozen}/prod.json`)) {
  if (!await exists(`${frozen}/test.json`)) await save(`${frozen}/test.json`, resolveDefinition(test, legacy).snapshot);
  const promotion = await read('content/balance/promotion.json');
  let prod, prodCatalog;
  if (promotion.sourceCommit === '') {
    const bootstrap = await read('content/balance/prod-bootstrap.json');
    prodCatalog = bootstrap.schemaVersion === legacy.schemaVersion ? legacy
      : await read(`schema/legacy/balance-catalog.v${bootstrap.schemaVersion}.json`);
    prod = resolveDefinition(bootstrap, prodCatalog).snapshot;
  }
  else {
    // A promoted revision of the old schema is still in the Git history of the site.
    const show = file => JSON.parse(execFileSync('git', ['show', `${promotion.sourceCommit}:${file}`], { cwd: root, encoding: 'utf8' }));
    prodCatalog = show('schema/balance-catalog.json');
    prod = resolveDefinition(show('content/balance/test.json'), prodCatalog).snapshot;
  }
  if (hash(canonical(prod)) !== promotion.expectedHash) throw Error('Замороженный prod не совпадает с опубликованным хэшем');
  if (prodCatalog.schemaVersion !== legacy.schemaVersion) {
    // The published revision may predate the schema being frozen. Reproduce the old
    // site's conversion with its committed Unity baseline, before the new export.
    const previousExport = JSON.parse(execFileSync('git', ['show', 'HEAD:content/balance/exported-baseline.json'], { cwd: root, encoding: 'utf8' }));
    prod = convertSnapshot(prod, prodCatalog, legacy, resolveDefinition(previousExport, legacy).snapshot);
  }
  if (!await exists(`${frozen}/prod.json`)) await save(`${frozen}/prod.json`, prod);
}

// 2. Migrate the sparse model field by field.
const oldFields = new Map(legacy.fields.map(f => [f.key, f])), fields = new Map(catalog.fields.map(f => [f.key, f]));
const keep = key => sameDefinition(oldFields.get(key), legacy, fields.get(key), catalog);
const replaced = [];
const take = (key, oldHas, oldValue, exportedHas, exportedValue, target, where) => {
  if (keep(key)) { if (oldHas) target[key] = oldValue; }
  else if (exportedHas) { target[key] = exportedValue; replaced.push(`${where}.${key}`); }
};
const has = (obj, key) => !!obj && Object.hasOwn(obj, key);
const migrated = { schemaVersion: catalog.schemaVersion, unitDefaults: {}, unitOverrides: {}, cities: {}, globals: {} };
const base = catalog.units.find(u => u.id === 'base_unit');
for (const key of base.fields)
  take(key, has(test.unitDefaults, key), test.unitDefaults[key], true, exported.unitDefaults[key], migrated.unitDefaults, 'base_unit');
for (const unit of catalog.units.filter(u => u.id !== 'base_unit')) {
  const old = test.unitOverrides[unit.id], fresh = exported.unitOverrides[unit.id];
  const target = migrated.unitOverrides[unit.id] = {};
  for (const key of unit.fields) take(key, has(old, key), old?.[key], has(fresh, key), fresh?.[key], target, unit.id);
}
for (const city of catalog.cities) {
  const target = migrated.cities[city.id] = {};
  for (const key of city.fields)
    take(key, has(test.cities[city.id], key), test.cities[city.id]?.[key], true, exported.cities[city.id][key], target, city.id);
}
for (const f of catalog.fields.filter(f => !['unit', 'city'].includes(f.section))) {
  const old = test.globals[f.section], target = migrated.globals[f.section] ??= {};
  take(f.key, has(old, f.key), old?.[f.key], true, exported.globals[f.section][f.key], target, f.section);
}
resolveDefinition(migrated, catalog); // throws on any gap before anything is written
await save('content/balance/test.json', migrated);
await buildBalance(root);
console.log(`test.json: схема ${legacy.schemaVersion} → ${catalog.schemaVersion}. Из экспорта Unity: ${replaced.length} значений.`);
for (const item of replaced) console.log(`  ${item}`);
