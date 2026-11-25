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

The package name does not exist on npm until the first publish, and trusted publishing can be configured only for a package that exists. So the first release authenticates with an access token.

### Recommended: publish from the workflow

1. Add the `NPM_TOKEN` secret as described in [Access token](#access-token). The token needs permission to publish new packages (a granular token with read and write access to all packages, or an automation token).
2. Push the tag for the version in `package.json`:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

The release workflow publishes 0.1.0 with provenance. Afterwards, set up [trusted publishing](#trusted-publishing-recommended), then delete the secret and revoke the token.

### Alternative: publish by hand

From a clean checkout of `main`:

```sh
npm login
mise exec -- npm publish --access public --no-provenance
```

`publishConfig.provenance` is `true` so that CI publishes with provenance, and a provenance statement can be generated only on a supported CI provider, so `--no-provenance` turns it off for this one local publish. `prepack` rebuilds `dist/` before packing. Tag the commit afterwards (`git tag v0.1.0 && git push origin v0.1.0`) so later tags continue from it; the release workflow that tag starts fails at `npm publish` because 0.1.0 already exists, which is expected for this path only.

## Later releases (by tag)

Push a tag named `v` followed by the version in `package.json`:

```sh
git tag v0.2.0
git push origin v0.2.0
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) checks that the tag matches `package.json`, runs the check, tests, and build, and publishes with `npm publish --provenance --access public`. A tag that does not match the version fails before anything is published.

## Authenticating the workflow

Use one of the following.

### Trusted publishing (recommended)

npm can trust this repository's workflow through OpenID Connect, so no long-lived token is stored.

1. On npmjs.com, open the package's **Settings** and find **Trusted Publisher**.
2. Choose **GitHub Actions** and enter the owner `imaimai17468`, the repository `hypersig-ts`, and the workflow file `release.yml`.
3. Save. The workflow already has `id-token: write`, and the npm CLI bundled with the pinned Node (11.5.1 or later is required) exchanges the workflow's OIDC token for a short-lived publish credential. The `NPM_TOKEN` secret is then not needed; once a trusted release has succeeded, delete the secret and revoke the token.

Trusted publishing can be configured only after the package exists, so set it up after the first release.

### Access token

1. On npmjs.com, create a granular access token with read and write access to `hypersig-ts` (or an automation token).
2. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add a repository secret named `NPM_TOKEN` with the token.

The workflow passes the secret as `NODE_AUTH_TOKEN`, and the registry configuration step reads it from there.
