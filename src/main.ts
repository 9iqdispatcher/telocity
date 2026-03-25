import type { AppState } from "./libs/types/index.ts";

import { getCommand } from "./cmap.ts";
import {
  AppStateSingleton,
  configInit,
  errlog,
  exitOne,
  isNodeError,
  log,
  red,
  simpleTemplate,
} from "./libs/core/index.ts";

export async function applyCommand(
  commandAlias: string,
  argv: string[],
): Promise<void> {
  const appState = AppStateSingleton.getInstance();
  if (commandAlias === "_default") commandAlias = "help";

  const CommandClass = await getCommand(commandAlias);
  if (!CommandClass) {
    exitOne();
    errlog(
      red(
        simpleTemplate(appState.s.e.lcli.commandNotImplemented, {
          CommandAlias: commandAlias,
        }),
      ),
    );
    return;
  }

  const commandInstance = new CommandClass();
  await commandInstance.execute(argv);
}

export async function main(
  argv?: string[],
  isInteractive: boolean = true,
): Promise<number> {
  let deb = false;
  let cmdAlias: string | undefined;
  let showVersion = false;

  try {
    const appState = await configInit(isInteractive);
    const args = argv ?? process.argv.slice(2);

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === "--debug") {
        deb = true;
        continue;
      }
      if (arg === "--version") {
        showVersion = true;
        continue;
      }

      if (cmdAlias === undefined && arg!.charCodeAt(0) !== 45) {
        cmdAlias = arg;
        break;
      }
    }

    if (showVersion) {
      log(red(`${appState.P_NAME}: ${appState.P_VERSION}`));
      return 0;
    }
    if (deb) {
      appState.setDebug();
    }
    cmdAlias ??= "_default";

    await applyCommand(cmdAlias, args);
    return 0;
  } catch (err) {
    exitOne();

    let safeAppState: AppState | undefined;
    try {
      safeAppState = AppStateSingleton.getInstance();
    } catch {
      // Ignored: if init failed, we have no strings
    }

    if (isNodeError(err)) {
      errlog(red(err.message));
      if (isNodeError(err.cause)) {
        const causePrefix = safeAppState?.s?.e?.lcli?.causePrefix ?? "> Cause:";
        errlog(
          red(
            `${causePrefix} ${err.cause.message ?? JSON.stringify(err.cause)}`,
          ),
        );
      }
      if (deb && err.stack) {
        errlog(err.stack);
      }
    } else {
      errlog(red(String(err)));
    }
    return 1;
  }
}
