import {
  createPrompt,
  KeypressEvent,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  useRef,
  useMemo,
  makeTheme,
  isUpKey,
  isDownKey,
  isSpaceKey,
  isNumberKey,
  isEnterKey,
  ValidationError,
  Separator,
  type Theme,
} from "@inquirer/core";
import type { PartialDeep } from "@inquirer/type";
import colors from "yoctocolors-cjs";
import figures from "@inquirer/figures";
import ansiEscapes from "ansi-escapes";
import assert from "node:assert";

type CheckboxTheme = {
  icon: {
    checked: string;
    unchecked: string;
    cursor: string;
  };
  style: {
    disabledChoice: (text: string) => string;
    renderSelectedChoices: <T>(
      selectedChoices: ReadonlyArray<Group<T> | Choice<T>>,
      allChoices: ReadonlyArray<Group<T> | Choice<T> | Separator>,
    ) => string;
  };
  helpMode: "always" | "never" | "auto";
};

const checkboxTheme: CheckboxTheme = {
  icon: {
    checked: colors.green(figures.circleFilled),
    unchecked: figures.circle,
    cursor: figures.pointer,
  },
  style: {
    disabledChoice: (text: string) => colors.dim(`- ${text}`),
    renderSelectedChoices: (selectedChoices) =>
      selectedChoices
        .map((choice) => choice.short ?? choice.name ?? "TODO")
        .join(", "),
  },
  helpMode: "auto",
};

function mapItemStatic<Value, T extends Item<Value>>(checked: boolean) {
  return (item: T): T => {
    if (isGroup(item)) {
      return {
        ...item,
        choices: item.choices.map(mapItemStatic(checked)),
      };
    }
    if (isSelectable(item)) {
      return { ...item, checked };
    }
    return item;
  };
}

type Choice<Value> = {
  name?: string;
  value: Value;
  short?: string;
  disabled?: boolean | string;
  checked?: boolean;
  type?: never;
  help?: () => Promise<void>;
};

type Group<Value> = {
  name?: string;
  short?: string;
  choices: Array<Choice<Value>>;
  disabled?: boolean | string;
  expanded?: boolean;
  type?: never;
  help?: () => Promise<void>;
};

type Config<Value> = {
  message: string;
  prefix?: string;
  pageSize?: number;
  instructions?: string | boolean;
  choices: ReadonlyArray<Group<Value> | Choice<Value> | Separator>;
  loop?: boolean;
  required?: boolean;
  validate?: (
    choices: ReadonlyArray<Choice<Value>>,
  ) => boolean | string | Promise<string | boolean>;
  theme?: PartialDeep<Theme<CheckboxTheme>>;
};

type Item<Value> = Separator | Choice<Value> | Group<Value>;

function isSelectable<Value>(item: Item<Value>): item is Choice<Value> {
  return !Separator.isSeparator(item) && !item.disabled;
}

function isChecked<Value>(item: Item<Value>): item is Choice<Value> {
  return isSelectable(item) && Boolean(item.checked);
}

function anyChecked<Value>(item: Item<Value>): boolean {
  if (isGroup(item)) {
    return item.choices.some(anyChecked);
  }
  return isChecked(item);
}

function allChecked<Value>(item: Item<Value>): boolean {
  if (isGroup(item)) {
    return item.choices.every(allChecked);
  }
  return isChecked(item);
}

function getChecked<Value>(item: Item<Value>): Array<Choice<Value>> {
  if (Separator.isSeparator(item)) {
    return [];
  }
  if (isGroup(item)) {
    return item.choices.flatMap(getChecked);
  }
  return item.checked ? [item] : [];
}

function calcPrior<Value>(ptr: Item<Value>): Array<number> {
  if (isGroup(ptr) && ptr.expanded) {
    const idx = ptr.choices.length - 1;
    return [idx, ...calcPrior(ptr.choices[idx])];
  }
  return [];
}

function isGroup<Value>(
  x: Separator | Choice<Value> | Group<Value>,
): x is Group<Value> {
  return (x as Group<Value>).choices !== undefined;
}

const isLeftKey = (key: KeypressEvent): boolean =>
  // The left key
  key.name === "left" ||
  // Vim keybinding
  key.name === "h" ||
  // Emacs keybinding
  (key.ctrl && key.name === "b");

const isRightKey = (key: KeypressEvent): boolean =>
  // The right key
  key.name === "right" ||
  // Vim keybinding
  key.name === "l" ||
  // Emacs keybinding
  (key.ctrl && key.name === "f");

function countChoices<Value>(item: Group<Value>): number {
  return item.choices.reduce(
    (acc, choice) => acc + (isGroup(choice) ? countChoices(choice) : 1),
    0,
  );
}

function getActiveIndexForPagination<Value>(
  active: ReadonlyArray<number>,
  items: ReadonlyArray<Item<Value>>,
): number {
  let count = active.reduce((acc, cur) => acc + cur + 1, 0);
  for (let i = 0; i < active[0]; i++) {
    const item = items[i];
    if (isGroup(item) && item.expanded) {
      count += countChoices(item);
    }
  }
  return count;
}

function toggle<Value, T extends Item<Value>>(item: T): T {
  if (Separator.isSeparator(item)) {
    return item;
  }
  if (isGroup(item)) {
    return {
      ...item,
      choices: item.choices.map(toggle),
    };
  }
  return { ...item, checked: !item.checked };
}

export default createPrompt(
  <Value>(config: Config<Value>, done: (value: Array<Value>) => void) => {
    const {
      instructions,
      pageSize = 7,
      loop = true,
      choices,
      required,
      validate = () => true,
    } = config;
    const theme = makeTheme<CheckboxTheme>(checkboxTheme, config.theme);
    const prefix = usePrefix({ theme });
    const firstRender = useRef(true);
    const [status, setStatus] = useState("pending");
    const [items, setItems] = useState<ReadonlyArray<Item<Value>>>(
      choices.flatMap((choice) => ({ ...choice })),
    );

    const bounds = useMemo(() => {
      const first = items.findIndex(isSelectable);
      const last = items.findLastIndex(isSelectable);

      if (first < 0) {
        throw new ValidationError(
          "[checkbox prompt] No selectable choices. All choices are disabled.",
        );
      }

      return { first, last };
    }, [items]);

    const [showHelpTip, setShowHelpTip] = useState(true);
    const [errorMsg, setError] = useState<string>();

    // this a list of indices, each index is the active choice at that level
    const [active, setActive] = useState<Array<number>>([bounds.first]);

    useKeypress(async (key) => {
      if (isEnterKey(key)) {
        const selection = items.flatMap(getChecked);
        const isValid = await validate([...selection]);
        if (required && !items.some(anyChecked)) {
          setError("At least one choice must be selected");
        } else if (isValid === true) {
          setStatus("done");
          done(selection.map((choice) => choice.value));
        } else {
          setError(isValid || "You must select a valid value");
        }
      } else if (isDownKey(key)) {
        setActive(
          (() => {
            const [, hierarchy] = active.reduce<
              [
                ReadonlyArray<Item<Value>>,
                ReadonlyArray<Choice<Value> | Group<Value> | Separator>,
              ]
            >(
              ([choices, acc], activeIndex) => {
                const choice = (choices as ReadonlyArray<Item<Value>>)[
                  activeIndex
                ];
                return [
                  isGroup(choice) ? choice.choices : [],
                  [...acc, choice],
                ];
              },
              [items, []],
            );

            // if current item is group, and open, select first child
            const currentSelectedItem = hierarchy[hierarchy.length - 1];
            if (
              isGroup(currentSelectedItem) &&
              currentSelectedItem.expanded &&
              currentSelectedItem.choices.length
            ) {
              return [...active, 0];
            }

            // if no parents, just select next item
            if (active.length === 1) {
              return [active[0] + 1];
            }

            // otherwise if parent is group and has more children, select next child
            const parentSelectedItem = hierarchy[hierarchy.length - 2];
            assert(isGroup(parentSelectedItem));
            const nextChildIndex = active[active.length - 1] + 1;
            if (nextChildIndex < parentSelectedItem.choices.length) {
              return [...active.slice(0, -1), nextChildIndex];
            }

            // otherwise add one to parent index and drop tail
            return [...active.slice(0, -2), active.slice(-2, -1)[0] + 1];
          })(),
        );
      } else if (isUpKey(key)) {
        setActive(
          (() => {
            // wrap around
            if (active.length === 1 && active[0] === 0) {
              return [bounds.last];
            }

            // if tail is 0, drop tail
            if (active[active.length - 1] === 0) {
              return active.slice(0, -1);
            }

            // otherwise subtract one from tail
            // if tail is a group and expanded, select last child (recursively)
            const n = [...active.slice(0, -1), active[active.length - 1] - 1];
            let ptr = items[n[0]] as Group<Value>;
            for (let i = 1; i < n.length; i++) {
              ptr = ptr.choices[n[i]] as unknown as Group<Value>;
            }

            return [...n, ...calcPrior(ptr)];
          })(),
        );
      } else if (isRightKey(key)) {
        setItems(
          items.map(
            (function mapItem(depth: number) {
              const activeIndex = active[depth];
              return <T extends Item<Value>>(item: T, index: number): T => {
                if (index !== activeIndex || !isGroup(item)) {
                  return item;
                }
                return {
                  ...item,
                  expanded: true,
                  choices: item.choices.map(mapItem(depth + 1)),
                };
              };
            })(0),
          ),
        );
      } else if (isLeftKey(key)) {
        setItems(
          items.map(
            (function mapItem(depth: number, isParentSelected: boolean) {
              const activeIndex = active[depth];
              return <T extends Item<Value>>(item: T, index: number): T => {
                const currentInSelectionTree =
                  isParentSelected || activeIndex === index;
                if (isGroup(item) && currentInSelectionTree) {
                  return {
                    ...item,
                    expanded: false,
                    choices: item.choices.map(
                      mapItem(depth + 1, currentInSelectionTree),
                    ),
                  };
                }
                return item;
              };
            })(0, false),
          ),
        );
        if (active.length > 1) {
          setActive(active.slice(0, -1));
        }
      } else if (isSpaceKey(key)) {
        setError(undefined);
        setShowHelpTip(false);
        setItems(
          items.map(
            (function mapItem(depth: number) {
              const activeIndex = active[depth];
              const finalIteration = depth === active.length - 1;
              return <T extends Item<Value>>(item: T, index: number): T => {
                if (activeIndex === index) {
                  if (finalIteration) {
                    if (isGroup(item)) {
                      const checked = !allChecked(item);
                      return {
                        ...item,
                        choices: item.choices.map(mapItemStatic(checked)),
                      };
                    } else if (isSelectable(item)) {
                      return { ...item, checked: !item.checked };
                    }
                  } else {
                    assert(isGroup(item));
                    return {
                      ...item,
                      choices: item.choices.map(mapItem(depth + 1)),
                    };
                  }
                }
                return item;
              };
            })(0),
          ),
        );
      } else if (key.name === "a") {
        const selectAll = !items.every(allChecked);
        setItems(
          items.map(function check<T extends Item<Value>>(item: T): T {
            if (isGroup(item)) {
              return {
                ...item,
                choices: item.choices.map(check),
              };
            }
            if (isSelectable(item)) {
              return { ...item, checked: selectAll };
            }
            return item;
          }),
        );
      } else if (key.name === "i") {
        setItems(items.map(toggle));
      } else if ((key as unknown as { sequence: string }).sequence === "?") {
        const item = active.slice(1).reduce((acc, cur) => {
          assert(isGroup(acc));
          return acc.choices[cur];
        }, items[active[0]]);
        if (!Separator.isSeparator(item)) {
          item.help?.();
        }
      } else if (isNumberKey(key)) {
        // unsupported
      }
    });

    const message = theme.style.message(config.message);

    const paginationIndex = getActiveIndexForPagination(active, items) - 1;
    const page = usePagination<Item<Value> & { depth?: number; last?: number }>(
      {
        items: items.flatMap(
          (function mapItem(depth: number) {
            return (item: Item<Value>): Item<Value> | Array<Item<Value>> => {
              if (Separator.isSeparator(item)) {
                return item;
              }
              if (isGroup(item)) {
                return item.expanded
                  ? [
                      item,
                      ...item.choices
                        .flatMap(mapItem(depth + 1))
                        .map((item, i, arr) => ({
                          ...item,
                          depth: depth + 1,
                          last: i === arr.length - 1,
                        })),
                    ]
                  : item;
              }
              return item;
            };
          })(0),
        ),
        active: paginationIndex,
        renderItem({ item, isActive }) {
          if (Separator.isSeparator(item)) {
            return ` ${item.separator}`;
          }

          let nestPrefix = "";
          if (item.depth) {
            nestPrefix =
              Array(item.depth - 1)
                .fill("|")
                .join("") + (item.last ? "└─" : "├─");
          }

          const line = String(item.name || "TODO");
          if (item.disabled) {
            const disabledLabel =
              typeof item.disabled === "string" ? item.disabled : "(disabled)";
            return theme.style.disabledChoice(`${line} ${disabledLabel}`);
          }

          let checkbox: string;
          if (isGroup(item)) {
            if (item.choices.every(allChecked)) {
              checkbox = theme.icon.checked;
            } else if (item.choices.some(anyChecked)) {
              checkbox = "⊘";
            } else {
              checkbox = theme.icon.unchecked;
            }
          } else {
            checkbox = item.checked ? theme.icon.checked : theme.icon.unchecked;
          }
          const color = isActive ? theme.style.highlight : (x: string) => x;
          const cursor = isActive ? theme.icon.cursor : " ";
          return color(`${cursor}${nestPrefix}${checkbox} ${line}`);
        },
        pageSize,
        loop,
      },
    );

    if (status === "done") {
      const selection = items.flatMap(getChecked);
      const answer = theme.style.answer(
        theme.style.renderSelectedChoices(selection, items),
      );

      return `${prefix} ${message} ${answer}`;
    }

    let helpTipTop = "";
    let helpTipBottom = "";
    if (
      theme.helpMode === "always" ||
      (theme.helpMode === "auto" &&
        showHelpTip &&
        (instructions === undefined || instructions))
    ) {
      if (typeof instructions === "string") {
        helpTipTop = instructions;
      } else {
        const keys = [
          `${theme.style.key("space")} to select`,
          `${theme.style.key("?")} to open info`,
          `${theme.style.key("a")} to toggle all`,
          `${theme.style.key("i")} to invert selection`,
          `and ${theme.style.key("enter")} to proceed`,
        ];
        helpTipTop = ` (Press ${keys.join(", ")})`;
      }

      if (
        items.length > pageSize &&
        (theme.helpMode === "always" ||
          (theme.helpMode === "auto" && firstRender.current))
      ) {
        helpTipBottom = `\n${theme.style.help(
          "(Use arrow keys to reveal more choices)",
        )}`;
        firstRender.current = false;
      }
    }

    let error = "";
    if (errorMsg) {
      error = `\n${theme.style.error(errorMsg)}`;
    }

    return `${prefix} ${message}${helpTipTop}\n${page}${helpTipBottom}${error}${ansiEscapes.cursorHide}`;
  },
);
