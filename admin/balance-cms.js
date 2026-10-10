import CMS from 'https://unpkg.com/@sveltia/cms/dist/sveltia-cms.mjs';
import { canonical, resolveDefinition, validatePromotion } from '../balance-model.js';

let catalogPromise;
const getCatalog = () => catalogPromise ??= fetch('../schema/balance-catalog.json').then(r => { if (!r.ok) throw Error('Не удалось загрузить каталог баланса'); return r.json(); });
const blank = value => value == null || typeof value === 'string' && (value.trim() === '' || value === 'inherit');
CMS.registerEventListener({
  name: 'preSave',
  async handler({ entry }) {
    if (entry.get('collection') !== 'balance') return;
    let data = entry.get('data');
    if (!data.has('unitDefaults')) {
      if (data.get('sourceCommit') == null) data = data.set('sourceCommit', '');
      validatePromotion(data.toJS()); return data;
    }
    const catalog = await getCatalog();
    // Filtering the Immutable Map preserves explicit false/zero and equal-to-base values.
    data = data.update('unitOverrides', types => types.map(overrides => overrides.filter(value => !blank(value))));
    resolveDefinition(data.toJS(), catalog); // Reject invalid relationships before committing.
    return data;
  }
});

const { createElement: h, useEffect, useState } = CMS.React;
const sectionLabels = { match: 'Начало матча', cities: 'Города: производство и бонусы', morale: 'Мораль', ranged: 'Подавление регенерации', terrain: 'Местность', territory: 'Территория и окружение', naval: 'Погрузка и высадка', research: 'Исследования', ai: 'ИИ' };
function BalancePreview({ entry }) {
  const [catalog, setCatalog] = useState(null), [prod, setProd] = useState(null), [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    getCatalog().then(c => { if (alive) setCatalog(c); }).catch(e => { if (alive) setError(e.message); });
    fetch('../v1/balance/preview.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(p => { if (alive && p) setProd(p.prod.snapshot); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (error) return h('p', { style: { color: '#9b342b' } }, error);
  if (!catalog) return h('p', {}, 'Загрузка описаний параметров…');
  let resolved;
  try { resolved = resolveDefinition(entry.get('data').toJS(), catalog); }
  catch (e) { return h('div', { style: { padding: 20 } }, h('h2', {}, 'Исправьте параметры баланса'), h('p', { style: { color: '#9b342b' } }, e.message)); }
  const fields = new Map(catalog.fields.map(f => [f.key, f]));
  const format = value => typeof value === 'boolean' ? value ? 'Да' : 'Нет' : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  const table = (id, title, keys, values, original, origin) => h('details', { key: id, open: id === 'base_unit', style: { border: '1px solid #c7b99d', margin: '12px 0', padding: 12 } },
    h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, title),
    h('table', { style: { width: '100%', fontSize: 13, borderCollapse: 'collapse' } }, h('thead', {}, h('tr', {}, ...['Параметр', 'Эффективное значение', 'Prod'].map(label => h('th', { key: label, style: { textAlign: 'left', padding: 8 } }, label)))),
      h('tbody', {}, ...keys.map(key => h('tr', { key, style: { background: original && canonical(original[key]) !== canonical(values[key]) ? '#f3e9cc' : 'transparent' } },
        h('td', { title: fields.get(key).hint, style: { padding: 8, borderTop: '1px solid #c7b99d' } }, fields.get(key).label),
        h('td', { style: { padding: 8, borderTop: '1px solid #c7b99d' } }, format(values[key]), h('small', { style: { display: 'block', color: '#75664d' } }, origin(key))),
        h('td', { style: { padding: 8, borderTop: '1px solid #c7b99d' } }, original ? format(original[key]) : '—'))))));
  return h('main', { style: { padding: 20, background: '#faf7ef', color: '#241b10', fontFamily: 'system-ui, sans-serif' } },
    h('h2', {}, 'Эффективный баланс черновика'),
    h('p', {}, 'Пустые поля наследуются. Подсвечены отличия от опубликованного prod. Описание — при наведении на параметр.'),
    h('a', { href: '../balance.html', target: '_blank', rel: 'noopener' }, 'Опубликованные ревизии и публикация в prod →'),
    ...catalog.units.map(unit => table(unit.id, unit.id === 'base_unit' ? 'Базовый юнит' : unit.label, unit.fields, resolved.snapshot.units[unit.id], prod?.units[unit.id], key => unit.id === 'base_unit' ? 'Базовое значение' : Object.hasOwn(resolved.definition.unitOverrides[unit.id] || {}, key) ? 'Переопределение типа' : 'От базового юнита')),
    ...catalog.cities.map(city => table(city.id, city.label, city.fields, resolved.snapshot.cities[city.id], prod?.cities[city.id], () => 'Параметр города')),
    ...Object.keys(resolved.snapshot.globals).map(section => table(section, sectionLabels[section] || section, catalog.fields.filter(f => f.section === section).map(f => f.key), resolved.snapshot.globals[section], prod?.globals[section], () => 'Общий конфиг')));
}
CMS.registerPreviewTemplate('test', BalancePreview);
CMS.init();
