import { validateNewsDraft } from '../news-model.js';
import { normalizeMapEntry } from '../maps-model.js';

// Same rules as the publisher (scripts/build.mjs): an entry that would fail the build is never committed.
// A preSave error aborts the save and Sveltia shows its message in the editor.
export function registerContentValidation(CMS) {
  CMS.registerEventListener({
    name: 'preSave',
    handler({ entry }) {
      const collection = entry.get('collection');
      const slug = entry.get('slug');
      const data = entry.get('data').toJS();
      let errors;
      if (collection === 'news') errors = validateNewsDraft({ slug, data, i18n: entry.get('i18n')?.toJS() });
      else if (collection === 'maps') errors = normalizeMapEntry(slug, data).errors;
      if (errors?.length) throw new Error(`Cannot save: ${errors.join('; ')}`);
    }
  });
}
