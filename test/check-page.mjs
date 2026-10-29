// Checks the page's wiring without a browser: the HTML has no inline script and its files exist,
// and every name a module imports is exported by the module it names. (`node --check` covers syntax.)
import fs from 'node:fs';
import path from 'node:path';

const pub = new URL('../public/', import.meta.url).pathname;
const problems = [];
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) problems.push('index.html has an inline <script>; the CSP only allows script files');
for (const [, ref] of html.matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)) {
  if (!fs.existsSync(path.join(pub, ref))) problems.push(`index.html refers to /${ref}, which does not exist`);
}

const dir = path.join(pub, 'js');
const exportsOf = new Map();
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  exportsOf.set(f, new Set([...src.matchAll(/^export (?:async function|function|const|let|class) ([\w$]+)/gm)].map((m) => m[1])));
}
for (const f of exportsOf.keys()) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const [, names, from] of src.matchAll(/^import \{([^}]*)\} from '\.\/([\w-]+\.js)';$/gm)) {
    if (!exportsOf.has(from)) { problems.push(`${f} imports from ./${from}, which does not exist`); continue; }
    for (const n of names.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!exportsOf.get(from).has(n)) problems.push(`${f} imports ${n} from ./${from}, which does not export it`);
    }
  }
  for (const [, from] of src.matchAll(/^import '\.\/([\w-]+\.js)';$/gm)) if (!exportsOf.has(from)) problems.push(`${f} loads ./${from}, which does not exist`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
