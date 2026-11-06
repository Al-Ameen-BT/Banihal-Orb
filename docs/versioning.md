# Product versioning and releases

The B2B application uses [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`, with prerelease labels while work is not ready for production.

| Change | Example after 2.0.0 |
| --- | --- |
| Compatible bug fix | 2.0.1 |
| Compatible feature | 2.1.0 |
| Breaking API, authentication or upgrade contract | 3.0.0 |
| Development work | 2.1.0-dev.0 |
| Release candidate | 2.1.0-rc.1 |

Versioning was introduced at `2.0.0-dev.0`: the preceding packages declared 1.0.0 and the new machine authentication/retired endpoints break older integrations. The current version is recorded in `VERSION`; a development number does not claim that version 2 is deployed or certified.

## One product version

`VERSION` is authoritative. Run commands from the repository root:

```bash
node scripts/version.mjs check
node scripts/version.mjs set 2.0.0-rc.1
node scripts/version.test.mjs
```

`set` synchronizes client/server package manifests, their lockfile root versions, and `server/src/product-version.json`. Dependency versions are preserved. Do not use separate `npm version` commands inside client/server or edit the generated API version file manually. An interrupted multi-file update is detected by `check`; rerun `set` before building.

The frontend embeds its package version at build time and shows it in the sidebar. The API embeds `product-version.json` into the compiled build; `/api/version` returns `{product,version}` and `/health` includes `version`. API and frontend artifacts can therefore be compared after rollout without relying on mutable runtime environment variables.

Product version, API URL version and machine wire-protocol version are distinct. Product `2.0.0-dev.0` does not mean every API URL is `/v2`, and a product patch does not change the Squid machine protocol. The separate Squid WebUI repository retains its own versioning; host compatibility must be documented in release notes.

## Existing repository and older versions

Use the existing `Al-Ameen-BT/B2B-Site` Git repository for both old and new versions. No replacement repository is required. Git commits preserve source history; immutable annotated tags identify tested releases. Never move a published tag or assign a release number to an unverified historical commit.

The local working-tree baseline at introduction was commit `f8cfb5e710fafcfcbf48d651b037297b488381ee`; it is a source reference, not a verified production release. Local `origin/main` was an older cached reference. On 2026-11-06, the connected GitHub API confirmed that this repository had no release tag refs. No historical production release was inferred from package metadata or cached branch names.

To establish an official old `v1.0.0`, first identify and verify the actual production source commit. Tag that exact commit only after review; do not tag today's dirty working tree as the old release. Reading older source with `git show <tag>:<path>` does not alter the active checkout. Use an isolated checkout for old builds and a reviewed database-compatible rollback procedure for production.

## Release procedure

1. Complete the changes and update `CHANGELOG.md`, including migrations, machine/client compatibility and rollback requirements.
2. Use `set` for the desired candidate or stable version. Commit the version files and changelog with the source changes. Run version checks, tests, both application typechecks/builds, and required staging checks. A version number alone never establishes release readiness.
3. Confirm a clean tree with `git status --short` and verify the exact commit. For a stable 2.0.0 release, check the tag value before creating it:

   ```bash
   node scripts/version.mjs check --tag v2.0.0
   git tag -a v2.0.0 -m "BanihalOrb 2.0.0"
   git push origin v2.0.0
   ```

   These are release-time instructions, not commands executed during setup. Prereleases use tags such as `v2.0.0-rc.1`.

4. CI checks version consistency and requires a pushed `v*` tag to match `VERSION`. Tag validation does not publish a GitHub Release or automatically deploy a tag; the existing production deployment still runs from main with its approval gate.
5. Build both artifacts from the same tagged commit. Keep the existing image Git-SHA tags for rollback: the semantic tag communicates the release, while the SHA identifies the exact image source. Compare sidebar and `/api/version` after rollout.

Never reuse a released version for changed code. Increment the version and retain prior tags. Database downgrade safety and persistent data remain separate from source version numbering.
