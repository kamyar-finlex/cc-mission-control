// `node --check` for the page's inline script, which the other checks never see.
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('<script>');
const end = html.lastIndexOf('</script>');
if (start < 0 || end < start) { console.error('public/index.html: no inline <script> found'); process.exit(1); }
try {
  new vm.Script(html.slice(start + '<script>'.length, end), { filename: 'public/index.html <script>' });
} catch (e) {
  console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
