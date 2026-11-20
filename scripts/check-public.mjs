import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

// Publication hygiene only; run a dedicated secret scanner as well.
const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const allowedDotEnv = '.env.example';
const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error('symlinks are not publishable');
    if (entry.isDirectory()) await walk(full);
    else files.push(relative(root, full));
  }
}
await walk(root);
const issues = [];
const pathDeny = /(?:^|\/)(?:private|credentials|secrets|release-prep|artifacts|backups)(?:\/|$)|(?:^|\/)CODEX_MEMORY\.md$|\.(?:pem|key|p12|sqlite[0-9]*|db|log)$/i;
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['cloud-key', /AKIA[0-9A-Z]{16}/],
  ['host-user-path', /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
  ['private-workspace', /(?:CODEX_MEMORY\.md|release-prep\/)/],
];
for (const file of files) {
  if (file === 'scripts/check-public.mjs' || file === '.gitignore') continue;
  if (pathDeny.test(file) || (file.startsWith('.env') && file !== allowedDotEnv)) issues.push(`${file}: prohibited file`);
  const text = await readFile(join(root, file), 'utf8');
  for (const [name, pattern] of rules) if (pattern.test(text)) issues.push(`${file}: ${name}`);
  if (file.endsWith('.md')) {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target) || target.startsWith('//')) continue;
      try { await readFile(join(root, file, '..', target)); }
      catch { issues.push(`${file}: broken local link`); }
    }
  }
}
try {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).split('\0').filter(Boolean);
  for (const path of tracked) if (pathDeny.test(path) || path.startsWith('node_modules/') || path.startsWith('dist/')) issues.push(`${path}: prohibited tracked file`);
} catch { /* A source archive can be checked without Git. */ }
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log(`Public checks passed: ${files.length} files, local links and publication hygiene.`);
