# npm-update-interactive

A command-line tool for interactively updating npm packages with full workspace support.

You can think of `npm-upgrade-interactive` as a combination of the `npm outdated` and `npm update [package...]` commands. Where `npm outdated` displays the list of outdated packages and `npm update [package...]` can then be used to upgrade desired packages, `npm-upgrade-interactive` displays the same outdated package list and lets you immediately and interactively choose which to upgrade.

## Usage

```bash
npx npm-update-interactive
```

This will launch the interactive interface where you can select which packages to update.

Colors indicate safety of the update, `red` is a breaking change, `yellow` is a minor update, and `green` is patch.

In a project using [workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces), items are prefixed with a shorted version of the workspace name. Workspaces using common dependencies are grouped under the prefix `*`, using left/right to expand the group.

```bash
npx npm-update-interactive --help
```

See additional options.

https://github.com/user-attachments/assets/1d3dea0c-1985-4bb3-9d54-e255aa5dad23
