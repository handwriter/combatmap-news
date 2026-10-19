// Shared news model: the CMS (preSave) and the publisher validate entries with the same rules.

export const LOCALES = ['en', 'ru', 'tr', 'fr', 'ar'];
export const DEFAULT_LOCALE = 'en';
export const TYPES = ['news', 'event', 'update'];
export const LIMITS = { title: 80, text: 280 };

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+(\.\d+)*$/;

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export function isValidLinkUrl(url) {
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

  // Every saved entry is published: the feed has a single source, no drafts.
  const entry = { id };

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
  // The whole card is the link (no button in the UI). The CMS field keeps its historical
  // name "buttonUrl"; "buttonLabel" from older entries is ignored.
  if (!isBlank(base.buttonUrl)) {
    entry.url = String(base.buttonUrl).trim();
    if (!isValidLinkUrl(entry.url)) errors.push(`buttonUrl: "${entry.url}" must be a valid https:// link`);
  }

  return { errors, entry };
}

/**
 * Validates an unsaved CMS draft the way the publisher will read the saved file.
 * `data` holds the default locale (all fields), `i18n` maps other locales to { data }.
 */
export function validateNewsDraft({ slug, data, i18n = {} }) {
  const raw = { [DEFAULT_LOCALE]: data };
  for (const [locale, value] of Object.entries(i18n ?? {})) {
    if (locale !== DEFAULT_LOCALE && value?.data) raw[locale] = value.data;
  }
  return normalizeEntry(slug, raw).errors.map((e) => e.startsWith('file name')
    ? `${e} — it is generated from the English title; remove trailing punctuation or symbols such as "_" from the title, or delete the item and create it again`
    : e);
}
