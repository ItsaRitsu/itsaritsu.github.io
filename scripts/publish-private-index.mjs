#!/usr/bin/env node
/**
 * Pushes build/PRIVATE-INDEX.md to the private index repo as README.md,
 * so GitHub renders it as a clickable, login-gated list.
 *
 * Env:
 *   GH_INDEX_TOKEN       PAT with contents:write on the target repo.
 *   PRIVATE_INDEX_REPO   owner/repo. Defaults to ItsaRitsu/site-index.
 */

import { readFile } from 'node:fs/promises';

const TOKEN = process.env.GH_INDEX_TOKEN;
const REPO = process.env.PRIVATE_INDEX_REPO || 'ItsaRitsu/site-index';

if (!TOKEN) {
  console.log('No GH_INDEX_TOKEN, skipping private index publish.');
  process.exit(0);
}

const body = await readFile('build/PRIVATE-INDEX.md', 'utf8');
const url = `https://api.github.com/repos/${REPO}/contents/README.md`;
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'itsaritsu-index-builder',
};

// Need the blob sha to update an existing file; absent on first run.
let sha;
const head = await fetch(url, { headers });
if (head.ok) {
  const existing = await head.json();
  sha = existing.sha;
  if (Buffer.from(existing.content, 'base64').toString('utf8') === body) {
    console.log('Private index unchanged.');
    process.exit(0);
  }
} else if (head.status !== 404) {
  console.error(`Could not read ${REPO}/README.md: HTTP ${head.status}`);
  process.exit(1);
}

const res = await fetch(url, {
  method: 'PUT',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'chore: refresh site index',
    content: Buffer.from(body, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  }),
});

if (!res.ok) {
  console.error(`Publish failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`Published private index to ${REPO}.`);
