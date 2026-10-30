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

Taski.dom = { h, select };
})(window.Taski = window.Taski || {});
