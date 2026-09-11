# Appllama

The harness includes `appllama-app-design-skill` for designing and implementing
mobile screens in Expo / React Native. Run `node scripts/install.mjs` to link it
into `~/.claude/skills/` and `~/.agents/skills/` using the existing installer.
Reinstallation, retraction, conflict preservation, and uninstall follow the same
rules as other managed skill links.

This is the standalone design skill. The harness does not install `appllama-usage`
or configure the Appllama MCP. Use screenshots you supply or other accessible
references when the MCP is unavailable. The skill itself is free; model usage and
image generation depend on the tools you use.

For example: "Use appllama-app-design-skill to build this onboarding flow from
these screenshots."

## Source and updates

The files under `.claude/skills/appllama-app-design-skill/` are an unchanged copy
of the upstream skill and its reference files, with the upstream MIT license.

- Repository: <https://github.com/Appllama/appllama-skills>
- Commit: `dd5caaec3d5d50ad7fc0324da238119c6b7c3707`
- Skill version: `1.3.0`
- Imported: 2026-09-11

To update, review the upstream diff, replace the skill and reference files from
the selected commit, retain `LICENSE`, and update the revision recorded here.
The installer uses the checked-in copy and does not download upstream changes.
