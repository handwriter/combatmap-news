// Shared map catalog model: the CMS (preSave) and the publisher validate entries with the same rules.

export const MAP_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function normalizeMapEntry(id, raw) {
  const errors = [];
  if (!MAP_ID.test(id)) errors.push('file name must be 1–80 lowercase letters, digits and dashes');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [...errors, 'entry must be an object'] };
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.trim().length > 80) errors.push('title: required, max 80 characters');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') errors.push('enabled: must be boolean');
  const order = raw.order ?? 0;
  if (!Number.isSafeInteger(order) || order < 0) errors.push('order: must be a nonnegative integer');
  if (typeof raw.file !== 'string' || !/^\/map-files\/.+\.json$/.test(raw.file) || /[\\\x00]/.test(raw.file)) errors.push('file: must refer to /map-files/*.json');
  return { errors, entry: { id, name: typeof raw.title === 'string' ? raw.title.trim() : undefined, enabled: raw.enabled ?? true, order, file: raw.file } };
}
