// Shared by the read-only admin and the post-deploy recorder. No credentials are stored here.
export const PUBLICATION_KIND = 'combatmap-balance-publication';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const validPublication = item => item && sha(item.id) && sha(item.sourceCommit) && hash(item.hash)
  && Number.isInteger(item.schemaVersion) && item.schemaVersion > 0 && typeof item.author === 'string'
  && /^history\/[a-f0-9]{64}\.json$/.test(item.modelUrl);

async function pages(api, route) {
  const result = [];
  for (let page = 1; ; page++) {
    const entries = await api(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(entries)) throw Error('Сервер вернул повреждённую историю публикаций');
    result.push(...entries);
    if (entries.length < 100) return result;
  }
}

export async function readPublications(index, api) {
  if (!index || !Array.isArray(index.publications) || index.publications.some(item => !validPublication(item)) || !index.deploymentCommits || typeof index.deploymentCommits !== 'object') throw Error('Повреждён каталог публикаций production');
  const candidates = new Map(index.publications.map(item => [item.id, item]));
  const recorded = new Map();
  const audits = await pages(api, '/deployments?environment=balance-production');
  for (const deployment of audits) {
    const payload = deployment.payload, stored = payload?.publication;
    if (payload?.kind !== PUBLICATION_KIND || payload.version !== 1 || !validPublication(stored)) continue;
    const candidate = candidates.get(stored.id);
    if (!candidate || candidate.hash !== stored.hash || candidate.sourceCommit !== stored.sourceCommit || candidate.schemaVersion !== stored.schemaVersion) continue;
    if (payload.publishedAt !== null && !date(payload.publishedAt)) throw Error('Повреждена дата публикации production');
    // Daily deployments and retried jobs must not produce duplicate balance events.
    if (!recorded.has(candidate.id)) recorded.set(candidate.id, { ...candidate, publishedAt: payload.publishedAt, orderAt: payload.orderAt || deployment.created_at, recorded: true, auditDeploymentId: deployment.id });
  }
  if (recorded.size < candidates.size) {
    const deployments = await pages(api, '/deployments?environment=github-pages');
    deployments.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const deployment of deployments) {
      const id = index.deploymentCommits[deployment.sha], candidate = candidates.get(id);
      if (!candidate || recorded.has(id)) continue;
      const statuses = await pages(api, `/deployments/${deployment.id}/statuses`);
      const success = statuses.filter(status => status.state === 'success' && date(status.created_at)).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
      if (success) recorded.set(id, { ...candidate, publishedAt: success.created_at, orderAt: success.created_at, recorded: false, deploymentId: deployment.id });
      // Old success statuses can expire. Confirm the successful Pages job before retaining an
      // event with an unknown publication date; never substitute a commit/build timestamp.
      else {
        const status = statuses.find(item => item.state === 'inactive' && /\/actions\/runs\/\d+/.test(item.log_url || ''));
        const runId = status?.log_url.match(/\/actions\/runs\/(\d+)/)?.[1];
        if (runId) {
          const run = await api(`/actions/runs/${runId}`);
          if (run.conclusion === 'success') recorded.set(id, { ...candidate, publishedAt: null, orderAt: deployment.created_at, recorded: false, deploymentId: deployment.id });
        }
      }
    }
  }
  return [...recorded.values()].sort((a, b) => Date.parse(b.orderAt) - Date.parse(a.orderAt));
}
