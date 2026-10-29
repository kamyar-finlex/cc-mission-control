// The page's Markdown renderer, imported straight from public/js (it needs no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md, inline, htmlToMd, decodeEntities } from '../public/js/markdown.js';

test('text is escaped before any markup is added', () => {
  assert.equal(inline('<b onclick="x">hi</b> & "q"'), '&lt;b onclick=&quot;x&quot;&gt;hi&lt;/b&gt; &amp; &quot;q&quot;');
  assert.ok(!md('<script>alert(1)</script>').includes('<script>'));
});

test('links: only http(s) becomes a link; anything else is inert text', () => {
  assert.match(inline('[docs](https://example.com/a)'), /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener">docs<\/a>/);
  const js = inline('[click](javascript:alert(1))');
  assert.ok(!/<a\b/.test(js), js);
  assert.equal(js, '<span title="javascript:alert(1">click</span>)', 'inert: the title stops at the first ")"');
  const quoted = inline('[x](https://e.com/"onmouseover="alert(1))');
  assert.ok(!/" onmouseover=/.test(quoted), quoted);
});

test('HTML in a message reads as text, and its dangerous parts are dropped', () => {
  const out = md('<a href="javascript:alert(2)">bad</a> <img src=x onerror=alert(3) alt="pic"> <b>bold</b>');
  assert.ok(!/<a\b[^>]*javascript:/i.test(out), out);
  assert.ok(!/<img/i.test(out), 'only local images are ever shown');
  assert.match(out, /<b>bold<\/b>/);
  assert.match(htmlToMd('<ul><li>one</li><li>two</li></ul>'), /- one\n- two/);
});

test('images: only the console\'s own image URLs are shown', () => {
  assert.match(inline('![shot](/api/images/0123456789abcdef0123)'), /<img class="mdimg" src="\/api\/images\/0123456789abcdef0123" alt="shot">/);
  assert.ok(!/<img/.test(inline('![x](https://evil.example/p.png)')));
});

test('hostile input never throws (each of these used to blank the transcript)', () => {
  assert.equal(decodeEntities('&#x110000; &#99999999; &#x41;&amp;'), '&#x110000; &#99999999; A&');
  assert.doesNotThrow(() => md('a \u00019\u0001 b \u00007\u0000 c \u0002 3 \u0002'));
  assert.ok(!md('a \u00019\u0001 b').includes('undefined'));
});

test('code keeps its text exactly', () => {
  assert.match(inline('use `a <b> & c`'), /<code>a &lt;b&gt; &amp; c<\/code>/);
  const fenced = md('```\n<script>x</script>\n**not bold**\n```');
  assert.ok(fenced.includes('&lt;script&gt;'), fenced);
  assert.ok(!fenced.includes('<b>'), fenced);
});
