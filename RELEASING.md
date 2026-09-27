# Releasing

Releases are driven by [Changesets](https://github.com/changesets/changesets) and the
`Release` workflow (`.github/workflows/release.yml`).

1. Every user-facing change comes with a changeset (`pnpm changeset`).
2. On `main`, the workflow runs lint, typecheck, tests and build, then opens or updates the
   **Version packages** PR (versions and changelogs).
3. Merging that PR publishes the new versions to npm with provenance and pushes the tags
   (`<package>@<version>`).

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC): no
token is stored in the repository.

## First publish of a new package

npm only accepts a trusted publisher for a package that already exists, so the first version of
each plugin goes out with a short-lived token:

1. On npmjs.com, create a **granular access token** with read and write access to all packages
   (a package that does not exist yet cannot be selected), expiring in a day. If your account
   requires two-factor authentication for writes, allow the token to bypass it.
2. Add it as the repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).
3. Merge the **Version packages** PR. The workflow publishes with the token (npm tries OIDC first
   and falls back to it), still with provenance.
4. For each published package, on npmjs.com → package **Settings → Trusted publisher**, add GitHub
   Actions with repository `rodolphobrock/paperclip-plugins` and workflow `release.yml`.
5. Delete the `NPM_TOKEN` secret and revoke the token.

From then on every release uses OIDC only.

## Before merging the Version packages PR

- `CI`, `Integration` and `E2E` are green on `main`.
- The [end-to-end checklist](docs/e2e-checklist.md) manual items were checked for this release.
