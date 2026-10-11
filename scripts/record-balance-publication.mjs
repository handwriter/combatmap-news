// Run only AFTER the Pages deploy job succeeds. --dry-run performs read-only inspection.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readPublications, validPublication, PUBLICATION_KIND } from '../site/balance-publications.js';

const args = process.argv.slice(2), dryRun = args.includes('--dry-run');
const metadataDir = path.resolve(args.find(arg => !arg.startsWith('--')) || 'dist/v1/balance');
const current = JSON.parse(await readFile(path.join(metadataDir, 'publication.json'), 'utf8'));
const index = JSON.parse(await readFile(path.join(metadataDir, 'production-history.json'), 'utf8'));
if (!validPublication(current)) throw Error('Invalid current balance publication metadata');
const repository = process.env.GITHUB_REPOSITORY || 'handwriter/combatmap-news';
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error('Invalid GitHub repository');
const apiBase = process.env.COMBATMAP_GITHUB_API || 'https://api.github.com';
const token = process.env.GITHUB_TOKEN;
if (!dryRun && !token) throw Error('GITHUB_TOKEN with deployments:write is required');
async function api(route, body) {
  const response = await fetch(`${apiBase}/repos/${repository}${route}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error(`GitHub ${body ? 'POST' : 'GET'} ${route}: HTTP ${response.status}`);
  return response.json();
}

const records = await readPublications(index, api);
if (!records.some(record => record.id === current.id && record.hash === current.hash)) throw Error('The current balance has no confirmed successful Pages deployment. Retry this job after deployment status becomes available.');
const markSuccess = id => api(`/deployments/${id}/statuses`, { state: 'success', auto_inactive: false, environment: 'balance-production', description: 'Published balance confirmed by the successful Pages deployment' });
// Recover a job interrupted after creation without creating a second publication event.
if (!dryRun) for (const record of records.filter(item => item.recorded)) {
  const statuses = await api(`/deployments/${record.auditDeploymentId}/statuses`);
  if (!Array.isArray(statuses)) throw Error('Invalid balance deployment statuses');
  if (!statuses.some(status => status.state === 'success')) await markSuccess(record.auditDeploymentId);
}
for (const record of records.filter(item => !item.recorded).reverse()) {
  if (dryRun) { console.log(`Would record ${record.id.slice(0, 8)}: ${record.publishedAt || 'publication date unknown'}`); continue; }
  const publication = Object.fromEntries(['id', 'sourceCommit', 'hash', 'schemaVersion', 'author', 'comment', 'modelUrl'].map(key => [key, record[key]]));
  const deployment = await api('/deployments', {
    ref: record.id, environment: 'balance-production', auto_merge: false, required_contexts: [], production_environment: true, transient_environment: false,
    description: 'Combat Map balance publication',
    payload: { kind: PUBLICATION_KIND, version: 1, publication, publishedAt: record.publishedAt, orderAt: record.orderAt, pagesDeploymentId: record.deploymentId },
  });
  await markSuccess(deployment.id);
  console.log(`Recorded balance publication ${record.id.slice(0, 8)}`);
}
console.log(`${records.filter(record => !record.recorded).length} new publication(s); existing dates preserved.`);
