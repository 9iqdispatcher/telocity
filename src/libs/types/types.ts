import type { EnUsStrings } from "../../cmap.ts";

export interface AppState {
  readonly P_NAME: string;
  readonly P_VERSION: string;
  readonly HOME_DIR: string;
  readonly STATE_DIR: string;
  readonly DEBUG_MODE: boolean;
  readonly isInteractive: boolean;
  readonly LIST_INDENT_WIDTH: number;
  readonly TERMINAL_WIDTH: number;
  readonly SEPARATOR: string;
  readonly supportedLocaleSet: Set<string>;
  readonly languageToLocaleMap: Map<string, string>;
  readonly s: LanguageStrings;
  readonly NO_MARKDOWN: boolean;

  activeJob: CancellableJob | null;

  stringifyReadable(obj: unknown, maxLength?: number, indent?: number): string;
  getStateDirPath(appName: string): string;
  getUserLocale(): Promise<string | null>;
  isValidLocale(locale: string): boolean;
  findBestSupportedLocale(
    localeString: string | undefined | null,
  ): string | null;
  getLocale(): Promise<string>;
  setDebug(): boolean;
}

export type ErrOpts = {
  level: "warn" | "error" | "critical";
};

export interface CreateErrorOptions {
  cause?: unknown;
  code?: string;
  immediateExitCode?: boolean;
}

export interface NodeError extends Error {
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

export interface CustomOptionConfig {
  type: "string" | "boolean";
  short?: string;
  default?: string | boolean;
}

export interface CustomParseArgsConfig<
  T extends { options?: { [longOption: string]: CustomOptionConfig } },
> {
  args?: string[];
  options?: T["options"];
  allowPositionals?: boolean;
  strict?: boolean;
}

type OptionValue<O extends CustomOptionConfig> = O["type"] extends "string"
  ? string
  : boolean;

type OptionsWithDefaults<
  T extends CustomParseArgsConfig<{
    options?: Record<string, CustomOptionConfig>;
  }>,
> = {
  [K in keyof T["options"] as T["options"][K] extends { default: unknown }
    ? K
    : never]: OptionValue<NonNullable<T["options"]>[K] & CustomOptionConfig>;
};

type OptionsWithoutDefaults<
  T extends CustomParseArgsConfig<{
    options?: Record<string, CustomOptionConfig>;
  }>,
> = {
  [K in keyof T["options"] as T["options"][K] extends { default: unknown }
    ? never
    : K]?: OptionValue<NonNullable<T["options"]>[K] & CustomOptionConfig>;
};

export interface CustomParsedResults<
  T extends CustomParseArgsConfig<{
    options?: Record<string, CustomOptionConfig>;
  }>,
> {
  values: OptionsWithDefaults<T> & OptionsWithoutDefaults<T>;
  positionals: string[];
}

export interface Command {
  execute(argv: string[]): Promise<number | void>;
}

export type CommandModule = {
  default: new () => Command;
};

export type PositionalCompletion = "file" | "directory" | "none";

type CommandOptionConfig = CustomOptionConfig & {
  completions?: readonly string[];
};

export interface CommandConstructor {
  new (): Command;
  options: Record<string, CommandOptionConfig>;
  allowPositionals?: boolean;
  positionalCompletion?: PositionalCompletion;
  helpReplacements?: Record<string, string>;
}
export type NumConstraints = {
  min?: number;
  max?: number;
  minExclusive?: number;
  maxExclusive?: number;
  integer?: boolean;
  isFloat?: boolean;
};
export type StrConstraints = { notEmpty?: boolean };
export interface ConfigDef<TClass, TValue> {
  prop: keyof TClass;
  validate: (val: unknown) => asserts val is TValue;
  getValue?: (val: unknown) => TValue;
  storeTransformedValue?: boolean;
  customHandler?: (instance: TClass, val: unknown) => void;
}
export type ConfigMap<TClass, TOptions> = {
  [K in keyof TOptions]?: ConfigDef<TClass, unknown>;
};

export interface FormatAlignedListOptions {
  terminalWidth?: number;
  columnGap?: number;
  firstColumnSeparator?: string;
  forceFirstColumnWidth?: number;
  listIndentWidth?: number;
}

interface BaseHelpSection {
  usage: string;
  flags?: Record<string, string>;
  footer?: string;
}

export interface HelpSection extends BaseHelpSection {
  description: string;
}

export interface GenericHelpSection extends BaseHelpSection {
  header: string;
  commandHeader: string;
  commandDescriptions: Record<string, string>;
  globalOptionsHeader: string;
}

export type AnsiStyle = (text: string) => string;

export interface RunConcurOpts {
  concurrency?: number;
  allSettled?: boolean;
}

export interface CancellableJob {
  cancel: () => void;
}

export type LanguageStrings = EnUsStrings;
