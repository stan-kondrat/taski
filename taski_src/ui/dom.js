// Tiny DOM builder. Strings become text nodes, so content is never parsed as HTML.

(function (Taski) {
'use strict';

/**
 * @typedef {string | number | Node | null | undefined | false | Child[]} Child
 */

/**
 * @param {string} tag            Tag name with optional `.class` suffixes, e.g. `div.card.open`.
 * @param {Record<string, any> | null} [attrs]  `on*` keys add listeners; `html` sets innerHTML (trusted only).
 * @param {...Child} children
 * @returns {HTMLElement}
 */
function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

/**
 * @param {Node} el
 * @param {Child[]} children
 */
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * @param {string} value
 * @param {string[]} options
 * @param {Record<string, any>} [attrs]
 */
function select(value, options, attrs = {}) {
  const all = options.includes(value) || !value ? options : [value, ...options];
  return h('select', attrs, all.map((o) => h('option', { value: o, selected: o === value }, o)));
}

const FOLD_KEY = 'taski.folded';
/** Names of the sidebars folded away ('left', 'right'), remembered in this browser. @returns {string[]} */
function foldedPanels() {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) || '[]');
  } catch {
    return [];
  }
}
/** Apply the remembered folds to the page. */
function applyFolds() {
  for (const name of ['left', 'right']) document.body.classList.toggle(`fold-${name}`, foldedPanels().includes(name));
}
/**
 * Fold or unfold a sidebar.
 * @param {'left' | 'right'} name
 * @returns {boolean} true when it is now folded
 */
function toggleFold(name) {
  const folded = document.body.classList.toggle(`fold-${name}`);
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(['left', 'right'].filter((n) => document.body.classList.contains(`fold-${n}`))));
  } catch {
    // private mode: not remembered
  }
  return folded;
}

Taski.dom = { h, select, applyFolds, toggleFold };
})(window.Taski = window.Taski || {});
