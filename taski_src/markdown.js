// Markdown helpers: a strict frontmatter subset, section/link extraction,
// checklist toggling and a small HTML renderer. Every edit function takes the
// full file text and returns new text, touching only the lines it must.

(function (Taski) {
'use strict';

/**
 * @typedef {Object} Frontmatter
 * @property {Map<string, string>} fields  Keys in file order.
 * @property {string} body                 Text after the closing `---`.
 * @property {boolean} present             Whether the file had a frontmatter block.
 */

/** @param {string} text */
function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** @param {string} text */
function splitLines(text) {
  return text.split(/\r?\n/);
}

/**
 * Locate the frontmatter block. Returns the index of the closing `---` line,
 * or -1 when the file has no frontmatter.
 * @param {string[]} lines
 */
function frontmatterEnd(lines) {
  if (lines[0] !== '---') return -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return i;
  }
  return -1;
}

const FIELD_RE = /^([A-Za-z][\w-]*):\s?(.*)$/;

/**
 * @param {string} text
 * @returns {Frontmatter}
 */
function parseFrontmatter(text) {
  const lines = splitLines(text);
  const end = frontmatterEnd(lines);
  const fields = new Map();
  if (end < 0) return { fields, body: text, present: false };
  for (let i = 1; i < end; i++) {
    const m = FIELD_RE.exec(lines[i]);
    if (m && !fields.has(m[1])) fields.set(m[1], m[2].trim());
  }
  return { fields, body: lines.slice(end + 1).join(eolOf(text)), present: true };
}

/**
 * Set (or with `null`, remove) one frontmatter field, keeping every other line.
 * @param {string} text
 * @param {string} key
 * @param {string | null} value
 */
function setField(text, key, value) {
  const eol = eolOf(text);
  const lines = splitLines(text);
  let end = frontmatterEnd(lines);
  if (end < 0) {
    if (value === null) return text;
    return ['---', `${key}: ${value}`, '---', ...lines].join(eol);
  }
  for (let i = 1; i < end; i++) {
    const m = FIELD_RE.exec(lines[i]);
    if (m && m[1] === key) {
      if (value === null) lines.splice(i, 1);
      else lines[i] = `${key}: ${value}`;
      return lines.join(eol);
    }
  }
  if (value !== null) lines.splice(end, 0, `${key}: ${value}`);
  return lines.join(eol);
}

/**
 * Title from the first level-one heading of the body.
 * @param {string} body
 */
function getTitle(body) {
  for (const line of splitLines(body)) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1];
  }
  return '';
}

/**
 * Lines outside fenced code blocks, with their index in `lines`.
 * @param {string[]} lines
 * @returns {number[]}
 */
function proseLineIndexes(lines) {
  const out = [];
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = '';
      continue;
    }
    if (!fence) out.push(i);
  }
  return out;
}

/**
 * Range of a `## heading` section: [first content line, end exclusive), or null.
 * @param {string[]} lines
 * @param {string} heading
 */
function sectionRange(lines, heading) {
  const want = heading.trim().toLowerCase();
  const prose = proseLineIndexes(lines);
  let start = -1;
  for (const i of prose) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start >= 0 && m[1].length <= 2) return [start, i];
    if (start < 0 && m[1].length === 2 && m[2].toLowerCase() === want) start = i + 1;
  }
  return start >= 0 ? [start, lines.length] : null;
}

/**
 * @typedef {Object} Link
 * @property {string} text
 * @property {string} href
 */

/**
 * Markdown links inside a `## heading` section.
 * @param {string} text
 * @param {string} heading
 * @returns {Link[]}
 */
function sectionLinks(text, heading) {
  const lines = splitLines(text);
  const range = sectionRange(lines, heading);
  if (!range) return [];
  const links = [];
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (let i = range[0]; i < range[1]; i++) {
    for (const m of lines[i].matchAll(re)) links.push({ text: m[1], href: m[2] });
  }
  return links;
}

/**
 * Append a line to the end of a `## heading` section, creating the section
 * at the end of the file if needed.
 * @param {string} text
 * @param {string} heading
 * @param {string} line
 */
function appendToSection(text, heading, line) {
  const eol = eolOf(text);
  const lines = splitLines(text);
  const range = sectionRange(lines, heading);
  if (!range) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', `## ${heading}`, '', line, '');
    return lines.join(eol);
  }
  let at = range[1];
  while (at > range[0] && lines[at - 1].trim() === '') at--;
  if (at === range[0]) {
    lines.splice(at, 0, '', line);
    // keep a blank line before the next heading
    if (at + 2 < lines.length && lines[at + 2].trim() !== '') lines.splice(at + 2, 0, '');
  } else {
    lines.splice(at, 0, line);
  }
  return lines.join(eol);
}

/**
 * Text without a `## heading` section, for display only. Sections holding
 * checkboxes are kept so checkbox numbering still matches `setCheckbox`.
 * @param {string} text
 * @param {string} heading
 */
function withoutSection(text, heading) {
  const lines = splitLines(text);
  const range = sectionRange(lines, heading);
  if (!range) return text;
  const inside = lines.slice(range[0], range[1]);
  if (inside.some((l) => CHECKBOX_RE.test(l))) return text;
  lines.splice(range[0] - 1, range[1] - range[0] + 1);
  return lines.join(eolOf(text));
}

const CHECKBOX_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s)/;

/**
 * @typedef {Object} ChecklistItem
 * @property {number} index
 * @property {boolean} done
 * @property {string} text
 */

/**
 * Checkboxes in document order, outside code blocks.
 * @param {string} text
 * @returns {ChecklistItem[]}
 */
function checklist(text) {
  const lines = splitLines(text);
  const items = [];
  for (const i of proseLineIndexes(lines)) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (m) items.push({ index: items.length, done: m[2] !== ' ', text: lines[i].slice(m[0].length) });
  }
  return items;
}

/**
 * Set the n-th checkbox (same order as `checklist`) to done or not done.
 * @param {string} text
 * @param {number} n
 * @param {boolean} done
 */
function setCheckbox(text, n, done) {
  const lines = splitLines(text);
  let count = 0;
  for (const i of proseLineIndexes(lines)) {
    if (!CHECKBOX_RE.test(lines[i])) continue;
    if (count++ === n) {
      lines[i] = lines[i].replace(CHECKBOX_RE, `$1${done ? 'x' : ' '}$3`);
      return lines.join(eolOf(text));
    }
  }
  return text;
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

/**
 * @typedef {Object} RenderOptions
 * @property {(href: string) => string} [resolveLink]  Maps a link target to the href to use.
 */

/** @param {string} href */
function safeHref(href) {
  if (/^(https?:|mailto:|#|\.{0,2}\/|[\w.-]+(\/|$|#|\?))/i.test(href) && !/^\s*javascript:/i.test(href)) return href;
  return '#';
}

/**
 * @param {string} s
 * @param {RenderOptions} opts
 */
function renderInline(s, opts) {
  const codes = [];
  let out = escapeHtml(s).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const raw = href.replace(/&amp;/g, '&');
      const target = opts.resolveLink ? opts.resolveLink(raw) : raw;
      const external = /^https?:/i.test(target);
      return `<a href="${escapeHtml(safeHref(target))}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/**
 * Render a Markdown body to HTML. Checkboxes get `data-check="<n>"` matching
 * `setCheckbox` numbering when the same text is passed to both.
 * @param {string} body
 * @param {RenderOptions} [opts]
 */
function renderMarkdown(body, opts = {}) {
  const lines = splitLines(body);
  const html = [];
  let para = [];
  /** @type {string[]} */
  let listStack = [];
  let checkN = 0;
  let i = 0;

  const flushPara = () => {
    if (para.length) html.push(`<p>${renderInline(para.join(' '), opts)}</p>`);
    para = [];
  };
  const closeLists = () => {
    while (listStack.length) html.push(`</${listStack.pop()}>`);
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (fence) {
      flushPara();
      closeLists();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushPara();
      closeLists();
      const n = heading[1].length;
      html.push(`<h${n}>${renderInline(heading[2], opts)}</h${n}>`);
      i++;
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
      const depth = Math.floor(item[1].replace(/\t/g, '  ').length / 2) + 1;
      while (listStack.length > depth) html.push(`</${listStack.pop()}>`);
      if (listStack.length === depth && listStack[depth - 1] !== tag) html.push(`</${listStack.pop()}>`);
      while (listStack.length < depth) {
        listStack.push(tag);
        html.push(`<${tag}>`);
      }
      const check = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      if (check && tag === 'ul') {
        const done = check[1] !== ' ';
        html.push(`<li class="check"><label><input type="checkbox" data-check="${checkN++}"${done ? ' checked' : ''}> <span>${renderInline(check[2], opts)}</span></label></li>`);
      } else {
        html.push(`<li>${renderInline(item[3], opts)}</li>`);
      }
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      closeLists();
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      html.push(`<blockquote>${renderInline(quote.join(' '), opts)}</blockquote>`);
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara();
      closeLists();
      const cells = (/** @type {string} */ row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : ''));
      const cell = (/** @type {string} */ tag, /** @type {string} */ c, /** @type {number} */ n) =>
        `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ''}>${renderInline(c, opts)}</${tag}>`;
      const rows = [`<thead><tr>${cells(line).map((c, n) => cell('th', c, n)).join('')}</tr></thead>`, '<tbody>'];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(`<tr>${cells(lines[i++]).map((c, n) => cell('td', c, n)).join('')}</tr>`);
      html.push(`<table>${rows.join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      closeLists();
      html.push('<hr>');
      i++;
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      closeLists();
      i++;
      continue;
    }
    if (listStack.length) closeLists();
    para.push(line.trim());
    i++;
  }
  flushPara();
  closeLists();
  return html.join('\n');
}

/**
 * Lowercase, dash-separated name usable as a file or folder name.
 * @param {string} title
 */
function slugify(title) {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

Taski.markdown = { parseFrontmatter, setField, getTitle, sectionLinks, appendToSection, withoutSection, checklist, setCheckbox, escapeHtml, renderMarkdown, slugify };
})(window.Taski = window.Taski || {});
