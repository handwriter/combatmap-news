import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
import { canonical, resolveDefinition, validateSnapshot, validatePromotion } from '../site/balance-model.js';
export { canonical, normalizeDefinition, resolveDefinition, validateSnapshot } from '../site/balance-model.js';
export const hash = text => createHash('sha256').update(text).digest('hex');

async function git(root, ...args) { return (await exec('git', args, { cwd: root, maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
const json = async (root, file) => JSON.parse(await readFile(path.join(root, file), 'utf8'));
async function commitInfo(root, commit) {
  const [committedAt, author, ...subject] = (await git(root, 'show', '-s', '--format=%cI%n%an%n%s', commit)).split('\n');
  return { committedAt, author, comment: subject.join('\n') || 'Баланс' };
}
const at = async (root, commit, file) => JSON.parse(await git(root, 'show', `${commit}:${file}`));
async function promoted(root, promotion, catalog, commit) {
  validatePromotion(promotion);
  if (promotion.sourceCommit === '') {
    const resolved = resolveDefinition(await at(root, commit, 'content/balance/prod-bootstrap.json'), catalog);
    const sourceCommit = await git(root, 'log', '-1', '--format=%H', commit, '--', 'content/balance/prod-bootstrap.json');
    return { ...resolved, catalog, sourceCommit };
  }
  await git(root, 'merge-base', '--is-ancestor', promotion.sourceCommit, commit);
  const historicalCatalog = await at(root, promotion.sourceCommit, 'schema/balance-catalog.json');
  return { ...resolveDefinition(await at(root, promotion.sourceCommit, 'content/balance/test.json'), historicalCatalog), catalog: historicalCatalog, sourceCommit: promotion.sourceCommit };
}
export async function buildBalance(root) {
  const catalog = await json(root, 'schema/balance-catalog.json');
  const test = resolveDefinition(await json(root, 'content/balance/test.json'), catalog);
  const promotion = await json(root, 'content/balance/promotion.json');
  validatePromotion(promotion);
  const head = await git(root, 'rev-parse', 'HEAD');
  let prod, sourceCommit;
  if (promotion.sourceCommit === '') {
    // The initial release is an immutable exported baseline, independent of subsequent test edits.
    prod = resolveDefinition(await json(root, 'content/balance/prod-bootstrap.json'), catalog);
    sourceCommit = await git(root, 'log', '-1', '--format=%H', '--', 'content/balance/prod-bootstrap.json') || head;
  } else {
    if (!/^[a-f0-9]{40}$/.test(promotion.sourceCommit)) throw Error('Продвижение требует полный Git SHA (40 символов)');
    sourceCommit = promotion.sourceCommit;
    await git(root, 'merge-base', '--is-ancestor', sourceCommit, head);
    const historicCatalog = JSON.parse(await git(root, 'show', `${sourceCommit}:schema/balance-catalog.json`));
    const historicDefinition = JSON.parse(await git(root, 'show', `${sourceCommit}:content/balance/test.json`));
    prod = resolveDefinition(historicDefinition, historicCatalog);
    validateSnapshot(prod.snapshot, catalog);
  }
  const prodText = canonical(prod.snapshot);
  if (!/^[a-f0-9]{64}$/.test(promotion.expectedHash) || hash(prodText) !== promotion.expectedHash) throw Error('Хэш выбранной ревизии prod не совпадает с ожидаемым');
  const payloads = new Map(), historyData = new Map();
  const manifest = (channel, resolved, commit) => {
    const text = canonical(resolved.snapshot), digest = hash(text);
    const byteSize = Buffer.byteLength(text);
    if (byteSize > 512 * 1024) throw Error('Снимок баланса больше 512 КБ');
    payloads.set(digest, text);
    return { schemaVersion: resolved.snapshot.schemaVersion, channel, sourceCommit: commit, hash: digest, byteSize, url: `snapshots/${digest}.json` };
  };
  const testManifest = manifest('test', test, head), prodManifest = manifest('prod', prod, sourceCommit);
  const modelUrl = (resolved, modelCatalog) => {
    const text = canonical({ definition: resolved.definition, catalog: modelCatalog });
    const url = `history/${hash(text)}.json`;
    historyData.set(url, text);
    return url;
  };
  const compatibility = resolved => {
    try {
      validateSnapshot(resolved.snapshot, catalog);
      const current = resolveDefinition(resolved.definition, catalog);
      if (canonical(current.snapshot) !== canonical(resolved.snapshot)) throw Error('Изменился контракт наследования');
      return { compatible: true };
    } catch (error) { return { compatible: false, compatibilityError: error.message }; }
  };
  const revisions = [{ ...testManifest, ...await commitInfo(root, head), modelUrl: modelUrl(test, catalog) }];
  const testHistory = [];
  // Keep all valid published revisions addressable. Rebuilds do not remove old snapshot URLs.
  const commits = (await git(root, 'log', '--first-parent', '--format=%H', '--', 'content/balance/test.json')).split('\n').filter(Boolean);
  for (const [index, commit] of commits.entries()) {
    try {
      const historicalCatalog = JSON.parse(await git(root, 'show', `${commit}:schema/balance-catalog.json`));
      const historical = resolveDefinition(JSON.parse(await git(root, 'show', `${commit}:content/balance/test.json`)), historicalCatalog);
      const revision = manifest('test', historical, commit);
      const entry = { ...revision, ...await commitInfo(root, commit), ...compatibility(historical), modelUrl: modelUrl(historical, historicalCatalog), parentSourceCommit: commits[index + 1] || null };
      testHistory.push(entry);
      // Incompatible models remain inspectable, but cannot be promoted or restored.
      if (entry.compatible && commit !== head) revisions.push(entry);
    } catch (err) { console.warn(`Balance history: skipping invalid revision ${commit.slice(0, 8)} (${err.message})`); }
  }
  const promotionCommits = (await git(root, 'log', '--first-parent', '--format=%H', '--', 'content/balance/promotion.json')).split('\n').filter(Boolean);
  const publications = [];
  for (const commit of promotionCommits) {
    try {
      const saved = await at(root, commit, 'content/balance/promotion.json');
      const historical = await promoted(root, saved, await at(root, commit, 'schema/balance-catalog.json'), commit);
      const revision = manifest('prod', historical, historical.sourceCommit);
      if (revision.hash !== saved.expectedHash) throw Error('Хэш публикации не совпадает');
      publications.push({ id: commit, ...revision, ...await commitInfo(root, commit), comment: saved.comment, ...compatibility(historical), modelUrl: modelUrl(historical, historical.catalog) });
    } catch (error) { console.warn(`Balance publication history: skipping ${commit.slice(0, 8)} (${error.message})`); }
  }
  // A publication may reference a site commit that did not change test.json. Keep that
  // exact SHA/hash available for rollback, rather than substituting the file's commit.
  for (const publication of publications.filter(item => item.compatible)) {
    if (revisions.some(item => item.sourceCommit === publication.sourceCommit)) continue;
    const sourceCatalog = await at(root, publication.sourceCommit, 'schema/balance-catalog.json');
    const source = resolveDefinition(await at(root, publication.sourceCommit, 'content/balance/test.json'), sourceCatalog);
    const revision = manifest('test', source, publication.sourceCommit);
    if (revision.hash !== publication.hash) continue;
    revisions.push({ ...revision, ...await commitInfo(root, publication.sourceCommit), modelUrl: modelUrl(source, sourceCatalog) });
  }
  // Associate site deployments (including unrelated content commits) with the active promotion.
  const deploymentCommits = {}, mainCommits = (await git(root, 'rev-list', '--first-parent', head)).split('\n');
  let promotionIndex = 0;
  for (const commit of mainCommits) {
    if (!promotionCommits[promotionIndex]) break;
    deploymentCommits[commit] = promotionCommits[promotionIndex];
    if (commit === promotionCommits[promotionIndex]) promotionIndex++;
  }
  const publication = publications.find(item => item.id === promotionCommits[0]);
  if (!publication || publication.hash !== prodManifest.hash || publication.sourceCommit !== prodManifest.sourceCommit) throw Error('Сохранённая публикация prod не соответствует сборке. Сначала зафиксируйте promotion.json в Git.');
  const orderedRevisions = [revisions[0], ...revisions.slice(1).sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt))];
  return { payloads, historyData, testManifest, prodManifest, revisions: orderedRevisions, testHistory,
    publication: { ...publication, deployCommit: head }, productionHistory: { publications, deploymentCommits },
    preview: { catalog, test: { ...test, manifest: testManifest }, prod: { ...prod, manifest: prodManifest }, promotion } };
}
