# Changesets

Each user-facing change to a package needs a changeset. Run `pnpm changeset`, pick the
packages and the bump, and commit the generated file with the change.

On `main`, the release workflow opens a "Version packages" PR that applies pending changesets
(versions and changelogs). Merging that PR publishes the new versions to npm with provenance.
Packages marked `"private": true` are versioned but never published.
