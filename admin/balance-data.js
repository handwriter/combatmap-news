import { canonical, resolveDefinition } from '../balance-model.js';
import { readPublications } from '../balance-publications.js';

export const repository = 'handwriter/combatmap-news';
export const dateLabel = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : 'Дата публикации неизвестна';
export const revisionLabel = revision => `${revision.author || 'Автор не указан'} · ${dateLabel(revision.committedAt)}`;
export const validManifest = revision => revision && typeof revision.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(revision.sourceCommit)
  && typeof revision.hash === 'string' && /^[a-f0-9]{64}$/.test(revision.hash) && Number.isInteger(revision.schemaVersion) && revision.schemaVersion > 0;

export async function fetchJson(url, message, signal) {
  const request = new AbortController();
  const abort = () => request.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) request.abort();
  const timer = setTimeout(() => request.abort(), 10000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: request.signal });
    if (!response.ok) throw Error(`${message} (HTTP ${response.status})`);
    try { return await response.json(); } catch { throw Error(`${message}: ответ сервера повреждён.`); }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.name === 'AbortError') throw Error(`${message}: истекло время ожидания. Повторите загрузку.`);
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

let catalogPromise;
export const getCatalog = () => catalogPromise ??= fetchJson('../schema/balance-catalog.json', 'Не удалось загрузить каталог баланса').catch(error => { catalogPromise = null; throw error; });
export const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');

export async function loadModel(revision, signal) {
  if (!/^history\/[a-f0-9]{64}\.json$/.test(revision.modelUrl || '') || !validManifest(revision)) throw Error('Повреждена ссылка на модель ревизии');
  const model = await fetchJson(`../v1/balance/${revision.modelUrl}`, 'Не удалось загрузить параметры ревизии', signal);
  if (await sha256(canonical(model)) !== revision.modelUrl.slice(8, -5)) throw Error('Хэш исходной модели ревизии не совпадает');
  const resolved = resolveDefinition(model.definition, model.catalog);
  if (await sha256(canonical(resolved.snapshot)) !== revision.hash) throw Error('Хэш баланса ревизии не совпадает');
  return model;
}

let publicationRequest, publicationLoadedAt = 0;
export function loadProductionHistory(force = false) {
  if (force || !publicationRequest || Date.now() - publicationLoadedAt > 10000) {
    publicationLoadedAt = Date.now();
    publicationRequest = fetchJson('../v1/balance/production-history.json', 'Не удалось загрузить каталог публикаций').then(index =>
      readPublications(index, route => fetchJson(`https://api.github.com/repos/${repository}${route}`, 'Не удалось загрузить историю успешных публикаций')))
      .catch(error => { publicationRequest = null; throw error; });
  }
  return publicationRequest;
}
