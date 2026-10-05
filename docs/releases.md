# Reviewed-commit releases

The release is the full commit SHA in [the marketplace's `source.sha`](../.claude-plugin/marketplace.json). The catalog follows `main`; the plugin's files come from that one commit of `nu0ma/explain`. Updating the catalog does not select arbitrary newer source code. A maintainer must explicitly change the pin to publish it.

This is a release selection policy, not a signature or a guarantee that code is harmless. Review the chosen commit and its PRs before running it. A compromised catalog can still replace its pin; use the frozen-catalog option below when you need to approve every change yourself.

## Install or migrate

New users can use the commands in the [quick start](../README.md#quick-start). Existing users who installed the old relative-path source (`"./"`) must refresh the catalog and update their installed plugin once, from their shell:

```sh
claude plugin marketplace update explain
claude plugin update explain@explain
claude plugin list
```

Restart the Claude Code session after updating. In `/plugin`, open **Marketplaces → explain** and leave auto-update off. If it is already on, select **Disable auto-update**. A future deliberate update can install a new pin from the catalog; disabling background updates does not freeze the catalog for reinstalls.

Claude Code uses the plugin source commit as its cache version because both `plugin.json` and the marketplace entry omit `version`. The displayed version may be a shortened SHA. Compare it with the pin you reviewed and check the installed files if it differs. `package.json`'s version describes the CLI and does not select a plugin release. Do not add a static plugin version: it would take precedence over the commit and could conceal a changed pin behind an existing cached version.

## Freeze the catalog locally

For a persistent install whose selected commit cannot change when the upstream catalog changes:

1. Save the reviewed `.claude-plugin/marketplace.json` to a local file named `explain-reviewed.json`, outside a checkout that you regularly update.
2. Change only its top-level `name` to `explain-reviewed`. Keep the plugin name `explain`, the GitHub repository, and the full `source.sha` unchanged. Check the SHA against the commit and PR you reviewed.
3. From your shell, register that local file and install from it:

   ```sh
   claude plugin marketplace add /absolute/path/to/explain-reviewed.json
   claude plugin install explain@explain-reviewed
   ```

4. If migrating from `explain@explain`, disable that old install in `/plugin` so both copies are not enabled. Restart the session and verify the new install's version.

Keep the local file unchanged to hold this release. To upgrade or roll back, review the desired commit, replace the file's `source.sha` with its full SHA, then refresh the catalog and update the plugin:

```sh
claude plugin marketplace update explain-reviewed
claude plugin update explain@explain-reviewed
```

Restart the session and verify the installed version. The plugin is still fetched from GitHub, so this is not an offline installation. A local file controls catalog updates; the `github` source with `sha` controls the installed bytes.

## Publish a release

Use two steps so a commit never needs to contain its own hash:

1. Merge the implementation PR after review and passing CI. Record its actual full merged commit SHA. A PR head that was squash-merged is not the merge commit. Ensure the target remains reachable in `nu0ma/explain`.
2. In a separate release PR, change only `plugins[0].source.sha` in `.claude-plugin/marketplace.json` to that existing commit. Link the implementation PR, the exact commit, the comparison from the previous pin, and its CI results in the release PR. Review changes to prompts, commands, manifests, source, dependencies, and the committed bundle together. Do not use a branch, mutable tag, abbreviated SHA, or the release PR's own not-yet-created merge SHA.

Before merging the release PR:

- Check out the target commit in a separate worktree and run `pnpm install --frozen-lockfile`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run build`, and `pnpm test`. Verify the build did not change `skills/explain/scripts/explain.mjs`. Require the macOS E2E job too; local skips do not replace it. For prompt changes, follow the README's eval procedure.
- Validate the target plugin and the new catalog with `claude plugin validate`. An absent plugin version is intentional. Test installation from the candidate catalog, then compare the installed bundle with the target worktree's `skills/explain/scripts/explain.mjs` and confirm the skill/commands come from that commit. Validation alone does not fetch or verify the remote plugin.
- Run the release PR's normal checks. `test/plugin.test.ts` prevents a relative-path or floating source and prevents a static version from masking future pins. These structural tests do not prove that a commit was reviewed or that a remote install succeeds.

Merge the pin update only after these checks. Later implementation commits remain unreleased until another reviewed pin update. Rollback uses the same process, pointing at an earlier reviewed, reachable commit. No tag or GitHub Release is required, and this process does not create signing or provenance guarantees.

## Claude Code references

- [Plugin source `sha` fields](https://code.claude.com/docs/en/plugins/marketplace-reference#plugin-sources)
- [Version and cache resolution](https://code.claude.com/docs/en/plugins/loading#versions-and-updates)
- [Marketplace releases](https://code.claude.com/docs/en/plugins/host-marketplace#hold-users-on-one-version)
- [User-controlled updates](https://code.claude.com/docs/en/discover-plugins#keep-plugins-updated)
