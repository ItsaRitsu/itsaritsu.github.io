#!/usr/bin/env node
/**
 * Regenerates the site index.
 *
 *   public  -> index.html, between the SITES:START / SITES:END markers
 *   private -> build/PRIVATE-INDEX.md, the full list including Netlify
 *
 * Discovery is automatic. sites.json only holds overrides and hides.
 *
 * Env:
 *   GH_INDEX_TOKEN   GitHub PAT, repo + pages read. Optional; without it only
 *                    this repo's subfolders are found.
 *   NETLIFY_TOKEN    Netlify personal access token. Optional.
 *   GH_OWNER         Defaults to ItsaRitsu.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = process.env.GH_OWNER || 'ItsaRitsu';
const SELF_REPO = `${OWNER.toLowerCase()}.github.io`;

const GH_TOKEN = process.env.GH_INDEX_TOKEN || '';
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN || '';

/* ---------- helpers ---------- */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Markdown link text: escape the characters that would break [text](url).
const mdEsc = (s) => String(s ?? '').replace(/([\[\]|\\])/g, '\\$1');

const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

const titleCase = (slug) =>
  slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

async function api(url, token, label) {
  if (!token) return null;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'itsaritsu-index-builder',
      },
    });
    if (!res.ok) {
      console.warn(`  ! ${label}: HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`  ! ${label}: ${err.message}`);
    return null;
  }
}

/* ---------- config ---------- */

const config = existsSync(join(ROOT, 'sites.json'))
  ? JSON.parse(await readFile(join(ROOT, 'sites.json'), 'utf8'))
  : { overrides: {}, hidden: [] };

const overrides = config.overrides || {};
const hidden = new Set(config.hidden || []);

/* ---------- source 0: hand-listed sites ---------- */

// For anything the API scanners can't see: Cloudflare, Vercel, a plain host,
// a domain someone else deploys for you. Public only if you say so.
const manual = (config.manual || []).map((entry, i) => ({
  key: entry.key || `manual:${entry.url}`,
  source: 'manual',
  group: entry.group || 'Elsewhere',
  title: entry.title || entry.url,
  description: entry.description || '',
  href: entry.url,
  url: entry.url,
  public: entry.public === true,
  order: entry.order ?? 500 + i,
}));

/* ---------- source 1: local subfolders of this repo ---------- */

async function scanLocal() {
  const out = [];
  const entries = await readdir(ROOT, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'scripts' || entry.name === 'build') continue;

    const indexPath = join(ROOT, entry.name, 'index.html');
    if (!existsSync(indexPath)) continue;

    const html = await readFile(indexPath, 'utf8');
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const desc = html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i
    )?.[1];

    out.push({
      key: entry.name,
      source: 'local',
      // Strip a trailing " — Site Name" so cards stay short.
      title: decodeEntities(title || '').split(/\s+[—·|]\s+/)[0].trim() || titleCase(entry.name),
      description: decodeEntities(desc || '').trim(),
      href: `./${entry.name}/`,
      url: `https://${SELF_REPO}/${entry.name}/`,
      public: true,
    });
  }
  return out;
}

/* ---------- source 2: other GitHub Pages repos ---------- */

async function scanGitHubPages() {
  if (!GH_TOKEN) {
    console.log('  - no GH_INDEX_TOKEN, skipping GitHub Pages discovery');
    return [];
  }

  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await api(
      `https://api.github.com/user/repos?per_page=100&affiliation=owner&page=${page}`,
      GH_TOKEN,
      'list repos'
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }

  const out = [];
  for (const repo of repos) {
    if (!repo.has_pages) continue;
    if (repo.name.toLowerCase() === SELF_REPO) continue;

    // The /pages endpoint knows about custom domains; derive a URL if it 403s.
    const pages = await api(
      `https://api.github.com/repos/${repo.full_name}/pages`,
      GH_TOKEN,
      `pages for ${repo.name}`
    );
    const url =
      pages?.html_url ||
      `https://${OWNER.toLowerCase()}.github.io/${repo.name}/`;

    out.push({
      key: `gh:${repo.name}`,
      source: 'github-pages',
      title: titleCase(repo.name),
      description: repo.description || '',
      href: url,
      url,
      public: !repo.private,
      updated: repo.pushed_at,
    });
  }
  return out;
}

/* ---------- source 3: Netlify ---------- */

async function scanNetlify() {
  if (!NETLIFY_TOKEN) {
    console.log('  - no NETLIFY_TOKEN, skipping Netlify discovery');
    return [];
  }

  const sites = await api(
    'https://api.netlify.com/api/v1/sites?per_page=100',
    NETLIFY_TOKEN,
    'list netlify sites'
  );
  if (!Array.isArray(sites)) return [];

  return sites.map((site) => {
    const url = site.ssl_url || site.url;
    return {
      key: `netlify:${site.name}`,
      source: 'netlify',
      title: titleCase(site.name),
      // Netlify has no description field; the linked repo is the useful hint.
      description: site.build_settings?.repo_path || '',
      href: url,
      url,
      // Netlify sites come from private repos: never auto-publish them.
      public: false,
      updated: site.published_deploy?.published_at || site.updated_at,
    };
  });
}

/* ---------- merge ---------- */

console.log('Discovering sites...');
const discovered = [
  ...manual,
  ...(await scanLocal()),
  ...(await scanGitHubPages()),
  ...(await scanNetlify()),
];

const sites = discovered
  .filter((s) => !hidden.has(s.key))
  .map((s) => {
    const o = overrides[s.key] || {};
    return {
      ...s,
      title: o.title ?? s.title,
      description: o.description ?? s.description,
      // A moved site keeps its card but points at the new home.
      href: o.redirect ?? s.href,
      url: o.redirect ?? s.url,
      // An override can promote a site to the public index, or demote one.
      public: o.public ?? s.public,
      order: o.order ?? 999,
    };
  })
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

console.log(`  found ${sites.length} site(s), ${sites.filter((s) => s.public).length} public`);

/* ---------- write the public index ---------- */

const START = '<!-- SITES:START -->';
const END = '<!-- SITES:END -->';

const indexPath = join(ROOT, 'index.html');
let indexHtml = await readFile(indexPath, 'utf8');

if (!indexHtml.includes(START) || !indexHtml.includes(END)) {
  throw new Error(`index.html is missing the ${START} / ${END} markers`);
}

const publicSites = sites.filter((s) => s.public);
const cards = publicSites
  .map(
    (s) => `    <a href="${esc(s.href)}" class="link-item">
      <div class="link-left">
        <span class="link-name">${esc(s.title)}</span>
        <span class="link-desc">${esc(s.description)}</span>
      </div>
      <span class="link-arrow">↗</span>
    </a>`
  )
  .join('\n\n');

const before = indexHtml.slice(0, indexHtml.indexOf(START) + START.length);
const after = indexHtml.slice(indexHtml.indexOf(END));
const nextHtml = `${before}\n${cards}\n\n${after}`;

if (nextHtml !== indexHtml) {
  await writeFile(indexPath, nextHtml);
  console.log('  wrote index.html');
} else {
  console.log('  index.html unchanged');
}

/* ---------- write the private index ---------- */

const labels = {
  local: 'Playground',
  'github-pages': 'GitHub Pages',
  netlify: 'Netlify',
};

const groups = [];
for (const site of sites) {
  const label = site.source === 'manual' ? site.group : labels[site.source];
  const bucket = groups.find(([l]) => l === label);
  if (bucket) bucket[1].push(site);
  else groups.push([label, [site]]);
}

const stamp = new Date().toISOString().slice(0, 10);
let md = `# Every site I've published\n\n`;
md += `Auto-generated ${stamp}. Do not edit by hand — change \`sites.json\` in \`itsaritsu.github.io\` instead.\n`;

for (const [label, group] of groups) {
  if (group.length === 0) continue;
  md += `\n## ${label}\n\n`;
  for (const s of group) {
    const flag = s.public ? '' : ' · _unlisted_';
    const desc = s.description ? ` — ${mdEsc(s.description)}` : '';
    md += `- [${mdEsc(s.title)}](${s.url})${desc}${flag}\n`;
  }
}

await mkdir(join(ROOT, 'build'), { recursive: true });
await writeFile(join(ROOT, 'build', 'PRIVATE-INDEX.md'), md);
console.log('  wrote build/PRIVATE-INDEX.md');
