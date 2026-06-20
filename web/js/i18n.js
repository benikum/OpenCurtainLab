// Translation loading, language selection, and static DOM translation.

'use strict';

// Text sources:
// - source mode: language JSON files are fetched by a local/dev web server
// - compiled mode: <script id="ocl-i18n-all"> contains all languages
// Read and parse a JSON payload from an embedded script tag.
function readJsonScript(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  try { return JSON.parse(el.textContent || '{}'); } catch (e) { return null; }
}
// Normalize any language value to one of the supported language codes.
function normLang(lang) {
  const v = String(lang || '').toLowerCase().slice(0, 2);
  return v === 'de' ? 'de' : 'en';
}
// Read a localStorage value without breaking private or restricted browser modes.
function safeLocalStorageGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
// Write a localStorage value without throwing in restricted browser modes.
function safeLocalStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}
// Return development-mode asset paths from the optional source config block.
function sourceConfig() {
  return Object.assign({ i18nDir: 'i18n', tutorialDir: 'tutorial' }, readJsonScript('ocl-source-config') || {});
}
let OCL_I18N_ALL = readJsonScript('ocl-i18n-all') || null;
// Read the explicit language override from the current URL query string.
function requestedLanguageFromUrl() {
  try {
    const raw = new URLSearchParams(window.location.search || '').get('lang');
    if (!raw) return null;
    const lang = normLang(raw);
    return lang === 'de' || lang === 'en' ? lang : null;
  } catch (e) {
    return null;
  }
}
// Check whether a translation bundle is available for a language.
function languageAvailable(lang) {
  return !!(OCL_I18N_ALL && OCL_I18N_ALL[normLang(lang)]);
}
// Choose the startup language from URL, storage, document, browser, and fallback defaults.
function pickInitialLanguage() {
  const requested = requestedLanguageFromUrl();
  if (requested && languageAvailable(requested)) return requested;
  const stored = safeLocalStorageGet('ocl_ui_language');
  if (stored && languageAvailable(stored)) return normLang(stored);
  const docLang = normLang(document.documentElement.lang || '');
  if (languageAvailable(docLang)) return docLang;
  const navLang = normLang(navigator.language || '');
  if (languageAvailable(navLang)) return navLang;
  return docLang || 'en';
}
let OCL_TEXT = readJsonScript('ocl-i18n') || {};
// Activate embedded translations early so the page can render before async loading
// finishes.
function activateInitialTextLanguage() {
  if (OCL_TEXT && Object.keys(OCL_TEXT).length) return;
  const lang = pickInitialLanguage();
  if (OCL_I18N_ALL && OCL_I18N_ALL[lang]) {
    document.documentElement.lang = lang;
    OCL_TEXT = OCL_I18N_ALL[lang];
    const requested = requestedLanguageFromUrl();
    if (requested) safeLocalStorageSet('ocl_ui_language', lang);
  }
}
let OCL_I18N_LOAD_ERROR = null;
// Fetch all supported translation JSON files from a directory.
async function loadI18nFromDir(dir) {
  const base = String(dir || 'i18n').replace(/\/$/, '');
  const pairs = await Promise.all(['de', 'en'].map(async lang => {
    const r = await fetch(`${base}/${lang}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Could not load ${base}/${lang}.json`);
    return [lang, await r.json()];
  }));
  return Object.fromEntries(pairs);
}
// Load translation bundles in development mode, trying common relative paths.
async function loadSourceI18n() {
  if (OCL_I18N_ALL) return true;
  const cfg = sourceConfig();
  const primary = String(cfg.i18nDir || 'i18n').replace(/\/$/, '');
  const candidates = [primary, 'i18n', './i18n', 'web/i18n']
    .filter((dir, idx, arr) => dir && arr.indexOf(dir) === idx);

  for (const dir of candidates) {
    try {
      OCL_I18N_ALL = await loadI18nFromDir(dir);
      OCL_I18N_LOAD_ERROR = null;
      return true;
    } catch (e) {
      OCL_I18N_LOAD_ERROR = e;
    }
  }

  console.warn('OpenCurtainLab i18n files could not be loaded. Serve web/ through a local HTTP server or build/open web/compiled/compiled-v0.1.0.html.', OCL_I18N_LOAD_ERROR);
  OCL_I18N_ALL = OCL_I18N_ALL || null;
  return false;
}
// Switch the active translation bundle and update the document language.
function setActiveTextLanguage(lang) {
  const next = normLang(lang);
  if (!OCL_I18N_ALL || !OCL_I18N_ALL[next]) return false;
  OCL_TEXT = OCL_I18N_ALL[next];
  document.documentElement.lang = next;
  return true;
}
// Translate a dotted i18n key and return the provided fallback when it is missing.
function tx(path, fallback = '') {
  const parts = String(path).split('.');
  let cur = OCL_TEXT;
  for (const part of parts) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
    else return fallback;
  }
  return cur == null ? fallback : cur;
}
// Translate a text with named placeholder replacement.
function tf(path, fallback, values = {}) {
  return String(tx(path, fallback)).replace(/\{(\w+)\}/g, (_, k) => values[k] == null ? '' : values[k]);
}
// Return the locale string used for number and date formatting.
function uiLocale() { return tx('locale', document.documentElement.lang || 'en'); }
// Apply i18n text and translated attributes to static DOM nodes.
function applyStaticTranslations(root = document) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const value = tx(key, el.textContent || '');
    if (el.getAttribute('data-i18n-html') === 'true') el.innerHTML = value;
    else el.textContent = value;
  });
  ['title', 'aria-label', 'placeholder', 'value', 'alt'].forEach(attr => {
    const dataAttr = 'data-i18n-' + attr;
    root.querySelectorAll('[' + dataAttr + ']').forEach(el => {
      const key = el.getAttribute(dataAttr);
      el.setAttribute(attr, tx(key, el.getAttribute(attr) || ''));
    });
  });
}
