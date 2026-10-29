import { esc } from './util.js';

// Small Markdown renderer: everything is escaped first, then only known syntax becomes markup.
// U+0000-U+0002 mark placeholders below, so they are removed from the text first.
const PLACEHOLDER_CHARS = /[\u0000-\u0002]/g;
export function inline(t) {
  t = String(t ?? '').replace(PLACEHOLDER_CHARS, '');
  const codes = [];
  t = t.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  // Only local images (pasted attachments, transcript images) are shown inline.
  const pics = [];
  t = t.replace(/!\[([^\]\n]*)\]\((\/api\/(?:attachments\/[\w.-]+|images\/[0-9a-f]{20}))\)/g, (_, alt, url) => `\u0001${pics.push([alt, url]) - 1}\u0001`);
  t = esc(t)
    .replace(/\[([^\]\n]+)\]\((?:&lt;)?(https?:\/\/[^\s)&]+(?:&amp;[^\s)&]+)*)(?:&gt;)?\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<span title="$2">$1</span>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i] ?? '')}</code>`)
    .replace(/\u0001(\d+)\u0001/g, (_, i) => (pics[i] ? `<img class="mdimg" src="${esc(pics[i][1])}" alt="${esc(pics[i][0] || 'image')}">` : ''));
}

// HTML in a message (often entity-escaped, as GitHub and Linear bot comments arrive) becomes
// Markdown before rendering, so it reads as text rather than as tags. Code is left alone.
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
// Numeric entities outside Unicode (&#x110000;) stay as written instead of throwing and blanking the feed.
const codePoint = (e) => { const n = Number(e.slice(1).replace(/^x/i, '0x')); return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined; };
export const decodeEntities = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  (e[0] === '#' ? codePoint(e) : ENTITIES[e.toLowerCase()]) ?? m);
const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1] || '';
const BLOCK_TAGS = 'p|div|details|ul|ol|table|thead|tbody|tr|blockquote|section|article|center|dl';
export function htmlToMd(text) {
  const codes = [];
  let t = String(text ?? '').replace(PLACEHOLDER_CHARS, '').replace(/`[^`\n]+`/g, (c) => `\u0002${codes.push(c) - 1}\u0002`);
  t = decodeEntities(t)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, a, label) => {
      const href = attr(a, 'href'); label = label.replace(/<[^>]+>/g, '').trim();
      return href ? `[${label || href}](${href})` : label;
    })
    .replace(/<img\b([^>]*)>/gi, (_, a) => attr(a, 'alt') || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<(s|del|strike)>([\s\S]*?)<\/\1>/gi, '~~$2~~')
    .replace(/<code>([^<`\n]*)<\/code>/gi, '`$1`')
    .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, (_, s) => `\n\n**${s.trim()}**\n\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, h) => `\n\n${'#'.repeat(n)} ${h.trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
    .replace(/<\/?(dt|dd|td|th)\b[^>]*>/gi, ' ')
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n\n')
    .replace(/<\/?(span|sub|sup|kbd|small|u|font)\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
  return t.replace(/\u0002(\d+)\u0002/g, (_, i) => codes[i] ?? '');
}
export function md(src) {
  // Fenced code keeps its text exactly; everything else has its HTML turned into Markdown.
  // A fence still open at the end (a reply cut off or still streaming) is code to the end, as mdBlocks reads it.
  const parts = String(src).replace(/\r/g, '').split(/^(\s*(?:```+|~~~+)[^\n]*\n[\s\S]*?(?:^\s*(?:```+|~~~+)\s*$|(?![\s\S])))/m);
  return mdBlocks(parts.map((p, i) => (i % 2 ? p : htmlToMd(p))).join(''));
}

function mdBlocks(src) {
  const lines = String(src).split('\n');
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || '');
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s*(```+|~~~+)\s*([\w+-]*)/))) {
      const fence = m[1]; const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) body.push(lines[i]);
      i++; out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`); continue;
    }
    if (!l.trim()) { i++; continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { const n = Math.min(4, m[1].length); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.includes('|') && isTableSep(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${mdBlocks(body.join('\n'))}</blockquote>`); continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const items = []; const ordered = /^\s*\d/.test(l); const base = l.match(/^\s*/)[0].length;
      while (i < lines.length && lines[i].trim()) {
        const li = lines[i]; const ind = li.match(/^\s*/)[0].length;
        const im = li.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (im && ind <= base + 1) { items.push([im[2]]); i++; continue; }
        if (items.length && (ind > base || !im)) { items[items.length - 1].push(li.slice(Math.min(ind, base + 2))); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(([first, ...rest]) => `<li>${inline(first)}${rest.length ? mdBlocks(rest.join('\n')) : ''}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !(lines[i].includes('|') && isTableSep(lines[i + 1]))) para.push(lines[i++]);
    if (!para.length) { out.push(`<p>${inline(lines[i++])}</p>`); continue; }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}
