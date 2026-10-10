// Shared authoring model: the CMS and publisher resolve and validate the same fields.
export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
const object = (v, where) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(`${where}: нужен объект`); };
function keys(value, expected, where, optional = false) {
  object(value, where);
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw Error(`${where}: неизвестный параметр ${key}`);
  if (!optional) for (const key of expected) if (!Object.hasOwn(value, key)) throw Error(`${where}: отсутствует ${key}`);
}
const blank = v => v === null || v === undefined || typeof v === 'string' && (v.trim() === '' || v === 'inherit');

function normalizeValue(value, f) {
  if (f.kind === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  if (f.kind === 'enum' && typeof value === 'string' && f.options.includes(value)) return Number(value);
  return value;
}
function value(v, f, catalog, where) {
  const fail = msg => { throw Error(`${where}.${f.key}: ${msg}`); };
  if (f.kind === 'boolean') { if (typeof v !== 'boolean') fail('нужно Да/Нет'); return; }
  if (f.kind === 'enum') { if (!Number.isInteger(v) || !f.options.includes(String(v))) fail('неизвестное значение'); return; }
  if (f.kind === 'unitId') { if (typeof v !== 'string' || v !== '' && !catalog.units.some(u => u.id === v)) fail('неизвестный юнит'); return; }
  if (f.kind === 'techIds') {
    if (!Array.isArray(v) || v.length > catalog.techIds.length || new Set(v).size !== v.length || v.some(id => !catalog.techIds.includes(id))) fail('неизвестная или повторяющаяся технология');
    return;
  }
  if (f.kind === 'terrainEntries') {
    if (!Array.isArray(v) || v.length > 64) fail('нужен список, максимум 64 правила');
    v.forEach((entry, i) => terrain(entry, catalog, `${where}.${f.key}[${i}]`)); return;
  }
  if (f.kind === 'terrainEntry') { terrain(v, catalog, `${where}.${f.key}`); return; }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < f.min || v > f.max || f.kind === 'integer' && !Number.isInteger(v)) fail(`нужно ${f.kind === 'integer' ? 'целое ' : ''}число ${f.min}–${f.max}`);
}
function terrain(entry, catalog, where) {
  const multipliers = ['MovementSpeedMultiplier', 'OutgoingDamageMultiplier', 'IncomingDamageMultiplier', 'RegenMultiplier'];
  keys(entry, ['Type', 'AffectedUnitIds', 'ExcludedUnitIds', ...multipliers, 'DamageOverTimePerSecond'], where);
  value(entry.Type, { key: 'Type', kind: 'integer', min: 0, max: 7 }, catalog, where);
  for (const key of ['AffectedUnitIds', 'ExcludedUnitIds']) {
    const ids = entry[key];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !catalog.units.some(u => u.id === id))) throw Error(`${where}.${key}: неизвестные/повторяющиеся юниты`);
  }
  for (const key of [...multipliers, 'DamageOverTimePerSecond']) value(entry[key], { key, kind: 'number', min: 0, max: key === 'DamageOverTimePerSecond' ? 100000 : 100 }, catalog, where);
}
export function normalizeDefinition(raw, catalog) {
  const d = structuredClone(raw);
  keys(d, ['schemaVersion', 'unitDefaults', 'unitOverrides', 'cities', 'globals'], 'balance');
  if (d.schemaVersion !== catalog.schemaVersion) throw Error('Несовместимая версия схемы баланса');
  const fields = new Map(catalog.fields.map(f => [f.key, f]));
  const base = catalog.units.find(u => u.id === 'base_unit');
  keys(d.unitDefaults, base.fields, 'unitDefaults');
  keys(d.unitOverrides, catalog.units.filter(u => u.id !== 'base_unit').map(u => u.id), 'unitOverrides', true);
  for (const key of base.fields) d.unitDefaults[key] = normalizeValue(d.unitDefaults[key], fields.get(key));
  for (const unit of catalog.units.filter(u => u.id !== 'base_unit')) {
    const overrides = d.unitOverrides[unit.id] ??= {};
    keys(overrides, unit.fields, unit.id, true);
    for (const [key, v] of Object.entries(overrides)) {
      if (blank(v)) delete overrides[key];
      else overrides[key] = normalizeValue(v, fields.get(key));
    }
  }
  keys(d.cities, catalog.cities.map(c => c.id), 'cities');
  for (const c of catalog.cities) {
    keys(d.cities[c.id], c.fields, c.id);
    for (const key of c.fields) d.cities[c.id][key] = normalizeValue(d.cities[c.id][key], fields.get(key));
  }
  const groups = [...new Set(catalog.fields.filter(f => !['unit', 'city'].includes(f.section)).map(f => f.section))];
  keys(d.globals, groups, 'globals');
  for (const group of groups) {
    const fs = catalog.fields.filter(f => f.section === group);
    keys(d.globals[group], fs.map(f => f.key), group);
    for (const f of fs) d.globals[group][f.key] = normalizeValue(d.globals[group][f.key], f);
  }
  return d;
}
export function resolveDefinition(raw, catalog) {
  const definition = normalizeDefinition(raw, catalog);
  const snapshot = { schemaVersion: definition.schemaVersion, units: {}, cities: definition.cities, globals: definition.globals };
  for (const unit of catalog.units) {
    const overrides = definition.unitOverrides[unit.id] || {};
    snapshot.units[unit.id] = Object.fromEntries(unit.fields.map(key => [key, Object.hasOwn(overrides, key) ? overrides[key] : definition.unitDefaults[key]]));
  }
  validateSnapshot(snapshot, catalog);
  return { definition, snapshot };
}
export function validateSnapshot(snapshot, catalog) {
  keys(snapshot, ['schemaVersion', 'units', 'cities', 'globals'], 'snapshot');
  if (snapshot.schemaVersion !== catalog.schemaVersion) throw Error('Несовместимая схема');
  const fields = new Map(catalog.fields.map(f => [f.key, f]));
  for (const group of ['units', 'cities']) {
    keys(snapshot[group], catalog[group].map(e => e.id), group);
    for (const e of catalog[group]) {
      keys(snapshot[group][e.id], e.fields, e.id);
      for (const key of e.fields) value(snapshot[group][e.id][key], fields.get(key), catalog, e.id);
    }
  }
  const groups = [...new Set(catalog.fields.filter(f => !['unit', 'city'].includes(f.section)).map(f => f.section))];
  keys(snapshot.globals, groups, 'globals');
  for (const group of groups) {
    const fs = catalog.fields.filter(f => f.section === group);
    keys(snapshot.globals[group], fs.map(f => f.key), group);
    for (const f of fs) value(snapshot.globals[group][f.key], f, catalog, group);
  }
  const interval = (obj, a, b, name) => { if (obj[a] > obj[b]) throw Error(`${name}: ${a} должен быть не больше ${b}`); };
  for (const [id, u] of Object.entries(snapshot.units)) {
    interval(u, 'RangedAttacker__aimTime_x', 'RangedAttacker__aimTime_y', id);
    interval(u, 'RangedAttacker__cooldownTime_x', 'RangedAttacker__cooldownTime_y', id);
    interval(u, 'SimpleMovable__greenSectorHalfAngle', 'SimpleMovable__blockedSectorHalfAngle', id);
    if ('NavalConversion__isNavalForm' in u && u.NavalConversion__isNavalForm !== (u.SimpleMovable__domain === 1)) throw Error(`${id}: морская форма не соответствует среде движения`);
  }
  const ai = snapshot.globals.ai;
  interval(ai, 'AiTuning_RetreatHpFraction', 'AiTuning_RecoveredHpFraction', 'ИИ');
  interval(ai, 'AiTuning_EngageRangeFactor', 'AiTuning_DisengageRangeFactor', 'ИИ');
  const research = snapshot.globals.research;
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw Error(`Цикл зависимостей технологий: ${id}`);
    visiting.add(id);
    for (const dependency of research[`tech_${id}_Prereqs`]) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const id of catalog.techIds) {
    visit(id);
    if (research[`tech_${id}_Effect`] !== 1 && !research[`tech_${id}_UnitId`]) throw Error(`${id}: нужен тип юнита для эффекта`);
    if (research[`tech_${id}_Effect`] === 2 && research[`tech_${id}_UnitId`] !== 'barge_unit') throw Error(`${id}: клиент поддерживает только существующую морскую механику`);
  }
  if (!catalog.units.some(u => u.id === snapshot.globals.cities.MapsConfig_CitySettings_ProductionSettings_DefaultStandardUnitId)) throw Error('Не указан стандартный юнит города');
}

export function validatePromotion(raw) {
  keys(raw, ['sourceCommit', 'expectedHash', 'comment'], 'promotion');
  if (typeof raw.sourceCommit !== 'string' || raw.sourceCommit !== '' && !/^[a-f0-9]{40}$/.test(raw.sourceCommit)) throw Error('Нужен полный SHA коммита test: 40 символов');
  if (typeof raw.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.expectedHash)) throw Error('Нужен SHA-256 снимка: 64 символа');
  if (typeof raw.comment !== 'string' || !raw.comment.trim() || raw.comment.length > 2000) throw Error('Нужен комментарий публикации, максимум 2000 символов');
}

