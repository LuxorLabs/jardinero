import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path, { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('When the dark theme is applied then should keep status colors distinct and readable', () => {
  const tokens = darkThemeTokens();
  const families = [
    'success',
    'warning',
    'danger',
    'blocked',
    'paused',
    'neutral',
    'info',
    'notice',
  ];

  for (const family of families) {
    assert.ok(tokens[`${family}-bg`], `${family} dark background token should exist`);
    assert.ok(tokens[`${family}-border`], `${family} dark border token should exist`);
    assert.ok(tokens[`${family}-fg`], `${family} dark foreground token should exist`);
    assert.ok(
      contrastRatio(tokens[`${family}-bg`], tokens[`${family}-fg`]) >= 4.5,
      `${family} status text should be readable on its dark background`,
    );
    assert.ok(
      relativeLuminance(tokens[`${family}-bg`]) < 0.12,
      `${family} status background should be a dark-mode surface, not a light-mode fill`,
    );
  }

  const statusTriplets = families.map(
    (family) => `${tokens[`${family}-bg`]}:${tokens[`${family}-border`]}:${tokens[`${family}-fg`]}`,
  );
  assert.equal(
    new Set(statusTriplets).size,
    statusTriplets.length,
    'status color families should remain visually distinct',
  );
});

test('When dark mode is active then should meet the navigation contrast requirements', () => {
  const tokens = darkThemeTokens();

  assert.ok(tokens['nav-active'], 'dark active navigation token should exist');
  assert.ok(tokens.muted, 'dark muted navigation track token should exist');
  assert.ok(
    contrastRatio(tokens['nav-active'], tokens.muted) >= 3,
    'active navigation should remain distinguishable from its dark track',
  );
  assert.ok(
    contrastRatio(tokens['nav-active'], '#ffffff') >= 4.5,
    'active navigation labels should remain readable in dark mode',
  );
});

test('When dark mode is applied then should cover every light surface of the dashboard', () => {
  const css = read('web/src/index.css');

  for (const selector of [
    '.bg-white',
    '.bg-secondary',
    '.bg-popover',
    '.bg-\\[\\#f7f9fb\\]',
    '.bg-\\[\\#fbfcfd\\]',
    '.bg-\\[\\#f0f3f6\\]',
    '.bg-\\[\\#eef1f4\\]',
    '.bg-\\[\\#edf0f3\\]',
    '.bg-\\[\\#f1f4f7\\]',
  ]) {
    assert.ok(
      css.includes(`html[data-theme='dark'] ${selector}`),
      `${selector} should have a dark override`,
    );
  }

  // Read over the whole SPA and not a list of files, so a tab added tomorrow cannot
  // introduce a near-white background that dark mode never overrides.
  assert.doesNotMatch(
    spaSources(),
    /bg-\[#(?:fff|fffffe|ffffff|fbfcfd|f7f9fb|f6f7f9)\]/i,
    'dashboard surfaces should not add uncovered near-white arbitrary backgrounds',
  );
});

function spaSources(): string {
  return readdirSync(resolve(root, 'web/src'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.tsx'))
    .map((entry) => read(path.join('web/src', entry)))
    .join('\n');
}

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace(/^#/, '');
  assert.match(normalized, /^[0-9a-f]{6}$/i, `${hex} must be a six-digit hex color`);
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const channel = (value: number) => {
    const sRgb = value / 255;
    return sRgb <= 0.03928 ? sRgb / 12.92 : ((sRgb + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

function darkThemeTokens(): Record<string, string> {
  const css = read('web/src/index.css');
  const block = /html\[data-theme='dark'\]\s*\{(?<body>[\s\S]*?)\n\s*\}/.exec(css)?.groups?.body;
  assert.ok(block, 'dark theme token block must exist');

  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)) {
    tokens[match[1]] = match[2].toLowerCase();
  }
  return tokens;
}
