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
  const payloads = new Map();
  const manifest = (channel, resolved, commit) => {
    const text = canonical(resolved.snapshot), digest = hash(text);
    const byteSize = Buffer.byteLength(text);
    if (byteSize > 512 * 1024) throw Error('Снимок баланса больше 512 КБ');
    payloads.set(digest, text);
    return { schemaVersion: resolved.snapshot.schemaVersion, channel, sourceCommit: commit, hash: digest, byteSize, url: `snapshots/${digest}.json` };
  };
  const testManifest = manifest('test', test, head), prodManifest = manifest('prod', prod, sourceCommit);
  const revisions = [{ ...testManifest, comment: 'Текущий test' }];
  // Keep all valid published revisions addressable. Rebuilds do not remove old snapshot URLs.
  const commits = (await git(root, 'log', '--format=%H', '--', 'content/balance/test.json')).split('\n').filter(Boolean);
  for (const commit of commits) {
    if (commit === head) continue;
    try {
      const historicalCatalog = JSON.parse(await git(root, 'show', `${commit}:schema/balance-catalog.json`));
      const historical = resolveDefinition(JSON.parse(await git(root, 'show', `${commit}:content/balance/test.json`)), historicalCatalog);
      const revision = manifest('test', historical, commit);
      revisions.push({ ...revision, comment: await git(root, 'show', '-s', '--format=%s', commit) });
    } catch (err) { console.warn(`Balance history: skipping invalid revision ${commit.slice(0, 8)} (${err.message})`); }
  }
  return { payloads, testManifest, prodManifest, revisions, preview: { catalog, test: { ...test, manifest: testManifest }, prod: { ...prod, manifest: prodManifest }, promotion } };
}
