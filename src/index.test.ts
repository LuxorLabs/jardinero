import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';

// tsc reports an unresolved module for an import with bindings but not for a bare
// side-effect one, and no test boots an entry point, so a moved file can leave the
// process unable to start with everything green.
describe('module graph', () => {
  const roots = ['src', 'scripts'];

  for (const root of roots) {
    test(`When a relative import is written under ${root} then should resolve to a file`, () => {
      const broken: string[] = [];

      for (const file of walk(root)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/(?:from\s+|import\s*\(?\s*)(['"])(\.[^'"]+)\1/g)) {
          const specifier = match[2];
          // Specifiers under dist/ are runtime paths a child process resolves
          // against the repo root, not module references from this file.
          if (specifier.includes('/dist/')) continue;
          const target = resolve(dirname(file), specifier).replace(/\.js$/, '');
          if (existsSync(`${target}.ts`) || existsSync(`${target}.tsx`)) continue;
          if (existsSync(target) || existsSync(`${target}.js`)) continue;
          broken.push(`${file} -> ${specifier}`);
        }
      }

      assert.deepEqual(broken, []);
    });
  }
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}
