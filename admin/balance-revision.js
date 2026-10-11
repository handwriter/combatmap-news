import { fetchJson, dateLabel, validManifest, revisionLabel, loadProductionHistory } from './balance-data.js';

export function registerBalanceRevision(CMS) {
  const { Component, createElement: h } = CMS.React;
  let active;

  class BalanceRevisionControl extends Component {
    state = { loading: true, error: null, revisions: [], prod: null, publication: null, publicationLoading: true, publicationError: null, publishedAt: null };
    selection = { ready: false, revision: null };

    componentDidMount() {
      active = this;
      this.load();
    }

    componentWillUnmount() {
      this.request?.abort();
      if (active === this) active = null;
    }

    load = async () => {
      this.request?.abort();
      const request = this.request = new AbortController();
      this.selection.ready = false;
      this.selection.revision = null;
      this.setState({ loading: true, error: null });
      try {
        const [revisions, prod, publication] = await Promise.all([
          fetchJson('../v1/balance/revisions.json', 'Не удалось загрузить ревизии test', request.signal),
          fetchJson('../v1/balance/prod.json', 'Не удалось загрузить текущий продакшн', request.signal),
          fetchJson('../v1/balance/publication.json', 'Не удалось загрузить сведения о продакшне', request.signal),
        ]);
        if (!Array.isArray(revisions) || !revisions.length) throw Error('Нет опубликованных ревизий test. Дождитесь успешной сборки сайта.');
        if (revisions.some(revision => !validManifest(revision) || revision.channel !== 'test')
          || new Set(revisions.map(revision => revision.sourceCommit)).size !== revisions.length
          || !validManifest(prod) || prod.channel !== 'prod'
          || !validManifest(publication) || publication.sourceCommit !== prod.sourceCommit || publication.hash !== prod.hash) throw Error('Опубликованный список ревизий повреждён.');
        if (request.signal.aborted) return;
        // Keep the exact pair loaded by this editor, even if a newer deployment appears.
        const choices = revisions.map(revision => Object.freeze({ ...revision }));
        this.selection.revision = choices[0];
        this.selection.ready = true;
        this.setState({ loading: false, error: null, revisions: choices, prod, publication });
        // A saved production commit is informational; each new editor starts with latest test.
        this.props.onChange(choices[0].sourceCommit);
        this.loadPublicationDate();
      } catch (error) {
        if (!request.signal.aborted) this.setState({ loading: false, error: error.message });
      }
    };

    loadPublicationDate = async (force = false) => {
      const request = this.request;
      this.setState({ publicationLoading: true, publicationError: null });
      try {
        const history = await loadProductionHistory(force);
        if (request !== this.request || request.signal.aborted) return;
        const current = history.find(item => item.id === this.state.publication.id && item.hash === this.state.prod.hash);
        this.setState({ publicationLoading: false, publishedAt: current?.publishedAt || null });
      } catch (error) {
        if (request === this.request && !request.signal.aborted) this.setState({ publicationLoading: false, publicationError: error.message, publishedAt: null });
      }
    };

    lookup = record => {
      const revision = this.state.revisions.find(item => item.sourceCommit === record.sourceCommit && item.hash === record.hash && item.schemaVersion === record.schemaVersion);
      if (!this.selection.ready || !revision) throw Error('Эта публикация несовместима с текущим каталогом или список ревизий ещё не загружен.');
      return revision;
    };

    pin = record => {
      this.selection.revision = this.lookup(record);
      this.forceUpdate();
    };

    choose = event => {
      const revision = this.state.revisions.find(item => item.sourceCommit === event.target.value);
      if (!revision || !this.selection.ready) return;
      this.selection.revision = revision;
      this.props.onChange(revision.sourceCommit);
    };

    isValid(value) {
      if (!this.selection.ready) return { error: { message: this.state.error || 'Дождитесь загрузки списка ревизий test.' } };
      if (value !== this.selection.revision?.sourceCommit) return { error: { message: 'Выберите опубликованную ревизию test из списка.' } };
      return true;
    }

    render() {
      const { forID, classNameWrapper, value } = this.props;
      const { loading, error, revisions, prod, publication, publicationLoading, publicationError, publishedAt } = this.state;
      return h('div', {},
        prod && h('p', { style: { margin: '0 0 12px', fontSize: 13 } },
          `Продакшн сейчас: ${publicationLoading ? 'Загрузка даты…' : dateLabel(publishedAt)} · ${publication.author || 'Автор не указан'}`),
        publicationError && h('div', { role: 'alert', style: { fontSize: 13, marginBottom: 12 } }, publicationError,
          h('button', { type: 'button', onClick: () => this.loadPublicationDate(true), style: { display: 'block', marginTop: 8 } }, 'Повторить загрузку даты')),
        h('div', { style: { position: 'relative' } }, h('select', {
          id: forID, className: classNameWrapper, value: this.selection.ready ? value : '',
          disabled: loading || !!error, onChange: this.choose,
          style: { width: '100%', padding: '10px 40px 10px 12px', boxSizing: 'border-box', borderRadius: 6, font: 'inherit', appearance: 'none', WebkitAppearance: 'none' },
          'aria-label': this.props.field.get('label'), 'aria-describedby': loading || error ? `${forID}-status` : undefined, 'aria-busy': loading,
        }, loading || error ? h('option', { value: '' }, loading ? 'Загрузка ревизий…' : 'Список ревизий недоступен')
          : revisions.map(revision => h('option', { key: revision.sourceCommit, value: revision.sourceCommit }, revisionLabel(revision)))),
          h('svg', { 'aria-hidden': true, width: 12, height: 8, viewBox: '0 0 12 8', style: { position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' } },
            h('path', { d: 'M1 1.5 6 6.5 11 1.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
        (loading || error) && h('p', { id: `${forID}-status`, role: error ? 'alert' : 'status', style: { fontSize: 13, margin: '8px 0', ...(error ? { color: '#b83c32' } : {}) } },
          error || 'Публикация доступна после загрузки списка.'),
        error && h('button', { type: 'button', onClick: this.load, style: { padding: '8px 12px', cursor: 'pointer' } }, 'Повторить загрузку'));
    }
  }

  CMS.registerFieldType('balance_revision', BalanceRevisionControl);
  const selected = sourceCommit => {
    if (!active?.selection.ready || !active.selection.revision || sourceCommit !== active.selection.revision.sourceCommit)
      throw Error('Публикация недоступна: загрузите список и выберите ревизию test.');
    return active.selection.revision;
  };
  selected.lookup = record => { if (!active) throw Error('Форма публикации не открыта'); return active.lookup(record); };
  selected.pin = record => { if (!active) throw Error('Форма публикации не открыта'); active.pin(record); };
  return selected;
}
