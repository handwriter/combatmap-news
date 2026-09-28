import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFeed, isValidButtonUrl, normalizeEntry } from './build.mjs';


const valid = (overrides = {}, translations = {}) => ({
  en: {
    draft: false,
    type: 'event',
    priority: 10,
    publishedAt: '2026-09-28T10:00:00.000Z',
    title: 'Autumn Offensive',
    text: 'Weekend tournament',
    buttonLabel: 'Join',
    buttonUrl: 'https://discord.gg/q9pkrkHKvY',
    ...overrides,
  },
  ...translations,
});

test('valid entry is normalized with translations', () => {
  const { errors, entry } = normalizeEntry('2026-09-28-autumn', valid({}, { ru: { title: 'Осеннее наступление' } }));
  assert.deepEqual(errors, []);
  assert.deepEqual(entry.title, { en: 'Autumn Offensive', ru: 'Осеннее наступление' });
  assert.equal(entry.buttonUrl, 'https://discord.gg/q9pkrkHKvY');
  assert.equal(entry.draft, false);
});

test('only title.en and publishedAt are required; blank optional fields are dropped', () => {
  const { errors, entry } = normalizeEntry('minimal', {
    en: { publishedAt: '2026-09-28', title: 'Hi', text: '', buttonLabel: '', buttonUrl: '', image: '', startsAt: null },
  });
  assert.deepEqual(errors, []);
  assert.equal(entry.type, 'news');
  assert.equal(entry.priority, 0);
  assert.equal(entry.draft, true, 'draft defaults to true so half-filled entries stay hidden');
  assert.deepEqual(entry.text, {});
  assert.equal(entry.buttonUrl, undefined);
  assert.equal(entry.image, undefined);
});

test('missing english title fails', () => {
  const { errors } = normalizeEntry('x', valid({ title: '' }, { ru: { title: 'Только русский' } }));
  assert.ok(errors.includes('title.en: required'));
});

test('limits, dates, versions and button pairing are checked', () => {
  const { errors } = normalizeEntry('x', valid({
    title: 'x'.repeat(81),
    startsAt: '2026-10-05T00:00:00Z',
    endsAt: '2026-10-01T00:00:00Z',
    minGameVersion: 'v1',
    buttonLabel: '',
  }));
  assert.ok(errors.some((e) => e.startsWith('title.en: 81 chars')));
  assert.ok(errors.includes('endsAt: must be later than startsAt'));
  assert.ok(errors.some((e) => e.startsWith('minGameVersion')));
  assert.ok(errors.includes('buttonLabel.en: required when buttonUrl is set'));
});

test('button url must be a valid https link on any host', () => {
  assert.ok(normalizeEntry('x', valid({ buttonUrl: 'http://discord.gg/abc' })).errors.length > 0);
  assert.deepEqual(normalizeEntry('x', valid({ buttonUrl: 'https://test.com' })).errors, []);
  assert.ok(isValidButtonUrl('https://store.steampowered.com/app/4929920'));
  assert.ok(!isValidButtonUrl('https://'));
  assert.ok(!isValidButtonUrl('javascript:alert(1)'));
});

test('bad file names are rejected', () => {
  assert.ok(normalizeEntry('Autumn News', valid()).errors.some((e) => e.startsWith('file name')));
});

test('feed hides drafts and long-expired items and sorts by priority then date', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const make = (id, en) => normalizeEntry(id, valid(en)).entry;
  const entries = [
    make('old', { priority: 0, publishedAt: '2026-09-01T00:00:00Z' }),
    make('new', { priority: 0, publishedAt: '2026-10-01T00:00:00Z' }),
    make('pinned', { priority: 50, publishedAt: '2026-08-01T00:00:00Z' }),
    make('draft', { draft: true }),
    make('expired', { endsAt: '2026-10-01T00:00:00Z' }),
    make('recently-ended', { endsAt: '2026-10-18T00:00:00Z' }),
  ];
  const images = new Map();
  const live = buildFeed(entries, { includeDrafts: false, now, images });
  assert.deepEqual(live.items.map((i) => i.id), ['pinned', 'recently-ended', 'new', 'old']);
  assert.equal(live.schemaVersion, 1);
  assert.ok(live.items.every((i) => !('draft' in i)));

  const preview = buildFeed(entries, { includeDrafts: true, now, images });
  assert.ok(preview.items.find((i) => i.id === 'draft').draft);
});

test('feed item omits absent optional blocks', () => {
  const { entry } = normalizeEntry('bare', { en: { draft: false, publishedAt: '2026-09-28', title: 'Hi' } });
  const [item] = buildFeed([entry], { includeDrafts: false, now: new Date('2026-09-29'), images: new Map() }).items;
  assert.deepEqual(Object.keys(item), ['id', 'type', 'priority', 'publishedAt', 'title']);
});
