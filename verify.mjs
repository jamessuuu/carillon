#!/usr/bin/env node
// verify.mjs
//
// Mechanically enforces carillon's one product claim: this page makes
// no network requests, ever. It scans the shippable site — index.html
// plus everything under src/ — for anything network-shaped, any
// external resource pointing at http(s), any CDN-hosted <script src>,
// and any analytics-shaped identifier. Any hit is a FAIL (non-zero
// exit). A clean scan is a PASS (exit 0) and prints nothing to stderr.
//
// Usage: node verify.mjs [dir]   (defaults to the current directory)
//
// Exports scanText/scanDir so tests/verify.test.mjs can exercise the
// same rules as pure functions, without spawning a subprocess for every
// case, plus one end-to-end subprocess test that proves the CLI's exit
// code actually flips.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCAN_EXTENSIONS = new Set(['.html', '.htm', '.mjs', '.js']);

// Known analytics/telemetry call- and domain-shaped signatures. This is
// deliberately code-shaped (function calls, library names, vendor
// domains) rather than the bare English word "analytics" — the page's
// own privacy statement is allowed to say "no analytics" without
// tripping its own checker.
const ANALYTICS_PATTERN = new RegExp(
  [
    'gtag\\s*\\(',
    'ga\\s*\\(\\s*[\'"]',
    '_gaq\\.push',
    'dataLayer\\.push',
    'google-analytics\\.com',
    'googletagmanager\\.com',
    'mixpanel\\.(init|track)',
    'posthog\\.(init|capture)',
    'amplitude\\.(getInstance|init|logEvent)',
    'fbq\\s*\\(',
    'plausible\\.io',
    'clarity\\.ms',
    'hotjar',
    'segment\\.(com|io)\\/analytics\\.js',
    'fullstory',
    'sentry\\.io',
    'bugsnag',
    'datadoghq',
    'newrelic',
  ].join('|'),
  'i',
);

const RULES = [
  {
    id: 'fetch-call',
    description: 'calls fetch(...)',
    test: (text) => new RegExp('\\bfetch\\s*\\(').test(text),
  },
  {
    id: 'xhr',
    description: 'uses XMLHttpRequest',
    test: (text) => new RegExp('\\bXMLHttpRequest\\b').test(text),
  },
  {
    id: 'send-beacon',
    description: 'calls navigator.sendBeacon',
    test: (text) => new RegExp('navigator\\s*\\.\\s*sendBeacon').test(text),
  },
  {
    id: 'external-src-href',
    description: 'has a src= or href= pointing at an http(s) URL',
    test: (text) => /\b(?:src|href)\s*=\s*["'](https?:)\/\//i.test(text),
  },
  {
    id: 'cdn-script',
    description: 'loads a <script src> from a CDN host',
    test: (text) =>
      /<script\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\/(?:[\w-]+\.)*(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|ajax\.googleapis\.com|code\.jquery\.com|cdn\.tailwindcss\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com|use\.fontawesome\.com)/i.test(
        text,
      ),
  },
  {
    id: 'analytics-identifier',
    description: 'contains an analytics- or telemetry-shaped identifier',
    test: (text) => ANALYTICS_PATTERN.test(text),
  },
];

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (SCAN_EXTENSIONS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

// The "site" is defined narrowly, on purpose: index.html plus whatever
// lives under src/. This is what ships; it excludes tooling (verify.mjs
// itself, package.json), tests, and docs, so this checker never has to
// reason about its own source code containing the very strings it's
// looking for.
function siteFiles(rootDir) {
  const files = [];
  const indexPath = join(rootDir, 'index.html');
  if (existsSync(indexPath) && statSync(indexPath).isFile()) files.push(indexPath);
  const srcDir = join(rootDir, 'src');
  if (existsSync(srcDir) && statSync(srcDir).isDirectory()) walk(srcDir, files);
  return files;
}

export function scanText(text) {
  return RULES.filter((rule) => rule.test(text)).map((rule) => rule.id);
}

export function scanDir(rootDir) {
  const violations = [];
  for (const file of siteFiles(rootDir)) {
    const text = readFileSync(file, 'utf8');
    for (const ruleId of scanText(text)) {
      violations.push({ file: relative(rootDir, file), rule: ruleId });
    }
  }
  return violations;
}

function ruleDescription(ruleId) {
  return RULES.find((r) => r.id === ruleId)?.description ?? ruleId;
}

function main() {
  const target = process.argv[2] || '.';
  const violations = scanDir(target);
  if (violations.length > 0) {
    console.error(`verify: FAIL — ${violations.length} violation(s) found in ${target}`);
    for (const v of violations) {
      console.error(`  ${v.file}: ${v.rule} — ${ruleDescription(v.rule)}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`verify: OK — no network calls, external resources, or analytics identifiers found in ${target}`);
}

// Run as a CLI only when invoked directly (`node verify.mjs`), not when
// imported by the test suite. Compared as file:// URLs, not raw path
// strings, so this works on Windows too.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
