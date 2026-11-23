# Documentation site

Build from the repository root with the pinned Node version.

```sh
mise exec -- node site/build.ts
```

The output is in `dist/docs`. Serve that directory with a static HTTP server for a local preview.

The English and Japanese page fragments live in `content/en` and `content/ja`. Use the same page filenames and section IDs in both languages. Each language link opens the equivalent page. The GitHub Pages workflow builds and publishes the site when its source changes on the default branch.
