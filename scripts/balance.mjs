import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
import { canonical, convertSnapshot, resolveDefinition, validateSnapshot, validatePromotion } from '../site/balance-model.js';
export { canonical, convertSnapshot, normalizeDefinition, resolveDefinition, validateSnapshot } from '../site/balance-model.js';
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
// Every schema the site still serves: the current catalog plus frozen catalogs of schemas that
// released clients use. Each legacy schema also keeps frozen per-channel snapshots: they supply
// values the current model cannot express in that schema.
export async function supportedSchemas(root) {
  const current = await json(root, 'schema/balance-catalog.json');
  const schemas = new Map([[current.schemaVersion, { catalog: current }]]);
  let files = [];
  try { files = await readdir(path.join(root, 'schema/legacy')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const file of files) {
    const match = /^balance-catalog\.v(\d+)\.json$/.exec(file);
    if (!match) continue;
    const catalog = await json(root, `schema/legacy/${file}`);
    if (catalog.schemaVersion !== Number(match[1]) || catalog.schemaVersion >= current.schemaVersion) throw Error(`schema/legacy/${file}: неверная версия схемы`);
    const fallback = {};
    for (const channel of ['test', 'prod']) {
      fallback[channel] = await json(root, `content/balance/legacy/v${catalog.schemaVersion}/${channel}.json`);
      validateSnapshot(fallback[channel], catalog);
    }
    schemas.set(catalog.schemaVersion, { catalog, fallback });
  }
  return { current, schemas };
}
export async function buildBalance(root) {
  const { current: catalog, schemas } = await supportedSchemas(root);
  const test = resolveDefinition(await json(root, 'content/balance/test.json'), catalog);
  let exported;
  const promotion = await json(root, 'content/balance/promotion.json');
  validatePromotion(promotion);
  const head = await git(root, 'rev-parse', 'HEAD');
  let prod, prodCatalog, sourceCommit;
  if (promotion.sourceCommit === '') {
    // The initial release is an immutable exported baseline, independent of subsequent test edits.
    const bootstrap = await json(root, 'content/balance/prod-bootstrap.json');
    prodCatalog = schemas.get(bootstrap.schemaVersion)?.catalog;
    if (!prodCatalog) throw Error(`prod-bootstrap.json: схема ${bootstrap.schemaVersion} больше не поддерживается`);
    prod = resolveDefinition(bootstrap, prodCatalog);
    sourceCommit = await git(root, 'log', '-1', '--format=%H', '--', 'content/balance/prod-bootstrap.json') || head;
  } else {
    if (!/^[a-f0-9]{40}$/.test(promotion.sourceCommit)) throw Error('Продвижение требует полный Git SHA (40 символов)');
    sourceCommit = promotion.sourceCommit;
    await git(root, 'merge-base', '--is-ancestor', sourceCommit, head);
    prodCatalog = JSON.parse(await git(root, 'show', `${sourceCommit}:schema/balance-catalog.json`));
    const historicDefinition = JSON.parse(await git(root, 'show', `${sourceCommit}:content/balance/test.json`));
    // The promoted revision keeps its own schema; every served schema gets a converted copy below.
    prod = resolveDefinition(historicDefinition, prodCatalog);
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
  // Client-facing output per schema: s{N}/{channel}.json with its own snapshots directory.
  const schemaOutputs = [];
  for (const [schemaVersion, schema] of [...schemas].sort((a, b) => a[0] - b[0])) {
    // The Unity export fills fields a promoted older revision lacks in the current schema.
    const fallback = async channel => schemaVersion !== catalog.schemaVersion ? schema.fallback[channel]
      : exported ??= resolveDefinition(await json(root, 'content/balance/exported-baseline.json'), catalog).snapshot;
    const output = { schemaVersion, payloads: new Map() };
    for (const [channel, resolved, from, commit] of [['test', test, catalog, head], ['prod', prod, prodCatalog, sourceCommit]]) {
      const snapshot = canonical(from) === canonical(schema.catalog) ? resolved.snapshot
        : convertSnapshot(resolved.snapshot, from, schema.catalog, await fallback(channel));
      const text = canonical(snapshot), digest = hash(text);
      output.payloads.set(digest, text);
      output[channel] = { snapshot, manifest: { schemaVersion, channel, sourceCommit: commit, hash: digest, byteSize: Buffer.byteLength(text), url: `snapshots/${digest}.json` } };
    }
    schemaOutputs.push(output);
  }
  const currentOutput = schemaOutputs.find(o => o.schemaVersion === catalog.schemaVersion);
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
    schemaOutputs,
    // The preview page renders the current catalog, so prod is shown converted to it.
    preview: { catalog, test: { ...test, manifest: testManifest }, prod: { ...prod, snapshot: currentOutput.prod.snapshot, manifest: prodManifest }, promotion } };
}
