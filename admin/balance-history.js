import { canonical, resolveDefinition } from '../balance-model.js';
import { definitionDiff, applyRevisionFields, formatState, formatValue, formatBalanceError } from '../balance-diff.js';
import { fetchJson, getCatalog, loadModel, loadProductionHistory, revisionLabel, dateLabel, sha256 } from './balance-data.js';

export function createDiffTable(React) {
  const { createElement: h } = React;
  return function DiffTable({ rows, catalog, beforeCatalog = catalog, selected, onSelect }) {
    const groups = new Map();
    for (const row of rows) { if (!groups.has(row.group)) groups.set(row.group, []); groups.get(row.group).push(row); }
    return h('div', { className: 'balance-diff' }, h('table', {},
      h('thead', {}, h('tr', {}, onSelect && h('th', { className: 'balance-check', 'aria-label': 'Выбор параметров' }), ...['Параметр', 'Было', 'Стало'].map(label => h('th', { key: label, scope: 'col' }, label)))),
      h('tbody', {}, ...[...groups].flatMap(([group, entries]) => [
        h('tr', { key: `group-${group}`, className: 'balance-diff-group' }, h('th', { colSpan: onSelect ? 4 : 3, scope: 'rowgroup' }, group)),
        ...entries.map(row => h('tr', { key: row.id },
          onSelect && h('td', { className: 'balance-check' }, h('input', { type: 'checkbox', checked: selected.has(row.id), onChange: event => onSelect(row.id, event.target.checked), 'aria-label': `Применить: ${row.group} — ${row.field.label}` })),
          h('th', { scope: 'row', title: row.field.hint }, row.field.label,
            !!row.impacts.length && h('details', {}, h('summary', {}, `Наследуемые типы (${row.impacts.length})`),
              ...row.impacts.map(impact => h('p', { key: impact.label }, `${impact.label}: ${formatValue(impact.from, row.field, beforeCatalog)} → ${formatValue(impact.to, row.field, catalog)}`)))),
          h('td', {}, formatState(row.from, row, beforeCatalog)), h('td', {}, formatState(row.to, row, catalog))))
      ]))));
  };
}

export function registerBalanceHistory(CMS, selectedPromotion) {
  const { createElement: h, useEffect, useState, useRef } = CMS.React;
  const DiffTable = createDiffTable(CMS.React);

  function BalanceHistory({ channel, readonly, getDraftData, replaceDraft }) {
    const [history, setHistory] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState(null), [reload, setReload] = useState(0);
    const [dialog, setDialog] = useState(null), [selected, setSelected] = useState(new Set()), [actionError, setActionError] = useState(null);
    const request = useRef(null), alive = useRef(true);
    const close = () => { request.current?.abort(); setDialog(null); setActionError(null); };
    useEffect(() => {
      alive.current = true;
      return () => { alive.current = false; request.current?.abort(); };
    }, []);
    useEffect(() => {
      let mounted = true;
      setLoading(true); setError(null);
      const promise = channel === 'test' ? fetchJson('../v1/balance/test-history.json', 'Не удалось загрузить историю test') : loadProductionHistory(reload > 0);
      promise.then(items => {
        if (!Array.isArray(items)) throw Error('Повреждена история баланса');
        if (mounted) { setHistory(items); setLoading(false); }
      }).catch(ex => { if (mounted) { setError(ex.message); setLoading(false); } });
      return () => { mounted = false; };
    }, [reload, channel]);

    const open = async (revision, index) => {
      request.current?.abort();
      const controller = request.current = new AbortController();
      setSelected(new Set()); setActionError(null); setDialog({ revision, loading: true });
      try {
        const previous = channel === 'test' ? history.find(item => item.sourceCommit === revision.parentSourceCommit) : history[index + 1];
        if (channel === 'test' && revision.parentSourceCommit && !previous) throw Error('Предыдущая ревизия недоступна для сравнения. Повторите загрузку истории.');
        const [model, before, currentCatalog] = await Promise.all([loadModel(revision, controller.signal), previous ? loadModel(previous, controller.signal) : null, getCatalog()]);
        const rows = definitionDiff(before?.definition || null, model.definition, model.catalog, before?.catalog || model.catalog);
        let incompatibility = revision.compatible === false ? revision.compatibilityError || 'Ревизия несовместима с текущим каталогом' : null;
        try {
          const resolved = resolveDefinition(model.definition, currentCatalog);
          if (await sha256(canonical(resolved.snapshot)) !== revision.hash) throw Error('Изменился контракт наследования');
        } catch (ex) { incompatibility = ex.message; }
        if (!controller.signal.aborted && alive.current) setDialog({ revision, model, before, currentCatalog, rows, incompatibility, loading: false });
      } catch (ex) { if (!controller.signal.aborted && alive.current) setDialog({ revision, loading: false, error: ex.message }); }
    };

    const apply = mode => {
      try {
        if (readonly || dialog.incompatibility || !dialog.model) throw Error('Восстановление этой ревизии недоступно');
        const current = getDraftData();
        if (channel === 'promotion') {
          const revision = selectedPromotion.lookup(dialog.revision);
          replaceDraft({ ...current, sourceCommit: revision.sourceCommit, expectedHash: revision.hash });
          selectedPromotion.pin(revision);
        } else {
          const next = mode === 'all' ? resolveDefinition(dialog.model.definition, dialog.currentCatalog).definition
            : applyRevisionFields(current, dialog.model.definition, dialog.rows.filter(row => selected.has(row.id)).map(row => row.path), dialog.currentCatalog);
          replaceDraft(next);
        }
        close();
      } catch (ex) { setActionError(dialog?.currentCatalog ? formatBalanceError(ex.message, dialog.currentCatalog) : ex.message); }
    };
    const label = revision => channel === 'test' ? revisionLabel(revision) : `${revision.author || 'Автор не указан'} · ${dateLabel(revision.publishedAt)}`;
    return h('div', { className: 'balance-history' },
      loading ? h('p', { role: 'status' }, 'Загрузка истории…') : error ? h('p', { role: 'alert', className: 'balance-error' }, error)
        : history.length ? h('div', { className: 'balance-history-list' }, ...history.map((revision, index) => h('button', { type: 'button', className: 'balance-history-item', key: revision.id || revision.sourceCommit, onClick: () => open(revision, index) },
          h('span', {}, revision.author || 'Автор не указан'), h('small', {}, channel === 'test' ? dateLabel(revision.committedAt) : dateLabel(revision.publishedAt)))))
          : h('p', {}, 'История публикаций пуста.'),
      !loading && h('button', { type: 'button', className: 'balance-button', style: { marginTop: 12 }, onClick: () => setReload(value => value + 1) }, error ? 'Повторить загрузку' : 'Обновить историю'),
      dialog && h('dialog', { className: 'balance-dialog', 'aria-labelledby': 'balance-history-dialog-title', onCancel: event => { event.preventDefault(); close(); }, ref: element => { if (element && !element.open) element.showModal(); } },
        h('header', { className: 'balance-dialog-header' }, h('h2', { id: 'balance-history-dialog-title' }, `Изменения ревизии: ${label(dialog.revision)}`), h('button', { type: 'button', className: 'balance-button', onClick: close, 'aria-label': 'Закрыть историю ревизии' }, 'Закрыть')),
        h('div', { className: 'balance-dialog-body' },
          dialog.loading ? h('p', { role: 'status' }, 'Загрузка параметров…') : dialog.error ? h('p', { role: 'alert', className: 'balance-error' }, dialog.error) : h('div', {},
            dialog.revision.comment && h('p', {}, dialog.revision.comment),
            dialog.incompatibility && h('p', { className: 'balance-error' }, `Восстановление недоступно: ${dialog.incompatibility}`),
            dialog.rows.length ? h(DiffTable, { rows: dialog.rows, catalog: dialog.model.catalog, beforeCatalog: dialog.before?.catalog || dialog.model.catalog, selected,
              onSelect: channel === 'test' && !readonly && !dialog.incompatibility ? (id, checked) => setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; }) : null }) : h('p', {}, 'Параметры баланса не изменились.')),
          actionError && h('p', { role: 'alert', className: 'balance-error' }, actionError)),
        h('footer', { className: 'balance-dialog-footer' },
          channel === 'test' && h('button', { type: 'button', className: 'balance-button', disabled: readonly || dialog.loading || !!dialog.error || !!dialog.incompatibility || !selected.size, onClick: () => apply('selected') }, `Применить выбранные поля (${selected.size})`),
          h('button', { type: 'button', className: 'balance-button', disabled: readonly || dialog.loading || !!dialog.error || !!dialog.incompatibility, onClick: () => apply('all') }, channel === 'test' ? 'Восстановить весь баланс' : 'Выбрать для отката'))));
  }
  CMS.registerHistoryTemplate('balance/test', props => h(BalanceHistory, { ...props, channel: 'test' }), { hidePreviewLinks: true });
  CMS.registerHistoryTemplate('balance/promotion', props => h(BalanceHistory, { ...props, channel: 'promotion' }), { hidePreviewLinks: true });
  return DiffTable;
}
