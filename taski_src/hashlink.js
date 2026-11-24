// The address after `#`: a route plus parameters, e.g.
//   #/p/jsbedded?storage=server&path=work&project=jsbedded&tab=files
// Nothing after `#` is sent to the web server, so storage and folder names stay private.

(function (Taski) {
'use strict';

/** Parameters that say which workspace is open and how much of it to show. They follow every link. */
const SESSION_KEYS = ['storage', 'path', 'project'];

/**
 * @param {string} hash  e.g. `#/p/app?tab=files`
 * @returns {{route: string, params: URLSearchParams}}
 */
function parse(hash) {
  const body = hash.replace(/^#/, '');
  const i = body.indexOf('?');
  return { route: i < 0 ? body : body.slice(0, i), params: new URLSearchParams(i < 0 ? '' : body.slice(i + 1)) };
}

/** @param {string} route @param {URLSearchParams} params */
function build(route, params) {
  // URLSearchParams escapes '/' and ':'; both are allowed after '#' and easier to read.
  const query = params.toString().replace(/%2F/gi, '/').replace(/%3A/gi, ':');
  return `#${route || '/'}${query ? `?${query}` : ''}`;
}

/** The session parameters present in `hash`. @param {string} hash @returns {Record<string, string>} */
function session(hash) {
  const { params } = parse(hash);
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of SESSION_KEYS) if (params.get(k)) out[k] = /** @type {string} */ (params.get(k));
  return out;
}

/** `hash` without the session parameters: the route and its own parameters (tab). @param {string} hash */
function strip(hash) {
  const { route, params } = parse(hash);
  for (const k of SESSION_KEYS) params.delete(k);
  return build(route, params);
}

/**
 * `hash` with exactly these session parameters, written first. Empty values are left out.
 * @param {string} hash
 * @param {Record<string, string | undefined>} values
 */
function apply(hash, values) {
  const { route, params } = parse(hash);
  const out = new URLSearchParams();
  for (const k of SESSION_KEYS) if (values[k]) out.set(k, values[k]);
  for (const [k, v] of params) if (!SESSION_KEYS.includes(k)) out.append(k, v);
  return build(route, out);
}

Taski.hashlink = { SESSION_KEYS, parse, build, session, strip, apply };
})(window.Taski = window.Taski || {});
