import type {
  Command,
  CommandConstructor,
  PositionalCompletion,
} from "../libs/types/index.ts";

import { getCommand } from "../cmap.ts";
import {
  createError,
  isNodeError,
  log,
  simpleTemplate,
  x,
} from "../libs/core/index.ts";

function applyReplacements(
  template: string,
  commandReplacements: Record<string, string> | undefined,
): string {
  if (!template || !commandReplacements) {
    return template;
  }
  let result = template;
  for (const [key, value] of Object.entries(commandReplacements)) {
    const placeholder = `{{ .${key} }}`;
    result = result.replace(new RegExp(RegExp.escape(placeholder), "g"), value);
  }
  return result;
}

export default class Completions implements Command {
  static get allowPositionals() {
    return false;
  }
  static get positionalCompletion() {
    return "none" as const;
  }
  static get options() {
    return {};
  }
  async execute(_argv: string[]): Promise<number> {
    const script = await this.generateBashCompletionScript();
    log(script);
    return 0;
  }

  private async generateBashCompletionScript(): Promise<string> {
    const { a } = x;
    const programName = a.P_NAME;
    const commandMap = await getCommand(true);
    const subcommands = Object.keys(commandMap)
      .filter((c) => c !== "_default")
      .sort();
    const allSubcommands = [...subcommands].sort();
    const globalOpts = ["--version", "--help"].sort().join(" ");

    let caseBlock = "";

    const sortedCommandConfigEntries = Object.entries(commandMap).sort(
      ([a], [b]) => a.localeCompare(b),
    );

    for (const [alias, moduleName] of sortedCommandConfigEntries) {
      if (alias === "_default") continue;

      try {
        const CommandClass = await getCommand(alias);
        if (!CommandClass) {
          throw new Error(
            simpleTemplate(a.s.e.lcli.commandNotImplemented, {
              CommandAlias: alias,
            }),
          );
        }

        const commandsHelp = a.s.help.commands;
        const cmdHelpSection = commandsHelp[alias as keyof typeof commandsHelp];

        let helpFlags: Record<string, string> | undefined;
        if (
          cmdHelpSection &&
          "flags" in cmdHelpSection &&
          cmdHelpSection.flags
        ) {
          helpFlags = cmdHelpSection.flags;
        }

        caseBlock += this.generateCaseForCommand(
          alias,
          CommandClass,
          helpFlags,
        );
      } catch (err) {
        if (isNodeError(err)) {
          caseBlock += `  # failed to load command ${alias} (${moduleName.toString()}): ${String(
            err.message ?? err,
          )}\n`;
          createError(simpleTemplate(a.s.e.c.co.coError, { Command: alias }), {
            cause: err,
          });
        } else {
          createError(a.s.e.lcli.unknownErrorOccurred, { cause: err });
        }
      }
    }

    const script = `#!/usr/bin/env bash
# Bash completion for ${programName}
# Generated on: ${new Date().toISOString()}

_${programName}_completions() {
  local cur prev words cword
  _get_comp_words_by_ref -n : cur prev words cword

  local subcommands="${allSubcommands.join(" ")}"
  local global_opts="${globalOpts}"

  _bb_filedir() {
    local expanded_cur="\${cur/#~/$HOME}"
    local -a raw_completions
    # Use -f to get both files and directories
    mapfile -t raw_completions < <(compgen -f -- "\${expanded_cur}")

    COMPREPLY=()
    local has_dir=0
    for item in "\${raw_completions[@]}"; do
      if [[ -d "\${item}" ]]; then
        COMPREPLY+=("\${item}/")
        has_dir=1
      else
        COMPREPLY+=("\${item}")
      fi
    done

    # If ANY of the completions are directories, tell Bash not to add a space.
    # This prevents the annoying "mydir/ " completion.
    if [[ \${has_dir} -eq 1 ]]; then
      compopt -o nospace
    fi

    if [[ "\${cur}" == "~"* && "\${#COMPREPLY[@]}" -gt 0 ]]; then
      for i in "\${!COMPREPLY[@]}"; do
        COMPREPLY[i]="~/\${COMPREPLY[i]#"$HOME"/}"
      done
    fi
  }

  _bb_dirdir() {
    # For directory-only completion, we ALWAYS suppress the trailing space.
    compopt -o nospace

    local expanded_cur="\${cur/#~/$HOME}"
    # Use -d for directories only
    mapfile -t COMPREPLY < <(compgen -d -- "\${expanded_cur}")
    for i in "\${!COMPREPLY[@]}"; do
      COMPREPLY[i]+="/"
    done

    if [[ "\${cur}" == "~"* && "\${#COMPREPLY[@]}" -gt 0 ]]; then
      for i in "\${!COMPREPLY[@]}"; do
        COMPREPLY[i]="~/\${COMPREPLY[i]#"$HOME"/}"
      done
    fi
  }

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${subcommands} \${global_opts}" -- "\${cur}") )
    return 0
  fi

  case "\${words[1]}" in
${caseBlock}
    help)
      COMPREPLY=( $(compgen -W "\${subcommands}" -- "\${cur}") )
      ;;
    *)
      COMPREPLY=()
      ;;
  esac

  return 0
}

complete -F _${programName}_completions ${programName}
`;
    return script;
  }

  private generateCaseForCommand(
    alias: string,
    CommandClass: CommandConstructor,
    helpFlags?: Record<string, string>,
  ): string {
    const options = CommandClass.options ?? {};
    const allowPositionals = CommandClass.allowPositionals ?? false;
    const positionalCompletion = CommandClass.positionalCompletion ?? "none";

    const descEntries: string[] = [];
    const allOpts: string[] = [];

    const allValueOpts: string[] = [];
    const completionsByLongOpt: Record<
      string,
      { short?: string; completions: readonly string[] }
    > = {};

    for (const [longName, cfg] of Object.entries(options)) {
      const longOpt = `--${longName}`;
      allOpts.push(longOpt);

      let desc = (helpFlags && helpFlags[longName]) || "";
      const commandReplacements = CommandClass.helpReplacements;
      desc = applyReplacements(desc, commandReplacements);

      const safeKey = escapeForSingleQuotedBash(longOpt);
      const safeVal = escapeForDoubleQuotedBash(desc);
      descEntries.push(`_BB_DESC['${safeKey}']="${safeVal}"`);

      if (cfg.short) {
        const shortOpt = `-${cfg.short}`;
        allOpts.push(shortOpt);
        descEntries.push(
          `_BB_DESC['${escapeForSingleQuotedBash(shortOpt)}']="${safeVal}"`,
        );
      }

      if (cfg.type === "string") {
        allValueOpts.push(longOpt);
        if (cfg.short) allValueOpts.push(`-${cfg.short}`);

        if (cfg.completions && cfg.completions.length > 0) {
          completionsByLongOpt[longName] = {
            short: cfg.short,
            completions: cfg.completions,
          };
        }
      }
    }

    const allOptsJoined = Array.from(new Set(allOpts)).sort().join(" ");
    const valueOptsJoined = Array.from(new Set(allValueOpts))
      .map((v) => v.replace(/(["'\\])/g, "\\$1"))
      .join(" ");

    const valueCompletionCases = Object.entries(completionsByLongOpt)
      .map(([long, { short, completions }]) => {
        const casePattern = short ? `--${long}|-${short}` : `--${long}`;
        return `
        ${casePattern})
          COMPREPLY=( $(compgen -W "${completions.join(" ")}" -- "\${cur}") )
          ;;`;
      })
      .join("");

    const positionalHandler = this.getPositionalHandler(
      allowPositionals,
      positionalCompletion,
    );

    let valueOptionsBlock = "";

    if (valueOptsJoined.length > 0) {
      valueOptionsBlock = `
      if [[ " ${valueOptsJoined} " == *" \${prev} "* ]]; then
        case "\${prev}" in
          ${valueCompletionCases}
          *)
            ${positionalHandler}
            ;;
        esac
        return 0
      fi
      `;
    }

    const block = `
    ${alias})
      local _opts="${allOptsJoined}"
      declare -A _BB_DESC=()
      ${descEntries.join("\n      ")}${valueOptionsBlock}

      if [[ "\${cur}" == -* ]]; then
        COMPREPLY=( $(compgen -W "\${_opts}" -- "\${cur}") )
        if [[ -n "\${COMP_TYPE-}" && "\${COMP_TYPE}" -eq 63 ]]; then
          printf "\\n"
          local k d
          for k in "\${COMPREPLY[@]}"; do
            d="\${_BB_DESC["\${k}"]:-}"
            if [[ -n "\${d}" ]]; then
              printf "%-28s %s\\n" "\${k}" "\${d}"
            else
              printf "%s\\n" "\${k}"
            fi
          done
          COMPREPLY=()
          return 0
        fi

        return 0
      else
        ${positionalHandler}
      fi
      ;;
`;

    return block;
  }

  private getPositionalHandler(
    allow: boolean,
    type: PositionalCompletion,
  ): string {
    if (!allow) return "COMPREPLY=()";
    switch (type) {
      case "file":
        return "_bb_filedir";
      case "directory":
        return "_bb_dirdir";
      case "none":
      default:
        return "COMPREPLY=()";
    }
  }
}

function escapeForSingleQuotedBash(str: string | undefined): string {
  if (!str) return "";
  return str.replace(/'/g, `'"'"'`);
}

function escapeForDoubleQuotedBash(str: string | undefined): string {
  if (!str) return "";
  return str
    .replace(/\\/g, `\\\\`)
    .replace(/"/g, `\\"`)
    .replace(/\$/g, `\\$`)
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, "\\n");
}
