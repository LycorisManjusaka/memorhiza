// Builds the public site (https://memorhiza.github.io) as plain static files.
//
//   cd web-app
//   node --experimental-transform-types scripts/build-site.mjs <output-dir>
//
// WHY THIS LIVES HERE AND NOT IN THE SITE REPOSITORY
// The site has no text of its own. The landing pages are the two READMEs and
// the guide is lib/userGuide.ts — the same module the in-app guide renders.
// A site that kept its own copy would be a second home for the same facts, and
// the day one copy is corrected the other starts lying. So the site repository
// holds only this script's OUTPUT, and this script is the one way to make it.
//
// WHY react-markdown AND NOT A SEPARATE MARKDOWN LIBRARY
// The in-app guide is rendered by react-markdown + remark-gfm (UserGuide.tsx).
// Rendering the site with the same two packages means a page that reads right
// in the app reads right on the site, including the Japanese emphasis cases
// that a different parser would open or close differently.
//
// SCOPE OF THE LANDING PAGES (Lizard-kun, 2026-11-26)
// Both languages stop where the Japanese README stops: the description, the
// "why", and Install. The English README's later sections (Layout, what the
// installer does not cover, License detail) stay on GitHub, and the landing
// page links there. LANDING_CUT is the heading that marks that point.
//
// The output has no build step of its own and no external requests: one CSS
// file, one script, no CDN. With scripting off, the guide shows every page in
// order on one long page — still readable, just not paged.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGuidePages, GUIDE_HOME } from '../src/lib/userGuide.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const REPO_URL = 'https://github.com/LycorisManjusaka/memorhiza';
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!OUT) {
  console.error('usage: node --experimental-transform-types scripts/build-site.mjs <output-dir>');
  process.exit(2);
}

/** Per-language chrome. Guide labels mirror i18n.tsx `guide.*`. */
const L = {
  en: {
    htmlLang: 'en',
    readme: 'README.md',
    landingCut: '## Layout',
    siteTitle: 'MEMORHIZA',
    description: 'A chat app you run on your own computer, for talking with a digital being — an AI used as a brain by someone who keeps going between conversations.',
    guideTitle: 'Memorhiza — User Guide',
    openGuide: 'User guide',
    onGitHub: 'Source on GitHub',
    home: 'Home',
    contents: 'Contents',
    searchPh: 'Search the guide',
    searchNone: 'Nothing found for “{q}”',
    searchHits: '{n} matches',
    copy: 'Copy',
    copied: 'Copied',
    more: `The folder layout, the two pieces the installer does not cover (TTS engines and speech recognition), and what the license asks of you are in the [README on GitHub](${REPO_URL}#readme).`,
    footer: `Open source under the [Mozilla Public License 2.0](${REPO_URL}/blob/main/LICENSE). This site is generated from the README and the in-app guide.`,
    other: { code: 'ja', label: '日本語' },
    self: 'English',
  },
  ja: {
    htmlLang: 'ja',
    readme: 'README.ja.md',
    landingCut: '## これ以降の技術的な詳細は英語版に在る',
    siteTitle: 'MEMORHIZA',
    description: '自分のパソコンの上で動かすチャットアプリ。相手は「デジタル存在」——AIを脳として使い、会話をまたいで続いていく誰か。',
    guideTitle: 'Memorhiza — 使い方',
    openGuide: '使い方',
    onGitHub: 'GitHub のソース',
    home: 'ホーム',
    contents: '目次',
    searchPh: 'ガイド内を検索',
    searchNone: '「{q}」は見つかりませんでした',
    searchHits: '{n} 件',
    copy: 'コピー',
    copied: 'コピーしました',
    more: `フォルダ構成、インストーラが扱わない二つの部分（TTSエンジンと音声認識）、ライセンスが具体的に何を義務づけるかは、[GitHub の README（英語）](${REPO_URL}#readme) に書いてあります。`,
    footer: `[Mozilla Public License 2.0](${REPO_URL}/blob/main/LICENSE) で公開しているオープンソースです。このサイトは README とアプリ内の使い方から生成しています。`,
    other: { code: 'en', label: 'English' },
    self: '日本語',
  },
};

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Site-root-relative prefix for a page that lives `depth` folders down. */
const up = depth => (depth === 0 ? './' : '../'.repeat(depth));

/**
 * Markdown -> HTML with the app's own renderer.
 *
 * `a`: a relative link in a README points at a file in the repository
 * (README.md, LICENSE, web-app/scripts/README.md). On the site there is no
 * such file, so it is rewritten to the file on GitHub. `#...` links (the
 * guide's `#guide/<id>` form) and absolute links pass through untouched.
 * External links open in a new tab, as they do in the app.
 *
 * `table`: wrapped in a horizontal scroller, same reason as UserGuide.tsx — a
 * four-column table does not fit a phone.
 */
function md(body) {
  const components = {
    a: ({ href = '', children, node, ...rest }) => {
      let h = href;
      const external = /^[a-z][a-z0-9+.-]*:/i.test(h);
      if (!external && !h.startsWith('#')) h = `${REPO_URL}/blob/main/${h.replace(/^\.\//, '')}`;
      const out = external || h !== href;
      return React.createElement('a', { href: h, ...(out ? { target: '_blank', rel: 'noreferrer' } : {}), ...rest }, children);
    },
    table: ({ children, node, ...rest }) =>
      React.createElement('div', { className: 'table-wrap' }, React.createElement('table', rest, children)),
  };
  return renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, body));
}

/** The README up to (not including) the cut heading, minus the language-switch line. */
function landingMarkdown(lang) {
  const raw = fs.readFileSync(path.join(REPO_ROOT, L[lang].readme), 'utf8').replace(/\r\n/g, '\n');
  const cut = raw.indexOf('\n' + L[lang].landingCut + '\n');
  if (cut < 0) throw new Error(`${L[lang].readme}: cut heading not found: ${L[lang].landingCut}`);
  const lines = raw.slice(0, cut).split('\n');
  // First line is "[English](README.md) | [日本語](README.ja.md)" — the site has its own switch.
  if (!/^\[English\]\(README\.md\)/.test(lines[0])) throw new Error(`${L[lang].readme}: unexpected first line`);
  return lines.slice(1).join('\n').trim();
}

function shell({ lang, depth, title, description, bodyClass, body, otherHref, scripts = '' }) {
  const t = L[lang];
  const root = up(depth);
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<link rel="stylesheet" href="${root}assets/site.css">
</head>
<body class="${bodyClass}">
${body}
${scripts}
</body>
</html>
`;
}

function topbar({ lang, depth, otherHref, inGuide }) {
  const t = L[lang];
  const root = up(depth);
  const langRoot = lang === 'en' ? root : `${root}ja/`;
  return `<header class="topbar">
  <a class="brand" href="${langRoot}">MEMORHIZA</a>
  <nav class="topnav">
    ${inGuide ? `<a href="${langRoot}">${esc(t.home)}</a>` : `<a href="${langRoot}guide/">${esc(t.openGuide)}</a>`}
    <a href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
    <span class="langswitch"><span class="lang-current">${esc(t.self)}</span><a id="lang-other" href="${otherHref}" lang="${t.other.code}">${esc(t.other.label)}</a></span>
  </nav>
</header>`;
}

function landingPage(lang) {
  const t = L[lang];
  const depth = lang === 'en' ? 0 : 1;
  const otherHref = lang === 'en' ? './ja/' : '../';
  const langRoot = './';
  const body = `${topbar({ lang, depth, otherHref, inGuide: false })}
<main class="landing prose">
${md(landingMarkdown(lang))}
<p class="cta">
  <a class="button primary" href="${langRoot}guide/">${esc(t.openGuide)}</a>
  <a class="button" href="${REPO_URL}" target="_blank" rel="noreferrer">${esc(t.onGitHub)}</a>
</p>
${md(t.more)}
</main>
<footer class="sitefoot prose">${md(t.footer)}</footer>`;
  return shell({ lang, depth, title: t.siteTitle, description: t.description, bodyClass: 'page-landing', body });
}

function guidePage(lang) {
  const t = L[lang];
  const depth = lang === 'en' ? 1 : 2;
  const otherHref = lang === 'en' ? '../ja/guide/' : '../../guide/';
  const pages = getGuidePages(lang);
  const nav = pages.map(p => `<a class="idx" href="#guide/${p.id}" data-page="${p.id}">${esc(p.title)}</a>`).join('\n      ');
  const sections = pages.map(p =>
    `<section class="gpage prose" id="page-${p.id}" data-page="${p.id}" data-title="${esc(p.title)}">\n${md(p.body)}\n</section>`).join('\n');
  const strings = { home: GUIDE_HOME, none: t.searchNone, hits: t.searchHits, copy: t.copy, copied: t.copied };
  const body = `${topbar({ lang, depth, otherHref, inGuide: true })}
<div class="guide">
  <aside class="gside" id="gside">
    <p class="gside-title">${esc(t.contents)}</p>
    <input type="search" id="gsearch" placeholder="${esc(t.searchPh)}" aria-label="${esc(t.searchPh)}" autocomplete="off">
    <nav id="gindex" aria-label="${esc(t.contents)}">
      ${nav}
    </nav>
    <nav id="ghits" hidden></nav>
  </aside>
  <main class="gmain" id="gmain">
    <button type="button" class="gtoggle" id="gtoggle">☰ ${esc(t.contents)}</button>
${sections}
  </main>
</div>`;
  const scripts = `<script>window.GUIDE=${JSON.stringify(strings).replace(/</g, '\\u003c')};</script>\n<script src="${up(depth)}assets/guide.js"></script>`;
  return shell({ lang, depth, title: t.guideTitle, description: t.description, bodyClass: 'page-guide', body, scripts });
}

function write(rel, content) {
  const full = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  console.log(`${String(Buffer.byteLength(content)).padStart(8)}  ${rel}`);
}

write('index.html', landingPage('en'));
write('ja/index.html', landingPage('ja'));
write('guide/index.html', guidePage('en'));
write('ja/guide/index.html', guidePage('ja'));
for (const f of ['site.css', 'guide.js']) {
  write(`assets/${f}`, fs.readFileSync(path.join(HERE, 'site-assets', f), 'utf8'));
}
// GitHub Pages runs Jekyll by default; this turns it off so files are served as they are.
write('.nojekyll', '');
write('README.md', `# memorhiza.github.io

The public site for [Memorhiza](${REPO_URL}).

Every file here is **generated**. Do not edit them by hand — the next build overwrites it.
The text comes from \`README.md\`, \`README.ja.md\` and \`web-app/src/lib/userGuide.ts\` in the main repository.

To rebuild, in a clone of the main repository:

\`\`\`
cd web-app
node --experimental-transform-types scripts/build-site.mjs <path-to-this-folder>
\`\`\`
`);
