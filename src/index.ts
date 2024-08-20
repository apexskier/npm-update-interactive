import { exec } from "node:child_process";
import path from "node:path";
import * as semver from "semver";
import checkbox from "./select";
import colors from "yoctocolors-cjs";
import { program } from "commander";
import { ExitPromptError } from "@inquirer/core";

interface Outdated {
  current: string;
  wanted: string;
  latest: string;
  dependent: string;
  location: string;
}

program.option(
  "--latest",
  "install latest version of dependency, instead of version specified by semver",
);
program.parse();
const options = program.opts<{ latest: boolean }>();

async function getWorkspaceMap() {
  const workspaceMap = new Map<string, string>();
  const cwd = process.cwd();
  workspaceMap.set(path.basename(cwd), cwd);
  path.basename(cwd);

  const workspaces = await new Promise<Array<string> | Record<string, {}>>(
    (resolve, reject) => {
      exec("npm pkg get workspaces --json", (error, stdout, stderr) => {
        if (error) {
          reject(error);
        }

        if (stderr) {
          console.warn(`npm outdated stderr: ${stderr}`);
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
      workspaceMap.set(workspaceKey, workspace);
    }
  }

  return workspaceMap;
}

async function main() {
  // TODO: cli args
  // * --latest  or wanted
  // * change colorization? to match outdated?
  // * -w?

  const workspaceMap = await getWorkspaceMap();

  const outdated = await new Promise<
    Record<string, Outdated | Array<Outdated>>
  >((resolve, reject) => {
    exec("npm outdated --json", (error, stdout, stderr) => {
      if (stderr) {
        console.warn(`npm outdated stderr: ${stderr}`);
      }

      resolve(JSON.parse(stdout));
    });
  });

  let latestOrWanted: "wanted" | "latest" = "wanted";
  if (options.latest) {
    latestOrWanted = "latest";
  }
  console.log({ latestOrWanted });

  const filter = (info: Outdated) =>
    semver.neq(info.current, info[latestOrWanted]);

  const makeChoice = (info: Outdated & { pkg: string }) => {
    const diff = semver.diff(info.current, info[latestOrWanted]);
    let color;
    switch (diff) {
      case "major":
        color = colors.redBright;
        break;
      case "minor":
        color = colors.yellowBright;
        break;
      case "patch":
        color = colors.greenBright;
        break;
      case "premajor":
        color = colors.bgRed;
        break;
      case "preminor":
        color = colors.bgRed;
        break;
      case "prepatch":
        color = colors.bgRed;
        break;
      case "prerelease":
        color = colors.bgRed;
        break;
      case null:
        color = (str: string) => str;
      // throw new Error("unexpected");
    }
    return {
      name: `${info.dependent}:${info.pkg}@${info.current} -> ${color(
        `${info[latestOrWanted]}`,
      )} (${diff})`,
      value: info,
    };
  };

  const outdatedPackages = Object.keys(outdated);
  const answer = await checkbox({
    message: "Select packages to update",
    pageSize: 20,
    choices: outdatedPackages
      .filter((pkg) => {
        const p = outdated[pkg];
        if (Array.isArray(p)) {
          return p.every((p) => p.current !== p[latestOrWanted]);
        }
        return p.current !== p[latestOrWanted];
      })
      .map((pkg) => {
        const p = outdated[pkg];
        if (Array.isArray(p)) {
          const allTargetMatch = p.every(
            (a) => a[latestOrWanted] === p[0][latestOrWanted],
          );
          const allCurrentMatch = p.every((a) => a.current === p[0].current);
          const allMatch = allTargetMatch && allCurrentMatch;
          let name = `*:${pkg}@${allCurrentMatch ? p[0].current : "various"} -> ${
            allTargetMatch ? p[0][latestOrWanted] : "various"
          }`;
          if (allMatch) {
            name = makeChoice({
              pkg,
              ...p[0],
              dependent: "*",
            }).name;
          }
          return {
            name,
            expanded: !allMatch,
            choices: p.filter(filter).map((info) => {
              return makeChoice({ pkg, ...info });
            }),
          };
        }
        return makeChoice({ pkg, ...p });
      }),
  }).catch((err) => {
    if (err instanceof ExitPromptError) {
      return [];
    }
    throw err;
  });

  const updates = new Map<
    string,
    { root: boolean; deps: Array<Outdated & { pkg: string }> }
  >();
  let root = true;
  for (const key of workspaceMap.keys()) {
    updates.set(key, { root, deps: [] });
    root = false;
  }

  for (const info of answer) {
    updates.get(info.dependent)?.deps.push(info);
  }

  for (const [w, { root, deps }] of updates.entries()) {
    if (deps.length) {
      await new Promise<void>((resolve, reject) => {
        const cmd = `npm install${
          root ? "" : ` -w ${workspaceMap.get(w)}`
        } ${deps.map((dep) => `${dep.pkg}@${dep[latestOrWanted]}`).join(" ")}`;
        console.log(cmd);
        const p = exec(cmd, (error, stdout, stderr) => {
          if (error) {
            reject(error);
          }
          resolve();
        });
        p.stdout?.pipe(process.stdout);
        p.stderr?.pipe(process.stderr);
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
