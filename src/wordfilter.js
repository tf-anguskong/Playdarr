'use strict';

// Offensive-word filter for user text. Built on `obscenity`'s English list, which also catches look-alike
// spellings (sh1t, fvck, b!tch) while leaving innocent words with a bad substring alone (Scunthorpe, assassin).
// Admins can turn it off, add words, or allow words it catches by mistake (Settings → Moderation); those settings
// are read on use, so the matcher is rebuilt only when one of them changes.
//
//   clean(text)  → chat: the same text with offending words replaced by asterisks
//   isClean(text) → names: false if anything matches (callers refuse the name with NAME_REFUSED)
const {
  RegExpMatcher, TextCensor, DataSet, englishDataset, englishRecommendedTransformers, asteriskCensorStrategy, parseRawPattern,
} = require('obscenity');

const NAME_REFUSED = 'Please pick a name without offensive words.';
const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

const words = v => String(v || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
// obscenity patterns treat [ ] ? | \ specially; an admin's word is literal text
const literal = w => parseRawPattern(w.replace(/[[\]?|\\]/g, m => '\\' + m));

let cacheKey = null;
let matcher  = null;   // null = filter off

function current() {
  const enabled = String(process.env.WORD_FILTER ?? 'true').toLowerCase() !== 'false';
  const key = `${enabled}\n${process.env.WORD_FILTER_EXTRA || ''}\n${process.env.WORD_FILTER_ALLOW || ''}`;
  if (key === cacheKey) return matcher;
  cacheKey = key;
  if (!enabled) return (matcher = null);

  const allow = words(process.env.WORD_FILTER_ALLOW);
  const extra = words(process.env.WORD_FILTER_EXTRA).filter(w => !allow.includes(w));
  const ds = new DataSet().addAll(englishDataset)
    .removePhrasesIf(p => allow.includes(String(p.metadata?.originalWord || '').toLowerCase()));
  for (const w of extra) {
    try { ds.addPhrase(p => p.setMetadata({ originalWord: w }).addPattern(literal(w))); }
    catch (err) { console.warn(`[WordFilter] skipped "${w}": ${err.message}`); }
  }
  // Allowed words also whitelist themselves, so e.g. "Penistone" survives even though another phrase matches inside it
  if (allow.length) ds.addPhrase(p => { allow.forEach(w => p.addWhitelistedTerm(w)); return p.setMetadata({ originalWord: '' }); });
  matcher = new RegExpMatcher({ ...ds.build(), ...englishRecommendedTransformers });
  return matcher;
}

function clean(text) {
  const m = current();
  if (!m || !text) return text;
  const matches = m.getAllMatches(text, true);
  return matches.length ? censor.applyTo(text, matches) : text;
}

function isClean(text) {
  const m = current();
  return !m || !text || !m.hasMatch(text);
}

module.exports = { clean, isClean, NAME_REFUSED };
