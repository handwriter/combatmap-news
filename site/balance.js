import { canonical } from './balance-model.js';
const $ = id => document.getElementById(id);
const labels = { match: 'Начало матча', cities: 'Города: производство и бонусы', morale: 'Мораль', ranged: 'Подавление регенерации', terrain: 'Местность', territory: 'Территория и окружение', naval: 'Погрузка и высадка', research: 'Исследования', ai: 'ИИ' };
const names = { base_unit: 'Базовый юнит / пехота', engineer_unit: 'Инженеры', cavalry_unit: 'Кавалерия', tank_unit: 'Танк', machinegun_unit: 'Пулемётчики', artillery_unit: 'Артиллерия', barge_unit: 'Баржа', city: 'Город', city_capital: 'Столица' };
let data;
const equal = (a, b) => canonical(a) === canonical(b);
const countLabel = n => `${n} ${{ one: 'параметр', few: 'параметра', many: 'параметров', other: 'параметра' }[new Intl.PluralRules('ru').select(n)]}`;
function format(v, f) {
  if (typeof v === 'boolean') return v ? 'Да' : 'Нет';
  if (typeof v === 'number') {
    if (f.path === '_domain') return ['Наземный', 'Морской'][v];
    if (f.path === '_prFlightType') return ['Наземный', 'Навесной'][v];
    if (f.path.endsWith('.Effect')) return ['Открыть юнит', 'Повысить лимит', 'Морская конверсия'][v];
    return String(v);
  }
  if (Array.isArray(v)) return v.length ? v.every(x => typeof x === 'string') ? v.map(x => names[x] || x).join(', ') : JSON.stringify(v, null, 2) : 'Пусто';
  return typeof v === 'object' ? JSON.stringify(v, null, 2) : names[v] || v || 'Не задан';
}
function render() {
  if (!data) return;
  const search = $('search').value.trim().toLocaleLowerCase('ru'), differences = $('diff').checked;
  const root = $('groups'); root.replaceChildren();
  const fields = new Map(data.catalog.fields.map(f => [f.key, f]));
  let rows = 0, changed = 0;
  function group(title, keys, get, source, open = false) {
    const details = document.createElement('details'); details.open = open || !!search || differences;
    const summary = document.createElement('summary'); summary.textContent = title;
    const scroll = document.createElement('div'); scroll.className = 'scroll';
    const table = document.createElement('table'), thead = document.createElement('thead'), head = document.createElement('tr');
    for (const label of ['Параметр', 'Test', 'Prod']) { const th = document.createElement('th'); th.textContent = label; head.append(th); }
    thead.append(head); table.append(thead); const body = document.createElement('tbody'); let count = 0;
    for (const key of keys) {
      const f = fields.get(key), test = get('test', key), prod = get('prod', key), differs = !equal(test, prod) || source('test', key) !== source('prod', key);
      if (differences && !differs || search && !`${title} ${f.label} ${f.hint} ${key}`.toLocaleLowerCase('ru').includes(search)) continue;
      const tr = document.createElement('tr'); if (differs) tr.className = 'changed';
      const label = document.createElement('td'), help = document.createElement('span'); help.className = 'help'; help.tabIndex = 0; help.textContent = f.label; help.title = f.hint; label.append(help); tr.append(label);
      for (const channel of ['test', 'prod']) {
        const td = document.createElement('td'), text = document.createElement('div'), origin = document.createElement('span');
        text.className = 'value'; text.textContent = format(get(channel, key), f);
        origin.className = 'source'; origin.textContent = source(channel, key); td.append(text, origin); tr.append(td);
      }
      body.append(tr); count++; rows++; if (differs) changed++;
    }
    if (!count) return;
    const counter = document.createElement('span'); counter.textContent = countLabel(count); summary.append(counter); table.append(body); scroll.append(table); details.append(summary, scroll); root.append(details);
  }
  for (const unit of data.catalog.units) group(names[unit.id] || unit.label, unit.fields,
    (channel, key) => data[channel].snapshot.units[unit.id][key],
    (channel, key) => unit.id === 'base_unit' ? 'Базовое значение' : Object.hasOwn(data[channel].definition.unitOverrides[unit.id] || {}, key) ? 'Переопределено для типа' : 'Наследуется от базового юнита', unit.id === 'base_unit');
  for (const city of data.catalog.cities) group(names[city.id] || city.label, city.fields, (channel, key) => data[channel].snapshot.cities[city.id][key], () => 'Параметр этого типа города');
  for (const [section, label] of Object.entries(labels)) group(label, data.catalog.fields.filter(f => f.section === section).map(f => f.key), (channel, key) => data[channel].snapshot.globals[section][key], () => 'Общий конфиг');
  $('status').textContent = `${rows} параметров показано · ${changed} различий prod/test · схема ${data.catalog.schemaVersion}`;
}
async function load() {
  $('status').textContent = 'Загрузка…'; $('status').className = '';
  try {
    const fetchJson = async url => { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw Error(`HTTP ${r.status}`); return r.json(); };
    const [preview, revisions] = await Promise.all([fetchJson('v1/balance/preview.json'), fetchJson('v1/balance/revisions.json')]);
    data = preview; $('promotion').hidden = false; $('revision').replaceChildren();
    for (const r of revisions) {
      const option = document.createElement('option'); option.textContent = `${r.sourceCommit.slice(0, 8)} · ${r.comment}`; option.value = JSON.stringify(r); $('revision').append(option);
    }
    selectRevision(); $('prod-version').textContent = `Prod сейчас: ${data.prod.manifest.sourceCommit} · ${data.promotion.comment}`; render();
  } catch (e) { $('status').className = 'error'; $('status').textContent = `Не удалось загрузить баланс: ${e.message}`; }
}
function selectRevision() { const r = JSON.parse($('revision').value); $('commit').value = r.sourceCommit; $('hash').value = r.hash; $('copy-status').textContent = ''; }
async function copy(id) {
  try { await navigator.clipboard.writeText($(id).value); $('copy-status').textContent = id === 'commit' ? 'Коммит скопирован.' : 'Хэш скопирован.'; }
  catch { $(id).focus(); $(id).select(); $('copy-status').textContent = 'Выделено для копирования.'; }
}
$('copy-commit').onclick = () => copy('commit'); $('copy-hash').onclick = () => copy('hash'); $('revision').onchange = selectRevision;
$('search').oninput = render; $('diff').onchange = render; $('reload').onclick = load;
load();
