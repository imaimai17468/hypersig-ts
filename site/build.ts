import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = new URL("./", import.meta.url);
const output = resolve(process.argv[2] ?? "dist/docs");
const origin = "https://imaimai17468.github.io/hypersig-ts/";
const repository = "https://github.com/imaimai17468/hypersig-ts";
const original = "https://imaimai17468.github.io/hypersig/";
const pages = [
  "",
  "start",
  "why",
  "concepts",
  "from-htmx",
  "reference",
  "deploy",
  "limits",
] as const;
const languages = ["en", "ja"] as const;
type Language = (typeof languages)[number];
type Page = (typeof pages)[number];
const locales = {
  en: {
    prefix: "",
    name: "English",
    nav: "Documentation",
    guide: "Docs",
    menu: "Documentation menu",
    skip: "Skip to content",
    start: "Get started",
    description:
      "A TypeScript web framework for keeping pages in sync with committed server state.",
    titles: [
      "Overview",
      "Get started",
      "Why hypersig",
      "Core concepts",
      "Migrating from htmx",
      "API reference",
      "Deployment",
      "Performance and limits",
    ],
    original: "Rust hypersig",
    legal: "Documentation",
  },
  ja: {
    prefix: "ja/",
    name: "日本語",
    nav: "ドキュメント",
    guide: "ガイド",
    menu: "ドキュメントの目次",
    skip: "本文へ移動",
    start: "はじめる",
    description:
      "サーバーで確定したデータに画面を同期し続けるための TypeScript の Web フレームワーク。",
    titles: [
      "概要",
      "はじめる",
      "設計の背景",
      "基本概念",
      "htmx からの移行",
      "API リファレンス",
      "デプロイ",
      "性能と制約",
    ],
    original: "Rust 版 hypersig",
    legal: "ドキュメント",
  },
};

function url(language: Language, page: Page) {
  return locales[language].prefix + (page ? page + "/" : "");
}

function relative(home: string, target: string) {
  return home + target;
}

function navigation(
  labels: (typeof locales)[Language],
  home: string,
  locale: Language,
  page: Page
) {
  return pages
    .map(
      (item, index) =>
        `<a href="${relative(home, url(locale, item))}"${item === page ? ' aria-current="page"' : ""}>${labels.titles[index]}</a>`
    )
    .join("\n");
}

function render(
  content: string,
  language: Language,
  page: Page,
  index: number
) {
  const labels = locales[language];
  const path = url(language, page);
  const home = "../".repeat(path.split("/").filter(Boolean).length) || "./";
  const links = navigation(labels, home, language, page);
  const title = page ? `${labels.titles[index]} · hypersig.ts` : "hypersig.ts";
  const alternateLanguage = language === "ja" ? "en" : "ja";
  const body = page
    ? `<div class="docs-shell"><aside class="sidebar"><nav aria-label="${labels.nav}">${links}</nav></aside><main id="main" class="article">
        <details class="docs-menu">
          <summary>${labels.menu}</summary>
          <nav aria-label="${labels.nav}">${links}</nav>
        </details>
        ${content}
      </main></div>`
    : `<main id="main" class="home">${content}</main>`;
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${labels.description}">
  <meta name="color-scheme" content="light dark">
  <title>${title}</title>
  <link rel="canonical" href="${origin}${path}">
  <link rel="alternate" hreflang="en" href="${origin}${url("en", page)}">
  <link rel="alternate" hreflang="ja" href="${origin}${url("ja", page)}">
  <link rel="alternate" hreflang="x-default" href="${origin}${url("en", page)}">
  <link rel="stylesheet" href="${home}assets/site.css">
</head>
<body>
  <a class="skip" href="#main">${labels.skip}</a>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="wordmark" aria-label="hypersig.ts" href="${relative(home, url(language, ""))}">hypersig<span>.ts</span></a>
      <nav class="topnav" aria-label="${labels.nav}">
        <a href="${relative(home, url(language, "start"))}"${page === "start" ? ' aria-current="page"' : ""}>${labels.guide}</a>
        <a href="${repository}">GitHub</a>
        <a href="${relative(home, url(alternateLanguage, page))}" lang="${alternateLanguage}" hreflang="${alternateLanguage}">${locales[alternateLanguage].name}</a>
      </nav>
    </div>
  </header>
  ${body}
  <footer class="footer"><div class="footer-inner">
    <a class="wordmark" href="${relative(home, url(language, ""))}">hypersig<span>.ts</span></a>
    <nav aria-label="${labels.legal}">
      <a href="${relative(home, url(language, "start"))}">${labels.start}</a>
      <a href="${original}">${labels.original}</a>
      <a href="${repository}">GitHub</a>
    </nav>
  </div></footer>
</body>
</html>
`;
}

await mkdir(join(output, "assets"), { recursive: true });
await copyFile(new URL("site.css", root), join(output, "assets", "site.css"));
for (const language of languages) {
  for (const [index, page] of pages.entries()) {
    const content = await readFile(
      new URL(`content/${language}/${page || "home"}.html`, root),
      "utf8"
    );
    const directory = join(output, url(language, page));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "index.html"),
      render(content, language, page, index)
    );
  }
}
console.log(
  `Built ${pages.length * languages.length} documentation pages in ${output}`
);
