import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFeed, isValidLinkUrl, normalizeEntry } from './build.mjs';


const valid = (overrides = {}, translations = {}) => ({
  en: {
    type: 'event',
    priority: 10,
    publishedAt: '2026-09-28T10:00:00.000Z',
    title: 'Autumn Offensive',
    text: 'Weekend tournament',
    buttonUrl: 'https://discord.gg/q9pkrkHKvY',
    ...overrides,
  },
  ...translations,
});

test('valid entry is normalized with translations', () => {
  const { errors, entry } = normalizeEntry('2026-09-28-autumn', valid({}, { ru: { title: 'Осеннее наступление' } }));
  assert.deepEqual(errors, []);
  assert.deepEqual(entry.title, { en: 'Autumn Offensive', ru: 'Осеннее наступление' });
  assert.equal(entry.url, 'https://discord.gg/q9pkrkHKvY');
});

test('only title.en and publishedAt are required; blank optional fields are dropped', () => {
  const { errors, entry } = normalizeEntry('minimal', {
    en: { publishedAt: '2026-09-28', title: 'Hi', text: '', buttonLabel: '', buttonUrl: '', image: '', startsAt: null },
  });
  assert.deepEqual(errors, []);
  assert.equal(entry.type, 'news');
  assert.equal(entry.priority, 0);
  assert.deepEqual(entry.text, {});
  assert.equal(entry.url, undefined);
  assert.equal(entry.image, undefined);
});

test('missing english title fails', () => {
  const { errors } = normalizeEntry('x', valid({ title: '' }, { ru: { title: 'Только русский' } }));
  assert.ok(errors.includes('title.en: required'));
});

test('limits, dates and versions are checked', () => {
  const { errors } = normalizeEntry('x', valid({
    title: 'x'.repeat(81),
    startsAt: '2026-10-05T00:00:00Z',
    endsAt: '2026-10-01T00:00:00Z',
    minGameVersion: 'v1',
  }));
  assert.ok(errors.some((e) => e.startsWith('title.en: 81 chars')));
  assert.ok(errors.includes('endsAt: must be later than startsAt'));
  assert.ok(errors.some((e) => e.startsWith('minGameVersion')));
});

test('card link must be a valid https link on any host', () => {
  assert.ok(normalizeEntry('x', valid({ buttonUrl: 'http://discord.gg/abc' })).errors.length > 0);
  assert.deepEqual(normalizeEntry('x', valid({ buttonUrl: 'https://test.com' })).errors, []);
  assert.ok(isValidLinkUrl('https://store.steampowered.com/app/4929920'));
  assert.ok(!isValidLinkUrl('https://'));
  assert.ok(!isValidLinkUrl('javascript:alert(1)'));
});

test('bad file names are rejected', () => {
  assert.ok(normalizeEntry('Autumn News', valid()).errors.some((e) => e.startsWith('file name')));
});

test('feed drops long-expired items and sorts by priority then date', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const make = (id, en) => normalizeEntry(id, valid(en)).entry;
  const entries = [
    make('old', { priority: 0, publishedAt: '2026-09-01T00:00:00Z' }),
    make('new', { priority: 0, publishedAt: '2026-10-01T00:00:00Z' }),
    make('pinned', { priority: 50, publishedAt: '2026-08-01T00:00:00Z' }),
    make('expired', { endsAt: '2026-10-01T00:00:00Z' }),
    make('recently-ended', { endsAt: '2026-10-18T00:00:00Z' }),
  ];
  const images = new Map();
  const live = buildFeed(entries, { now, images });
  assert.deepEqual(live.items.map((i) => i.id), ['pinned', 'recently-ended', 'new', 'old']);
  assert.equal(live.schemaVersion, 1);
});

test('legacy draft and buttonLabel fields are ignored and the link goes to item.url', () => {
  const { errors, entry } = normalizeEntry('x', valid({ buttonLabel: 'Join', draft: true }));
  assert.deepEqual(errors, []);
  const [item] = buildFeed([entry], { now: new Date('2026-09-29'), images: new Map() }).items;
  assert.equal(item.url, 'https://discord.gg/q9pkrkHKvY');
  assert.ok(!('button' in item));
});

test('feed item omits absent optional blocks', () => {
  const { entry } = normalizeEntry('bare', { en: { publishedAt: '2026-09-28', title: 'Hi' } });
  const [item] = buildFeed([entry], { now: new Date('2026-09-29'), images: new Map() }).items;
  assert.deepEqual(Object.keys(item), ['id', 'type', 'priority', 'publishedAt', 'title']);
});
