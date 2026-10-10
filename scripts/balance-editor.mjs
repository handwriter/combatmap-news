// Regenerate fixed CMS forms after a Unity catalog export. Existing content is never overwritten.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonical, hash, resolveDefinition } from './balance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(root, 'schema/balance-catalog.json'), 'utf8'));
const byKey = new Map(catalog.fields.map(f => [f.key, f]));
const labels = { match: 'Начало матча', cities: 'Города: производство и бонусы', morale: 'Мораль', ranged: 'Подавление регенерации', terrain: 'Местность', territory: 'Территория и окружение', naval: 'Погрузка и высадка', research: 'Исследования', ai: 'ИИ' };
const entityNames = { base_unit: 'Базовый юнит / пехота', engineer_unit: 'Инженеры', cavalry_unit: 'Кавалерия', tank_unit: 'Танк', machinegun_unit: 'Пулемётчики', artillery_unit: 'Артиллерия', barge_unit: 'Баржа', city: 'Город', city_capital: 'Столица' };
const selectOptions = f => f.options.map(v => ({ value: Number(v), label: f.path === '_domain' ? ['Наземный', 'Морской'][v] : f.path === '_prFlightType' ? ['Наземный', 'Навесной'][v] : f.path.endsWith('.Effect') ? ['Открыть юнит', 'Повысить лимит войск', 'Открыть морскую конверсию'][v] : v }));
const unitsOptions = catalog.units.map(u => ({ label: entityNames[u.id] || u.label, value: u.id }));
const techOptions = catalog.techIds.map(id => ({ label: id, value: id }));
function terrainFields() {
  return [
    { name: 'Type', label: 'Поверхность', widget: 'select', options: Array.from({ length: 8 }, (_, value) => ({ value, label: ['Пусто', 'Равнина', 'Холмы', 'Горы', 'Вода', 'Город', 'Песок', 'Снег'][value] })), hint: 'Существующий тип поверхности. В эффекте леса это поле не участвует в расчёте.' },
    ...['AffectedUnitIds', 'ExcludedUnitIds'].map((name, i) => ({ name, label: i ? 'Исключённые юниты' : 'Затронутые юниты', widget: 'select', multiple: true, required: false, options: unitsOptions, hint: i ? 'Пусто — нет исключений.' : 'Пусто — правило действует на все типы.' })),
    ...[['MovementSpeedMultiplier', 'Скорость движения'], ['OutgoingDamageMultiplier', 'Наносимый урон'], ['IncomingDamageMultiplier', 'Получаемый урон'], ['RegenMultiplier', 'Регенерация HP'], ['DamageOverTimePerSecond', 'Урон поверхности']].map(([name, label]) => ({ name, label, widget: 'number', value_type: 'float', min: 0, max: name === 'DamageOverTimePerSecond' ? 100000 : 100, hint: name === 'DamageOverTimePerSecond' ? 'HP/с на поверхности. 0 — без урона.' : 'Множитель: 1 — обычное значение, 0 — выключить соответствующее действие.' }))
  ];
}
function field(f, override = false) {
  const item = { name: f.key, label: f.label, hint: f.hint + (override ? ' Пусто / «Наследовать» — использовать базовое значение. Явное значение сохраняется, даже если совпадает с базовым.' : ''), required: !override };
  switch (f.kind) {
    case 'boolean':
      return override ? { ...item, widget: 'select', options: [{ label: 'Наследовать', value: null }, { label: 'Да', value: true }, { label: 'Нет', value: false }] } : { ...item, widget: 'boolean' };
    case 'enum': return { ...item, widget: 'select', options: [...(override ? [{ label: 'Наследовать', value: 'inherit' }] : []), ...selectOptions(f)] };
    case 'unitId': return { ...item, widget: 'select', options: [{ label: 'Не задан', value: '' }, ...unitsOptions] };
    case 'techIds': return { ...item, widget: 'select', required: false, multiple: true, options: techOptions };
    case 'terrainEntry': return { ...item, widget: 'object', collapsed: true, fields: terrainFields() };
    case 'terrainEntries': return { ...item, widget: 'list', collapsed: true, max: 64, fields: terrainFields(), summary: '{{fields.Type}}' };
    default: return { ...item, widget: 'number', value_type: f.kind === 'integer' ? 'int' : 'float', min: f.min, max: f.max, step: f.kind === 'integer' ? 1 : 0.00000001 };
  }
}
const group = (name, label, fields) => ({ name, label, widget: 'object', collapsed: true, fields });
const base = catalog.units.find(u => u.id === 'base_unit');
const overrideField = key => {
  const inherited = base.fields.includes(key);
  const item = field(byKey.get(key), inherited);
  if (!inherited) item.hint += ' У базового юнита такого компонента нет; значение этого типа обязательно.';
  return item;
};
const collection = {
  name: 'balance', label: 'Баланс игры', i18n: false, description: 'Правки публикуются в test. Для prod выберите точную ревизию и хэш на странице предпросмотра.',
  files: [
    { name: 'test', label: 'Тестовый баланс', file: 'content/balance/test.json', format: 'json', preview_path: 'balance.html', fields: [
      { name: 'schemaVersion', widget: 'hidden', default: catalog.schemaVersion },
      group('unitDefaults', 'Базовый юнит / общие параметры', base.fields.map(key => field(byKey.get(key)))),
      group('unitOverrides', 'Переопределения юнитов', catalog.units.filter(u => u.id !== 'base_unit').map(u => group(u.id, entityNames[u.id] || u.label, u.fields.map(overrideField)))),
      group('cities', 'Геометрия городов и столиц', catalog.cities.map(c => group(c.id, entityNames[c.id] || c.label, c.fields.map(key => field(byKey.get(key)))))),
      group('globals', 'Общие механики и ИИ', Object.entries(labels).map(([section, label]) => group(section, label, catalog.fields.filter(f => f.section === section).map(f => field(f)))))
    ] },
    { name: 'promotion', label: 'Публикация в продакшн / откат', file: 'content/balance/promotion.json', format: 'json', fields: [
      { name: 'sourceCommit', label: 'Git-коммит проверенного test', widget: 'string', required: false, pattern: ['^[a-f0-9]{40}$', 'Полный SHA: 40 символов'], hint: 'Скопируйте ревизию со страницы предпросмотра. Весь баланс берётся из этого коммита. Пусто — первоначальный резервный баланс.' },
      { name: 'expectedHash', label: 'Ожидаемый SHA-256 снимка', widget: 'string', pattern: ['^[a-f0-9]{64}$', 'SHA-256: 64 символа'], hint: 'Скопируйте вместе с ревизией. Несовпадение отменяет публикацию.' },
      { name: 'comment', label: 'Комментарий публикации', widget: 'text', required: true, hint: 'Что проверено и почему публикуется эта ревизия. Для отката укажите прежний коммит и его хэш.' }
    ] }
  ]
};
const configPath = path.join(root, 'admin/config.yml');
const marker = '\n# BEGIN GENERATED BALANCE COLLECTION';
const config = (await readFile(configPath, 'utf8')).split(marker)[0].trimEnd();
await writeFile(configPath, config + marker + '\n  - ' + JSON.stringify(collection, null, 2).replaceAll('\n', '\n    ') + '\n# END GENERATED BALANCE COLLECTION\n');

function property(f) {
  switch (f.kind) {
    case 'boolean': return { type: 'boolean' };
    case 'enum': return { type: 'integer', enum: f.options.map(Number) };
    case 'unitId': return { type: 'string', enum: ['', ...catalog.units.map(u => u.id)] };
    case 'techIds': return { type: 'array', uniqueItems: true, items: { type: 'string', enum: catalog.techIds } };
    case 'terrainEntries': return { type: 'array', maxItems: 64, items: terrainSchema() };
    case 'terrainEntry': return terrainSchema();
    default: return { type: f.kind === 'integer' ? 'integer' : 'number', minimum: f.min, maximum: f.max };
  }
}
function terrainSchema() {
  const props = { Type: { type: 'integer', minimum: 0, maximum: 7 } };
  for (const key of ['AffectedUnitIds', 'ExcludedUnitIds']) props[key] = { type: 'array', uniqueItems: true, items: { type: 'string', enum: catalog.units.map(u => u.id) } };
  for (const key of ['MovementSpeedMultiplier', 'OutgoingDamageMultiplier', 'IncomingDamageMultiplier', 'RegenMultiplier', 'DamageOverTimePerSecond']) props[key] = { type: 'number', minimum: 0, maximum: key === 'DamageOverTimePerSecond' ? 100000 : 100 };
  return obj(props);
}
const obj = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const entities = group => obj(Object.fromEntries(catalog[group].map(e => [e.id, obj(Object.fromEntries(e.fields.map(key => [key, property(byKey.get(key))])))])));
const globals = obj(Object.fromEntries(Object.keys(labels).map(section => [section, obj(Object.fromEntries(catalog.fields.filter(f => f.section === section).map(f => [f.key, property(f)])))])));
const snapshot = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...obj({ schemaVersion: { const: catalog.schemaVersion }, units: entities('units'), cities: entities('cities'), globals }) };
await writeFile(path.join(root, 'schema/balance-snapshot.schema.json'), JSON.stringify(snapshot, null, 2) + '\n');
const variantSchemas = Object.fromEntries(catalog.units.filter(u => u.id !== 'base_unit').map(unit => [unit.id, {
  type: 'object', additionalProperties: false,
  required: unit.fields.filter(key => !base.fields.includes(key)),
  properties: Object.fromEntries(unit.fields.map(key => [key, property(byKey.get(key))]))
}]));
const definition = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...obj({
  schemaVersion: { const: catalog.schemaVersion },
  unitDefaults: obj(Object.fromEntries(base.fields.map(key => [key, property(byKey.get(key))]))),
  unitOverrides: { type: 'object', additionalProperties: false, required: Object.keys(variantSchemas).filter(id => variantSchemas[id].required.length), properties: variantSchemas },
  cities: entities('cities'), globals
}) };
await writeFile(path.join(root, 'schema/balance-definition.schema.json'), JSON.stringify(definition, null, 2) + '\n');
const baselinePath = path.join(root, 'content/balance/prod-bootstrap.json');
try { await readFile(baselinePath); } catch (e) { if (e.code !== 'ENOENT') throw e; await copyFile(path.join(root, 'content/balance/exported-baseline.json'), baselinePath); }
const baseline = resolveDefinition(JSON.parse(await readFile(baselinePath, 'utf8')), catalog).snapshot;
const promotionPath = path.join(root, 'content/balance/promotion.json');
try { await readFile(promotionPath); } catch (e) { if (e.code !== 'ENOENT') throw e; await writeFile(promotionPath, JSON.stringify({ sourceCommit: '', expectedHash: hash(canonical(baseline)), comment: 'Первоначальный баланс, экспортированный из Unity.' }, null, 2) + '\n'); }
console.log(`Balance CMS: ${catalog.fields.length} fields, ${catalog.units.length} unit types. Existing content preserved.`);
