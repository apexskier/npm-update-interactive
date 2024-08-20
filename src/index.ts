#!/usr/bin/env node

import { exec } from "node:child_process";
import path from "node:path";
import * as semver from "semver";
import checkbox from "./select.js";
import colors from "yoctocolors-cjs";
import { program } from "commander";
import { ExitPromptError } from "@inquirer/core";
import open from "open";

interface Outdated {
  current: string;
  wanted: string;
  latest: string;
  dependent: string;
  location: string;
}

program.option(
  "-l, --latest",
  "install latest version of dependency, instead of version specified by semver",
);
program.option("-g, --global", "update globally installed packages");
program.option("--save", "also update values in package.json");
program.option("--dry-run", "output commands instead of executing them");
program.parse();
const options = program.opts<{
  latest?: true;
  global?: true;
  save?: true;
  dryRun?: true;
}>();

async function getWorkspaceMap(): Promise<
  | Map<string, { workspacePath: false | string; packageName: string }>
  | Map<string, null>
> {
  if (options.global) {
    return new Map([["global", null]]);
  }

  const workspaceMap = new Map<
    string,
    { workspacePath: false | string; packageName: string }
  >();
  workspaceMap.set(path.basename(process.cwd()), {
    workspacePath: false,
    packageName: await new Promise((resolve, reject) => {
      exec("npm pkg get name", (error, stdout, stderr) => {
        if (error) {
          reject(error);
        }

        if (stderr) {
          console.warn(`npm pkg get name: ${stderr}`);
        }

        resolve(JSON.parse(stdout) as string);
      });
    }),
  });

  const workspaces = await new Promise<Array<string> | Record<string, object>>(
    (resolve, reject) => {
      exec("npm pkg get workspaces --json", (error, stdout, stderr) => {
        if (error) {
          reject(error);
        }

        if (stderr) {
          console.warn(`npm pkg get workspaces --json stderr: ${stderr}`);
        }

        resolve(JSON.parse(stdout));
      });
    },
  );
  if (Array.isArray(workspaces)) {
    for (const workspace of workspaces) {
      const workspaceKey = path.basename(workspace);
      if (workspaceMap.has(workspaceKey)) {
        throw new Error(
          "duplicate workspaces, see https://github.com/npm/cli/issues/7736",
        );
      }
      const packageName = await new Promise<string>((resolve, reject) => {
        exec(`npm pkg get name -w ${workspace}`, (error, stdout, stderr) => {
          if (error) {
            reject(error);
          }

          if (stderr) {
            console.warn(`npm pkg get name -w ${workspace}: ${stderr}`);
          }

          resolve(Object.keys(JSON.parse(stdout) as Record<string, string>)[0]);
        });
      });
      workspaceMap.set(workspaceKey, {
        workspacePath: workspace,
        packageName,
      });
    }
  }

  return workspaceMap;
}

async function help(pkg: string) {
  return open(`https://npmjs.com/package/${pkg}`);
}

async function main() {
  const workspaceMap = await getWorkspaceMap();

  const outdated = await new Promise<
    Record<string, Outdated | Array<Outdated>>
  >((resolve) => {
    exec(
      `npm outdated --json${options.global ? " --global" : ""}`,
      (_, stdout, stderr) => {
        // don't error check, since this is expected exit 1

        if (stderr) {
          console.warn(`npm outdated stderr: ${stderr}`);
        }

        resolve(JSON.parse(stdout));
      },
    );
  });

  let latestOrWanted: "wanted" | "latest" = "wanted";
  if (options.latest) {
    latestOrWanted = "latest";
  }

  const filter = (info: Outdated) =>
    semver.neq(info.current, info[latestOrWanted]);

  const makeChoiceName = (info: {
    label?: string;
    pkg: string;
    current: string;
    latest: string;
    wanted: string;
  }) => {
    const diff = semver.diff(info.current, info[latestOrWanted]);
    let color;
    switch (diff) {
      case "patch":
        color = colors.greenBright;
        break;
      case "minor":
        color = colors.yellowBright;
        break;
      case "major":
        color = colors.redBright;
        break;
      case "premajor":
      case "preminor":
      case "prepatch":
      case "prerelease":
        color = colors.bgRed;
        break;
      case null:
        throw new Error("unexpected");
    }
    return `${info.label ? `${info.label}:` : ""}${info.pkg}@${color(
      `${info.current} -> ${info[latestOrWanted]}`,
    )}`;
  };

  const choices = Object.keys(outdated)
    .filter((pkg) => {
      const p = outdated[pkg];
      if (Array.isArray(p)) {
        return p.every((p) => p.current !== p[latestOrWanted]);
      }
      return p.current !== p[latestOrWanted];
    })
    .map<
      | { value: Outdated & { pkg: string }; name: string }
      | {
          name: string;
          expanded: boolean;
          choices: Array<{ value: Outdated & { pkg: string }; name: string }>;
        }
    >((pkg) => {
      const p = outdated[pkg];
      if (Array.isArray(p)) {
        const allTargetMatch = p.every(
          (a) => a[latestOrWanted] === p[0][latestOrWanted],
        );
        const allCurrentMatch = p.every((a) => a.current === p[0].current);
        const allMatch = allTargetMatch && allCurrentMatch;
        const groupName = allMatch
          ? makeChoiceName({
              label: "*",
              pkg,
              ...p[0],
            })
          : `*:${pkg}@${allCurrentMatch ? p[0].current : "various"} -> ${
              allTargetMatch ? p[0][latestOrWanted] : "various"
            }`;
        return {
          name: groupName,
          expanded: !allMatch,
          choices: p.filter(filter).map((info) => {
            const label = workspaceMap.get(info.dependent)?.packageName;
            const value = { pkg, ...info };
            const name = makeChoiceName({ label, ...value });
            return {
              value,
              name,
              help: () => help(pkg),
            };
          }),
          help: () => help(pkg),
        };
      }
      const label =
        workspaceMap.size === 1
          ? undefined
          : workspaceMap.get(p.dependent)?.packageName;
      const value = { pkg, ...p };
      const name = makeChoiceName({ label, ...value });
      return { value, name, help: () => help(pkg) };
    });
  if (choices.length === 0) {
    console.log("✨ All dependencies up-to-date");
    return;
  }
  const answer = await checkbox({
    message: "Select packages to update",
    pageSize: 20,
    choices,
  }).catch((err) => {
    if (err instanceof ExitPromptError) {
      return [];
    }
    throw err;
  });

  const updates = new Map<string, Array<Outdated & { pkg: string }>>();
  for (const key of workspaceMap.keys()) {
    updates.set(key, []);
  }
  for (const info of answer) {
    updates.get(info.dependent)?.push(info);
  }

  for (const [w, deps] of updates.entries()) {
    if (deps.length) {
      await new Promise<void>((resolve, reject) => {
        const workspacePkg = workspaceMap.get(w);
        const destinationArg = !workspacePkg
          ? " --global"
          : workspacePkg.workspacePath
            ? ` -w ${workspacePkg.workspacePath}`
            : "";
        const dependenciesArgs = deps
          .map((dep) => `${dep.pkg}@${dep[latestOrWanted]}`)
          .join(" ");
        const saveArg = options.save ? " --save" : "";
        const cmd = `npm install${destinationArg}${saveArg} ${dependenciesArgs}`;
        console.log(cmd);
        if (!options.dryRun) {
          const p = exec(cmd, (error) => {
            if (error) {
              reject(error);
            }
            resolve();
          });
          p.stdout?.pipe(process.stdout);
          p.stderr?.pipe(process.stderr);
        } else {
          resolve();
        }
      });
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
