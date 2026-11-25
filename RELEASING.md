# Releasing

hypersig-ts is published to npm as [`hypersig-ts`](https://www.npmjs.com/package/hypersig-ts). Releases follow [Semantic Versioning](https://semver.org/); while the version is 0.x, a minor version may contain breaking changes.

## Before every release

1. Update `version` in `package.json`.
2. Move the entries under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) to a new section for the version and date, and update the comparison links at the bottom.
3. Run the checks with the pinned toolchain:

   ```sh
   mise exec -- bun install --frozen-lockfile
   mise exec -- bun run check
   mise exec -- bun run test
   mise exec -- bun run test:browser
   mise exec -- bun run build
   mise exec -- npm pack --dry-run
   ```

   `npm pack --dry-run` lists the files that will be published. It should show only `LICENSE`, `README.md`, `CHANGELOG.md`, `package.json`, and the top-level files in `dist/`.

4. Commit the changes and merge them into `main`.

## First release

0.1.0 was published by hand on 2026-11-25. An access token that does not bypass two-factor authentication cannot publish from CI (`npm publish` fails with `EOTP`), and npm is restricting tokens that do bypass it, so the release workflow authenticates with trusted publishing only.

To publish by hand (only needed if trusted publishing is unavailable), from a clean checkout of the tagged commit:

```sh
npm login --auth-type=web
mise exec -- npm publish --access public --no-provenance --auth-type=web
```

Both commands print a URL to approve in a browser, so they also work when the approval happens on a phone. `--no-provenance` is needed because a provenance statement can be generated only on a supported CI provider. `prepack` rebuilds `dist/` before packing.

## Later releases (by tag)

Push a tag named `v` followed by the version in `package.json`:

```sh
git tag v0.2.0
git push origin v0.2.0
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) checks that the tag matches `package.json`, runs the check, tests, and build, and publishes with `npm publish --provenance --access public`. A tag that does not match the version fails before anything is published.

## Authenticating the workflow

Configure trusted publishing once; the workflow then needs no secret.

1. On npmjs.com, open the package's **Settings** and find **Trusted Publisher**.
2. Choose **GitHub Actions** and enter the owner `imaimai17468`, the repository `hypersig-ts`, and the workflow file `release.yml`.
3. Save. The workflow already has `id-token: write`, and the npm CLI bundled with the pinned Node exchanges the workflow's OIDC token for a short-lived publish credential.
4. Delete the `NPM_TOKEN` repository secret and revoke the token on npmjs.com if one was created.
