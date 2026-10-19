import CMS from './vendor/sveltia/sveltia-cms.mjs';
import { resolveDefinition, validatePromotion } from '../balance-model.js';
import { registerBalanceRevision } from './balance-revision.js';
import { registerBalanceHistory } from './balance-history.js';
import { getCatalog } from './balance-data.js';
import { definitionDiff, formatBalanceError } from '../balance-diff.js';
import { registerContentValidation } from './content-validation.js';

registerContentValidation(CMS);

const selectedPromotion = registerBalanceRevision(CMS);

const DiffTable = registerBalanceHistory(CMS, selectedPromotion);
const previewStyleURL = new URL('./balance.css', import.meta.url).href;

CMS.registerEventListener({
  name: 'preSave',
  async handler({ entry }) {
    if (entry.get('collection') !== 'balance') return;
    let data = entry.get('data');
    if (!data.has('unitDefaults')) {
      const revision = selectedPromotion(data.get('sourceCommit'));
      data = data.set('sourceCommit', revision.sourceCommit).set('expectedHash', revision.hash);
      validatePromotion(data.toJS()); return data;
    }
    const catalog = await getCatalog();
    // The publisher, preview and history use the same normalization of inheritance.
    return data.clear().merge(resolveDefinition(data.toJS(), catalog).definition);
  }
});

const { createElement: h, useEffect, useState } = CMS.React;
function BalancePreview({ entry, originalEntry, document: previewDocument }) {
  const [catalog, setCatalog] = useState(null), [error, setError] = useState(null), [reload, setReload] = useState(0);
  useEffect(() => {
    const style = previewDocument.createElement('link');
    style.rel = 'stylesheet'; style.href = previewStyleURL;
    previewDocument.head.appendChild(style);
    return () => style.remove();
  }, [previewDocument]);
  useEffect(() => {
    let alive = true;
    setError(null);
    getCatalog().then(c => { if (alive) setCatalog(c); }).catch(ex => { if (alive) setError(ex.message); });
    return () => { alive = false; };
  }, [reload]);
  if (error) return h('main', { className: 'balance-preview' }, h('p', { role: 'alert', className: 'balance-error' }, error), h('button', { type: 'button', className: 'balance-button', onClick: () => setReload(value => value + 1) }, 'Повторить загрузку'));
  if (!catalog) return h('p', {}, 'Загрузка описаний параметров…');
  const draft = entry.get('data').toJS(), saved = originalEntry?.get('data')?.toJS();
  let rows, validation;
  try {
    rows = definitionDiff(saved?.unitDefaults ? saved : null, draft, catalog);
    try { resolveDefinition(draft, catalog); } catch (ex) { validation = formatBalanceError(ex.message, catalog); }
  } catch (ex) { return h('main', { className: 'balance-preview' }, h('p', { role: 'alert', className: 'balance-error' }, formatBalanceError(ex.message, catalog))); }
  return h('main', { className: 'balance-preview' },
    h('h2', {}, 'Текущие изменения'),
    validation && h('p', { role: 'alert', className: 'balance-error' }, validation),
    rows.length ? h(DiffTable, { rows, catalog }) : h('p', {}, 'Нет несохранённых изменений.'));
}
CMS.registerPreviewTemplate('test', BalancePreview);
CMS.init();
