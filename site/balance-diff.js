import { canonical, normalizeDefinition, resolveDefinition } from './balance-model.js';

export const sectionLabels = { match: 'Начало матча', combat: 'Бой и лимит войск', cities: 'Города: производство и бонусы', morale: 'Мораль', ranged: 'Подавление регенерации', terrain: 'Местность', territory: 'Территория и окружение', naval: 'Погрузка и высадка', research: 'Исследования', ai: 'ИИ' };
export const entityLabels = { base_unit: 'Базовый юнит', engineer_unit: 'Инженеры', cavalry_unit: 'Кавалерия', tank_unit: 'Танк', machinegun_unit: 'Пулемётчики', artillery_unit: 'Артиллерия', barge_unit: 'Баржа', city: 'Город', city_capital: 'Столица' };
const get = (data, path) => path.reduce((value, key) => value?.[key], data);
const owns = (data, path) => Object.hasOwn(get(data, path.slice(0, -1)) || {}, path.at(-1));
const descriptors = catalog => {
  const fields = new Map(catalog.fields.map(field => [field.key, field]));
  const result = [];
  for (const unit of catalog.units) for (const key of unit.fields) result.push({
    path: unit.id === 'base_unit' ? ['unitDefaults', key] : ['unitOverrides', unit.id, key],
    group: entityLabels[unit.id] || unit.label, field: fields.get(key), unitId: unit.id,
  });
  for (const city of catalog.cities) for (const key of city.fields) result.push({ path: ['cities', city.id, key], group: entityLabels[city.id] || city.label, field: fields.get(key) });
  for (const field of catalog.fields.filter(f => !['unit', 'city'].includes(f.section))) result.push({ path: ['globals', field.section, field.key], group: sectionLabels[field.section] || field.section, field });
  return result;
};
const state = (data, descriptor, catalog) => {
  const present = owns(data, descriptor.path), raw = get(data, descriptor.path);
  const inherited = !!data && descriptor.path[0] === 'unitOverrides' && !present && catalog.units.find(u => u.id === 'base_unit').fields.includes(descriptor.field.key);
  return { present, raw, inherited, value: inherited ? data.unitDefaults[descriptor.field.key] : raw };
};

// Diff the editable model, not just numbers: an equal-to-base override is still a change.
export function definitionDiff(before, after, catalog, beforeCatalog = catalog) {
  const a = before ? normalizeDefinition(before, beforeCatalog) : null;
  const b = normalizeDefinition(after, catalog);
  const all = new Map(descriptors(beforeCatalog).map(item => [JSON.stringify(item.path), item]));
  for (const item of descriptors(catalog)) all.set(JSON.stringify(item.path), item);
  const rows = [];
  for (const [id, descriptor] of all) {
    const from = state(a, descriptor, beforeCatalog), to = state(b, descriptor, catalog);
    if (from.present === to.present && canonical(from.raw) === canonical(to.raw)) continue;
    const impacts = descriptor.path[0] === 'unitDefaults' ? catalog.units.filter(unit => unit.id !== 'base_unit' && unit.fields.includes(descriptor.field.key)
      && !Object.hasOwn(a?.unitOverrides[unit.id] || {}, descriptor.field.key) && !Object.hasOwn(b.unitOverrides[unit.id] || {}, descriptor.field.key))
      .map(unit => ({ label: entityLabels[unit.id] || unit.label, from: from.value, to: to.value })) : [];
    rows.push({ id, ...descriptor, from, to, impacts });
  }
  return rows;
}

export function applyRevisionFields(current, revision, selectedPaths, catalog) {
  const candidate = normalizeDefinition(current, catalog);
  const source = resolveDefinition(revision, catalog).definition;
  const allowed = new Set(descriptors(catalog).map(item => JSON.stringify(item.path)));
  for (const path of selectedPaths) {
    if (!allowed.has(JSON.stringify(path))) throw Error('Выбран неизвестный параметр баланса');
    const target = get(candidate, path.slice(0, -1)), key = path.at(-1);
    if (owns(source, path)) target[key] = structuredClone(get(source, path));
    else delete target[key];
  }
  return resolveDefinition(candidate, catalog).definition;
}

export function formatValue(value, field, catalog) {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (field.kind === 'unitId') return value ? entityLabels[value] || catalog.units.find(unit => unit.id === value)?.label || value : 'Не задан';
  if (field.kind === 'enum') {
    const options = field.path === '_domain' ? ['Наземный', 'Морской'] : field.path === '_prFlightType' ? ['Наземный', 'Навесной'] : field.path.endsWith('.Effect') ? ['Открыть юнит', 'Повысить лимит войск', 'Открыть морскую конверсию'] : null;
    if (options?.[value]) return options[value];
  }
  if (field.kind === 'techIds') return value.length ? value.map(id => {
    const cost = catalog.fields.find(item => item.key === `tech_${id}_Cost`);
    return cost?.label.replace(/: стоимость$/, '') || id;
  }).join(', ') : 'Нет зависимостей';
  if (['terrainEntry', 'terrainEntries'].includes(field.kind)) {
    const names = { Type: 'Поверхность', AffectedUnitIds: 'Затронутые юниты', ExcludedUnitIds: 'Исключённые юниты', MovementSpeedMultiplier: 'Скорость движения', OutgoingDamageMultiplier: 'Наносимый урон', IncomingDamageMultiplier: 'Получаемый урон', RegenMultiplier: 'Регенерация HP', DamageOverTimePerSecond: 'Урон поверхности' };
    const describe = entry => Object.entries(names).map(([key, label]) => {
      const item = entry[key];
      const text = key === 'Type' ? ['Пусто', 'Равнина', 'Холмы', 'Горы', 'Вода', 'Город', 'Песок', 'Снег'][item]
        : Array.isArray(item) ? (item.length ? item.map(id => entityLabels[id] || id).join(', ') : key === 'AffectedUnitIds' ? 'Все типы' : 'Нет') : String(item);
      return `${label}: ${text}`;
    }).join('\n');
    return Array.isArray(value) ? (value.length ? value.map((entry, i) => `${i + 1}. ${describe(entry)}`).join('\n\n') : 'Нет правил') : describe(value);
  }
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

export function formatState(state, row, catalog) {
  const value = formatValue(state.value, row.field, catalog);
  if (state.inherited) return `Наследовать (${value})`;
  if (row.path[0] === 'unitOverrides' && state.present) return `Переопределение: ${value}`;
  return value;
}

export function formatBalanceError(message, catalog) {
  let text = message;
  for (const field of [...catalog.fields].sort((a, b) => b.key.length - a.key.length)) text = text.replaceAll(field.key, `«${field.label}»`);
  for (const [id, label] of Object.entries(entityLabels)) text = text.replaceAll(id, label);
  return text.replaceAll('unitDefaults', 'Базовый юнит').replaceAll('unitOverrides', 'Переопределения юнитов');
}
