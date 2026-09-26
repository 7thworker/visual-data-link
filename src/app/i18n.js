// Language switch of the simple pages (index, send, receive): Japanese or
// English, one at a time. The pages are written bilingual — Japanese followed
// by <span class="en">, or "日本語 / English" in buttons, labels, options and
// the title — and normalize() splits them into .ja / .en parts once; CSS then
// shows the language of <html data-lang> (without this script both show,
// the English under the Japanese). The choice is kept in the browser.

const KEY = 'vdl-lang';
const JA = /[぀-ヿ㐀-鿿]/;
// "日本語 / English": the part after the last " / " has no Japanese.
const SLASH = /^(\s*)(.*\S)\s*\/\s+([^぀-ヿ㐀-鿿]*\S)(\s*)$/s;

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.lang = cls;
  s.textContent = text;
  return s;
}

// el: content "Japanese" + "English" as .ja / .en spans (dynamic texts).
export function setBilingual(el, ja, en) {
  el.replaceChildren(span('ja', ja), span('en', en));
}

function splitSlash(text) {
  const m = SLASH.exec(text);
  return m && JA.test(m[2]) ? { lead: m[1], ja: m[2], en: m[3], tail: m[4] } : null;
}

// Splits the bilingual markup under root into .ja / .en parts (idempotent).
export function normalize(root = document.body) {
  // Japanese before a child <span class="en">: wrapped as .ja.
  for (const en of root.querySelectorAll('.en')) {
    const parent = en.parentNode;
    if (!parent || parent.querySelector(':scope > .ja')) continue;
    const before = [];
    for (let n = parent.firstChild; n && n !== en; n = n.nextSibling) before.push(n);
    if (!before.some((n) => n.textContent.trim())) continue;
    const ja = document.createElement('span');
    ja.className = 'ja';
    ja.lang = 'ja';
    parent.insertBefore(ja, before[0]);
    for (const n of before) ja.append(n);
  }
  // Options can hold text only: both kept in data attributes.
  for (const o of root.querySelectorAll('option')) {
    const p = !o.dataset.ja && splitSlash(o.textContent);
    if (p) Object.assign(o.dataset, { ja: p.ja, en: p.en });
  }
  // "日本語 / English" text nodes elsewhere.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('script, style, option, .ja, .en') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const n of nodes) {
    const p = splitSlash(n.textContent);
    if (p) n.replaceWith(p.lead, span('ja', p.ja), span('en', p.en), p.tail);
  }
}

let title = null;
let lang = 'ja';

export const currentLang = () => lang;

export function setLang(next) {
  lang = next === 'en' ? 'en' : 'ja';
  document.documentElement.lang = lang;
  document.documentElement.dataset.lang = lang;
  for (const o of document.querySelectorAll('option[data-ja]')) o.textContent = o.dataset[lang];
  if (title) document.title = title[lang];
  const b = document.getElementById('lang-toggle');
  if (b) b.textContent = lang === 'ja' ? 'English' : '日本語';
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // Storage unavailable: the choice is simply not kept.
  }
}

// Once per page: splits the markup, wires #lang-toggle, applies the saved
// language (else the browser's).
export function initLang() {
  normalize();
  const t = splitSlash(document.title);
  // "VDL — 送る / Send": the English keeps the prefix before the Japanese.
  if (t) title = { ja: t.ja, en: t.ja.match(/^[^぀-ヿ㐀-鿿]*/)[0] + t.en };
  document.getElementById('lang-toggle')?.addEventListener('click', () => setLang(lang === 'ja' ? 'en' : 'ja'));
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // no storage
  }
  setLang(saved ?? (navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en'));
}
