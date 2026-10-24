// Builds the published site (dist/) from the CMS content:
//   content/news/*.json  ->  dist/v1/news.json, dist/v1/img/*.jpg
//   admin/               ->  dist/admin/
// Any invalid entry fails the build, so a broken edit never reaches players:
// the previous deployment stays live until the entry is fixed.

import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import sharp from 'sharp';
import { buildMaps } from './maps.mjs';
import { buildBalance } from './balance.mjs';
import { normalizeEntry } from '../site/news-model.js';
export { DEFAULT_LOCALE, LIMITS, LOCALES, TYPES, isValidLinkUrl, normalizeEntry, validateNewsDraft } from '../site/news-model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const IMAGE_SIZE = { width: 640, height: 360 };
/** Expired items stay in the feed for a week so clients with a slightly wrong clock still hide them themselves. */
export const EXPIRED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Selects, orders and shapes entries for the feed. `images` maps entry.image -> { url, width, height }. */
export function buildFeed(entries, { now, images }) {
  const items = entries
    .filter((e) => !e.endsAt || Date.parse(e.endsAt) + EXPIRED_GRACE_MS > now.getTime())
    .sort((a, b) => b.priority - a.priority || b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id))
    .map((e) => {
      const item = { id: e.id, type: e.type, priority: e.priority };
      item.publishedAt = e.publishedAt;
      for (const key of ['startsAt', 'endsAt', 'minGameVersion', 'maxGameVersion']) {
        if (e[key]) item[key] = e[key];
      }
      if (e.image) item.image = images.get(e.image);
      item.title = e.title;
      if (Object.keys(e.text).length > 0) item.text = e.text;
      if (e.url) item.url = e.url;
      return item;
    });
  return { schemaVersion: 1, generatedAt: now.toISOString(), items };
}

export async function renderImage(sourcePath) {
  const buffer = await sharp(sourcePath)
    .rotate()
    .resize(IMAGE_SIZE.width, IMAGE_SIZE.height, { fit: 'cover', position: 'attention' })
    .flatten({ background: '#d8d0be' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  const hash = createHash('sha1').update(buffer).digest('hex');
  return { hash, buffer };
}

async function readEntries() {
  const dir = path.join(ROOT, 'content/news');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  const entries = [];
  const problems = [];
  for (const file of files) {
    const id = file.slice(0, -'.json'.length);
    let raw;
    try {
      raw = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    } catch (err) {
      problems.push(`content/news/${file}: invalid JSON — ${err.message}`);
      continue;
    }
    const { errors, entry } = normalizeEntry(id, raw);
    if (errors.length > 0) problems.push(...errors.map((e) => `content/news/${file}: ${e}`));
    else entries.push(entry);
  }
  return { entries, problems };
}

async function main() {
  const { entries, problems } = await readEntries();
  const now = new Date();
  const maps = await buildMaps(ROOT, now);
  problems.push(...maps.problems);
  let balance;
  try { balance = await buildBalance(ROOT); }
  catch (err) { problems.push(`balance: ${err.message}`); }

  // Images: CMS stores "/media/<file>" (public_folder) for files in content/media (media_folder).
  const images = new Map();
  const rendered = new Map();
  for (const entry of entries) {
    if (!entry.image || images.has(entry.image)) continue;
    const relative = entry.image.replace(/^\/?media\//, '');
    const source = path.join(ROOT, 'content/media', relative);
    try {
      const { hash, buffer } = await renderImage(source);
      rendered.set(hash, buffer);
      images.set(entry.image, { url: `img/${hash}.jpg`, ...IMAGE_SIZE });
    } catch (err) {
      problems.push(`content/news/${entry.id}.json: image "${entry.image}" — ${err.message}`);
    }
  }

  if (problems.length > 0) {
    console.error(`Content build failed (${problems.length} problem(s)):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(await readFile(path.join(ROOT, 'schema/news-feed.schema.json'), 'utf8')));

  const feed = buildFeed(entries, { now, images });
  if (!validate(feed)) {
    console.error('news.json does not match the feed schema:', validate.errors);
    process.exit(1);
  }
  const validateMaps = ajv.compile(JSON.parse(await readFile(path.join(ROOT, 'schema/maps-feed.schema.json'), 'utf8')));
  if (!validateMaps(maps.feed)) {
    console.error('maps.json does not match the catalog schema:', validateMaps.errors);
    process.exit(1);
  }
  const validateBalance = ajv.compile(JSON.parse(await readFile(path.join(ROOT, 'schema/balance-snapshot.schema.json'), 'utf8')));
  const validateDefinition = ajv.compile(JSON.parse(await readFile(path.join(ROOT, 'schema/balance-definition.schema.json'), 'utf8')));
  const validateManifest = ajv.compile(JSON.parse(await readFile(path.join(ROOT, 'schema/balance-manifest.schema.json'), 'utf8')));
  // The editable model and both preview snapshots use the current schema; the promoted prod
  // definition may belong to an older one and is validated by its own catalog in buildBalance.
  if (!validateDefinition(balance.preview.test.definition)) throw new Error(`Invalid test balance: ${JSON.stringify(validateDefinition.errors)}`);
  for (const channel of ['test', 'prod']) {
    if (!validateBalance(balance.preview[channel].snapshot)) throw new Error(`Invalid ${channel} balance: ${JSON.stringify(validateBalance.errors)}`);
    for (const output of balance.schemaOutputs)
      if (!validateManifest(output[channel].manifest)) throw new Error(`Invalid s${output.schemaVersion} ${channel} manifest: ${JSON.stringify(validateManifest.errors)}`);
  }
  // Nothing replaces the previous output until BOTH feeds and every enabled map are valid.
  const dist = path.join(ROOT, 'dist');
  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, 'v1/img'), { recursive: true });
  await mkdir(path.join(dist, 'v1/maps'), { recursive: true });
  await mkdir(path.join(dist, 'v1/balance/snapshots'), { recursive: true });
  for (const [hash, text] of balance.payloads) await writeFile(path.join(dist, 'v1/balance/snapshots', `${hash}.json`), text);
  for (const output of balance.schemaOutputs) {
    // Schema 1 clients were released with {base}/{channel}.json; later schemas use s{N}/.
    const dirs = [`v1/balance/s${output.schemaVersion}`, ...(output.schemaVersion === 1 ? ['v1/balance'] : [])];
    for (const dir of dirs) {
      await mkdir(path.join(dist, dir, 'snapshots'), { recursive: true });
      for (const [hash, text] of output.payloads) await writeFile(path.join(dist, dir, 'snapshots', `${hash}.json`), text);
      for (const channel of ['test', 'prod']) await writeFile(path.join(dist, dir, `${channel}.json`), JSON.stringify(output[channel].manifest, null, 2) + '\n');
    }
  }
  await writeFile(path.join(dist, 'v1/balance/preview.json'), JSON.stringify(balance.preview) + '\n');
  await writeFile(path.join(dist, 'v1/balance/revisions.json'), JSON.stringify(balance.revisions) + '\n');
  await mkdir(path.join(dist, 'v1/balance/history'), { recursive: true });
  for (const [url, text] of balance.historyData) await writeFile(path.join(dist, 'v1/balance', url), text);
  await writeFile(path.join(dist, 'v1/balance/test-history.json'), JSON.stringify(balance.testHistory) + '\n');
  await writeFile(path.join(dist, 'v1/balance/production-history.json'), JSON.stringify(balance.productionHistory) + '\n');
  await writeFile(path.join(dist, 'v1/balance/publication.json'), JSON.stringify(balance.publication) + '\n');
  for (const [hash, buffer] of rendered) await writeFile(path.join(dist, 'v1/img', `${hash}.jpg`), buffer);
  for (const [hash, text] of maps.payloads) await writeFile(path.join(dist, 'v1/maps', `${hash}.json`), text);
  await writeFile(path.join(dist, 'v1/maps.json'), `${JSON.stringify(maps.feed, null, 2)}\n`);
  console.log(`v1/maps.json: ${maps.feed.items.length} map(s)`);
  await writeFile(path.join(dist, 'v1', 'news.json'), `${JSON.stringify(feed, null, 2)}\n`);
  console.log(`v1/news.json: ${feed.items.length} item(s)`);


  await cp(path.join(ROOT, 'admin'), path.join(dist, 'admin'), { recursive: true });
  await cp(path.join(ROOT, 'site'), dist, { recursive: true });
  await cp(path.join(ROOT, 'schema'), path.join(dist, 'schema'), { recursive: true });
  console.log(`dist/ ready (${images.size} image(s))`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
