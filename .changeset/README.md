# Changesets

Each user-facing change to a package needs a changeset. Run `pnpm changeset`, pick the
packages and the bump, and commit the generated file with the change.

On `main`, the release workflow runs lint, typecheck, tests and build, then opens a "Version packages"
PR that applies pending changesets (versions and changelogs). Merging that PR publishes the new
versions to npm through trusted publishing (OIDC, automatic provenance, no stored token) and pushes
the release tags.
Packages marked `"private": true` are versioned but never published.
