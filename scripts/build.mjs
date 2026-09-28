// Builds the published site (dist/) from the CMS content:
//   content/news/*.json  ->  dist/v1/news.json, dist/v1/news.preview.json, dist/v1/img/*.jpg
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LOCALES = ['en', 'ru', 'tr', 'fr', 'ar'];
export const DEFAULT_LOCALE = 'en';
export const TYPES = ['news', 'event', 'update'];
export const LIMITS = { title: 80, text: 280, buttonLabel: 24 };
export const IMAGE_SIZE = { width: 640, height: 360 };
/** Expired items stay in the feed for a week so clients with a slightly wrong clock still hide them themselves. */
export const EXPIRED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+(\.\d+)*$/;

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export function isValidButtonUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname !== '';
  } catch {
    return false;
  }
}

function parseDate(value, field, errors) {
  if (isBlank(value)) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    errors.push(`${field}: not a valid date "${value}"`);
    return undefined;
  }
  return new Date(ms).toISOString();
}

function localized(raw, field, errors) {
  const result = {};
  for (const locale of LOCALES) {
    const value = raw[locale]?.[field];
    if (isBlank(value)) continue;
    if (typeof value !== 'string') {
      errors.push(`${field}.${locale}: must be text`);
      continue;
    }
    const text = value.trim();
    if (LIMITS[field] && text.length > LIMITS[field]) {
      errors.push(`${field}.${locale}: ${text.length} chars, max ${LIMITS[field]}`);
    }
    result[locale] = text;
  }
  return result;
}

/**
 * Validates one CMS entry (Sveltia i18n "single_file": { en: {...all fields}, ru: {...translations} })
 * and returns it normalized. Non-translatable fields live under the default locale.
 */
export function normalizeEntry(id, raw) {
  const errors = [];
  if (!ID_PATTERN.test(id)) errors.push(`file name "${id}" must be lowercase latin, digits and dashes`);

  const base = raw?.[DEFAULT_LOCALE];
  if (typeof base !== 'object' || base === null) {
    return { errors: [`missing "${DEFAULT_LOCALE}" section — is this a CMS news file?`] };
  }

  const entry = { id, draft: base.draft !== false };

  entry.type = isBlank(base.type) ? 'news' : base.type;
  if (!TYPES.includes(entry.type)) errors.push(`type: "${entry.type}" must be one of ${TYPES.join(', ')}`);

  entry.priority = isBlank(base.priority) ? 0 : Number(base.priority);
  if (!Number.isInteger(entry.priority) || entry.priority < 0 || entry.priority > 100) {
    errors.push(`priority: "${base.priority}" must be an integer 0–100`);
  }

  entry.publishedAt = parseDate(base.publishedAt, 'publishedAt', errors);
  if (!entry.publishedAt && isBlank(base.publishedAt)) errors.push('publishedAt: required');
  entry.startsAt = parseDate(base.startsAt, 'startsAt', errors);
  entry.endsAt = parseDate(base.endsAt, 'endsAt', errors);
  if (entry.startsAt && entry.endsAt && entry.endsAt <= entry.startsAt) {
    errors.push('endsAt: must be later than startsAt');
  }

  for (const field of ['minGameVersion', 'maxGameVersion']) {
    if (isBlank(base[field])) continue;
    const value = String(base[field]).trim();
    if (!VERSION_PATTERN.test(value)) errors.push(`${field}: "${value}" must look like 0.107`);
    else entry[field] = value;
  }

  if (!isBlank(base.image)) entry.image = String(base.image).trim();

  entry.title = localized(raw, 'title', errors);
  if (!entry.title[DEFAULT_LOCALE]) errors.push('title.en: required');
  entry.text = localized(raw, 'text', errors);
  entry.buttonLabel = localized(raw, 'buttonLabel', errors);

  if (!isBlank(base.buttonUrl)) {
    entry.buttonUrl = String(base.buttonUrl).trim();
    if (!isValidButtonUrl(entry.buttonUrl)) {
      errors.push(`buttonUrl: "${entry.buttonUrl}" must be a valid https:// link`);
    }
    if (!entry.buttonLabel[DEFAULT_LOCALE]) errors.push('buttonLabel.en: required when buttonUrl is set');
  } else if (Object.keys(entry.buttonLabel).length > 0) {
    errors.push('buttonUrl: required when buttonLabel is set');
  }

  return { errors, entry };
}

/** Selects, orders and shapes entries for the feed. `images` maps entry.image -> { url, width, height }. */
export function buildFeed(entries, { includeDrafts, now, images }) {
  const items = entries
    .filter((e) => includeDrafts || !e.draft)
    .filter((e) => !e.endsAt || Date.parse(e.endsAt) + EXPIRED_GRACE_MS > now.getTime())
    .sort((a, b) => b.priority - a.priority || b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id))
    .map((e) => {
      const item = { id: e.id, type: e.type, priority: e.priority };
      if (e.draft) item.draft = true;
      item.publishedAt = e.publishedAt;
      for (const key of ['startsAt', 'endsAt', 'minGameVersion', 'maxGameVersion']) {
        if (e[key]) item[key] = e[key];
      }
      if (e.image) item.image = images.get(e.image);
      item.title = e.title;
      if (Object.keys(e.text).length > 0) item.text = e.text;
      if (e.buttonUrl) item.button = { label: e.buttonLabel, url: e.buttonUrl };
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
    console.error(`News build failed (${problems.length} problem(s)):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  const dist = path.join(ROOT, 'dist');
  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, 'v1/img'), { recursive: true });
  for (const [hash, buffer] of rendered) {
    await writeFile(path.join(dist, 'v1/img', `${hash}.jpg`), buffer);
  }

  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(await readFile(path.join(ROOT, 'schema/news-feed.schema.json'), 'utf8')));

  const now = new Date();
  for (const [name, includeDrafts] of [['news.json', false], ['news.preview.json', true]]) {
    const feed = buildFeed(entries, { includeDrafts, now, images });
    if (!validate(feed)) {
      console.error(`${name} does not match the feed schema:`, validate.errors);
      process.exit(1);
    }
    await writeFile(path.join(dist, 'v1', name), `${JSON.stringify(feed, null, 2)}\n`);
    console.log(`v1/${name}: ${feed.items.length} item(s)`);
  }

  await cp(path.join(ROOT, 'admin'), path.join(dist, 'admin'), { recursive: true });
  await cp(path.join(ROOT, 'site'), dist, { recursive: true });
  await cp(path.join(ROOT, 'schema'), path.join(dist, 'schema'), { recursive: true });
  console.log(`dist/ ready (${images.size} image(s))`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
