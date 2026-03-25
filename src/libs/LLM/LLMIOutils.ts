import type { ReadStream, WriteStream } from "node:fs";

import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";

import {
  createError,
  errlog,
  exitOne,
  isEexistError,
  isEnoentError,
  isTypeError,
  log,
  red,
  runConcur,
  simpleTemplate,
  x,
} from "../core/index.ts";

let glob: typeof import("glob").glob;

const MAX_SIZE_MB = 100;
const MAX_BYTES = MAX_SIZE_MB * (1 << 20);

export async function deleteProgressEntry(hash: string): Promise<string> {
  const { a } = x;
  if (!hash) {
    throw createError(a.s.e.lllm.emptyFile, {
      code: "EMPTY_HASH_PROVIDED",
    });
  }
  const fStatePath = path.join(a.STATE_DIR, `${hash}.json`);

  try {
    await unlink(fStatePath);
    return simpleTemplate(a.s.m.lllm.progressFileDeleted, {
      Hash: hash,
    });
  } catch (err) {
    if (isEnoentError(err)) {
      throw createError(
        simpleTemplate(a.s.e.lllm.progressFileDoesNotExist, {
          Hash: hash,
        }),
        { cause: err },
      );
    }
    throw createError(
      a.s.e.lcli.unknownErrorOccurred +
        a.s.e.lllm.whileCalling_deleteProgressEntry,
      { cause: err },
    );
  }
}

export async function findAllProgressEntries(protectedFiles: string[]) {
  const { a } = x;
  const files = await readdir(a.STATE_DIR);

  const jsonFiles = files
    .filter((file) => path.extname(file) === ".json")
    .map((file) => path.join(a.STATE_DIR, file))
    .filter((file) => !protectedFiles.includes(path.basename(file)));

  const tasks = jsonFiles.map((file, i) => async () => {
    const raw = await readFile(file, "utf-8");
    const data = JSON.parse(raw) as { fileName?: string };
    return `[${i + 1}]${data.fileName ?? ""} ${path.basename(file)}`;
  });

  const formattedFileNamesList = await runConcur(tasks, { concurrency: 64 });

  return [formattedFileNamesList, jsonFiles] as const;
}

export async function validateFiles(sourcePath?: string, targetPath?: string) {
  const { a } = x;

  if (!sourcePath && !targetPath) return;

  if (sourcePath) {
    try {
      // It serves as both the existence check and size check.
      const stats = await stat(sourcePath);

      if (stats.size > MAX_BYTES) {
        throw createError(
          simpleTemplate(a.s.e.lllm.invalidFileSize, {
            MAX_SIZE_MB: MAX_SIZE_MB,
          }),
          { code: "FILE_TOO_LARGE" },
        );
      }
    } catch (err) {
      if (isEnoentError(err)) {
        throw createError(
          simpleTemplate(a.s.e.lllm.fileNotFound, {
            FilePath: sourcePath,
          }),
          { code: "ENOENT", cause: err },
        );
      }
      throw err;
    }
  }

  if (sourcePath && targetPath && sourcePath === targetPath) {
    throw createError(a.s.e.lllm.sourceAndTargetMustBeDifferent, {
      code: "SOURCE_TARGET_SAME",
    });
  }
}

export async function splitFile(
  sourcePath: string,
  targetPath: string,
  size = 1,
): Promise<string[]> {
  const { a } = x;
  await validateFiles(sourcePath);

  const sourceStats = await stat(sourcePath);
  const maxBytes = size * (1 << 20);
  const MEMORY_BUFFER_THRESHOLD = 64 * 1024;

  if (sourceStats.size <= maxBytes) {
    return [sourcePath];
  }

  try {
    await stat(targetPath);
    throw createError(
      red(
        simpleTemplate(a.s.e.lllm.targetFileExists, {
          TargetPath: targetPath,
        }),
      ),
      { code: "TARGET_EXISTS" },
    );
  } catch (err) {
    if (isEnoentError(err)) {
      await mkdir(targetPath, { recursive: true });
    } else {
      throw err;
    }
  }

  const sourceExt = path.extname(sourcePath);
  const sourceBaseName = path.basename(sourcePath, sourceExt);

  const partPaths: string[] = [];
  let partNumber = 0;
  let currentWriter: WriteStream | null = null;
  let currentPartSize = 0;
  let readStream: ReadStream | null = null;

  let writeBuffer: Buffer[] = [];
  let bufferedBytes = 0;

  const flushBuffer = async () => {
    if (writeBuffer.length === 0 || !currentWriter) return;

    const data = Buffer.concat(writeBuffer, bufferedBytes);

    if (!currentWriter.write(data)) {
      await once(currentWriter, "drain");
    }

    writeBuffer = [];
    bufferedBytes = 0;
  };

  const createNewPart = async () => {
    await flushBuffer();

    if (currentWriter) {
      currentWriter.end();
      await finished(currentWriter);
    }

    partNumber++;
    const partPath = path.join(
      targetPath,
      `${sourceBaseName}_part${partNumber}${sourceExt}`,
    );
    partPaths.push(partPath);

    currentWriter = createWriteStream(partPath, { flags: "wx" });

    await new Promise<void>((resolve, reject) => {
      currentWriter!.once("open", () => resolve());
      currentWriter!.once("error", reject);
    });

    currentPartSize = 0;
  };

  try {
    await createNewPart();
    readStream = createReadStream(sourcePath);
    let leftover = Buffer.alloc(0);

    for await (const chunk of readStream) {
      const buf = chunk as Uint8Array as Buffer;
      const work = Buffer.concat([leftover, buf]);

      let start = 0;
      for (let i = 0; i < work.length; i++) {
        if (work[i] === 0x0a) {
          const lineBuf = Buffer.from(work.subarray(start, i + 1));
          const lineSize = lineBuf.length;

          if (currentPartSize > 0 && currentPartSize + lineSize > maxBytes) {
            await createNewPart();
          }

          writeBuffer.push(lineBuf);
          bufferedBytes += lineSize;
          currentPartSize += lineSize;

          if (bufferedBytes >= MEMORY_BUFFER_THRESHOLD) {
            await flushBuffer();
          }

          start = i + 1;
        }
      }

      if (start < work.length) {
        leftover = Buffer.from(work.subarray(start));
      } else {
        leftover = Buffer.alloc(0);
      }
    }

    if (leftover.length > 0) {
      const lineBuf = leftover;
      const lineSize = lineBuf.length;

      if (currentPartSize > 0 && currentPartSize + lineSize > maxBytes) {
        await createNewPart();
      }

      writeBuffer.push(lineBuf);
      bufferedBytes += lineSize;
      currentPartSize += lineSize;
    }

    await flushBuffer();
  } catch (err) {
    if (isTypeError(err)) throw err;
    if (isEexistError(err)) {
      throw createError(
        red(
          simpleTemplate(a.s.e.lllm.targetFileExists, {
            TargetPath: "Part file collision",
          }),
        ),
        { code: "TARGET_EXISTS" },
      );
    }
    throw createError(a.s.e.lcli.unknownErrorOccurred, { cause: err });
  } finally {
    if (readStream) {
      readStream.destroy();
    }
    const finalWriter = currentWriter as WriteStream | null;

    if (finalWriter) {
      try {
        await flushBuffer();
        finalWriter.end();
        await finished(finalWriter);
      } catch {
        finalWriter.destroy();
      }
    }
  }

  return partPaths;
}

export async function mergeFiles(
  sourcePath: string,
  targetPath: string,
  extension: string,
  includePatterns: string[] = [],
  excludePatterns: string[] = [],
): Promise<number> {
  const { a } = x;
  const mergedFileName = `${extension}_merged.txt`;
  const outputPath = path.join(targetPath, mergedFileName);

  if (!glob) {
    glob = (await import("glob")).glob;
  }

  const ext = extension.startsWith(".") ? extension : `.${extension}`;

  const normalizePattern = (p: string) => {
    let posix = p.replace(/\\/g, "/");

    if (posix.startsWith("./")) posix = posix.slice(2);
    if (posix.startsWith("/")) posix = posix.slice(1);

    if (!posix.includes("/")) {
      return `**/${posix}`;
    }

    return posix;
  };

  const normalizedIncludes = [
    ...new Set(includePatterns.map(normalizePattern)),
  ];
  const normalizedExcludes = [
    ...new Set(excludePatterns.map(normalizePattern)),
  ];

  const searchPatterns =
    normalizedIncludes.length > 0 ? normalizedIncludes : [`**/*${ext}`];

  if (a.DEBUG_MODE) {
    log("Glob Search Patterns:", searchPatterns);
    log("Glob Ignore Patterns:", normalizedExcludes);
  }

  const matchedFiles = await glob(searchPatterns, {
    cwd: sourcePath,
    ignore: normalizedExcludes,
    nodir: true,
    absolute: true,
    dot: true,
  });

  const files: { filePath: string; fileSize: number }[] = [];

  for (const filePath of matchedFiles) {
    if (!filePath.endsWith(ext)) continue;
    const stats = await stat(filePath);
    files.push({ filePath, fileSize: stats.size });
  }

  if (files.length === 0) {
    errlog(
      red(
        simpleTemplate(a.s.e.lllm.noFilesFound, {
          Extension: extension,
        }),
      ),
    );
    exitOne();
    return 1;
  }

  files.sort((a, b) =>
    a.filePath.localeCompare(b.filePath, undefined, { numeric: true }),
  );

  const totalSizeBytes = files.reduce((sum, file) => sum + file.fileSize, 0);
  if (totalSizeBytes > MAX_BYTES) {
    errlog(
      red(
        simpleTemplate(a.s.e.lllm.invalidFileSize, {
          MAX_SIZE_MB: MAX_SIZE_MB,
        }),
      ),
    );
    exitOne();
    return 1;
  }

  async function* generateMergedData() {
    for (const { filePath } of files) {
      const fileHeaderStr = `--- File: ${path.basename(filePath)} ---\n`;

      yield Buffer.from(fileHeaderStr, "utf8");

      const readStream = createReadStream(filePath);
      for await (const chunk of readStream) {
        yield chunk;
      }
    }
  }

  try {
    const writer = createWriteStream(outputPath, { flags: "wx" });

    await pipeline(generateMergedData(), writer);

    log(
      simpleTemplate(a.s.m.lllm.filesMerged, {
        MergedFileName: mergedFileName,
      }),
    );
  } catch (err) {
    if (isEexistError(err)) {
      throw createError(
        red(
          simpleTemplate(a.s.e.lllm.targetFileExists, {
            TargetPath: outputPath,
          }),
        ),
        { code: "TARGET_EXISTS" },
      );
    }

    await unlink(outputPath).catch(() => {});

    if (isTypeError(err)) {
      throw err;
    }
    throw createError(a.s.e.lcli.unknownErrorOccurred, { cause: err });
  }

  return 0;
}

export async function buildImageContent(
  imageArg: string | undefined | null,
): Promise<string[]> {
  const { a } = x;
  if (!imageArg) {
    return [];
  }

  if (!glob) {
    glob = (await import("glob")).glob;
  }

  const imageURIs: string[] = [];
  const patterns = imageArg.split(/:(?![\\/])/).map((p) => p.trim());

  for (const pattern of patterns) {
    const matches = await glob(pattern, { nodir: true });

    for (const p of matches) {
      const ext = path.extname(p).toLowerCase();
      let mime: string | undefined;

      switch (ext) {
        case ".png":
          mime = "image/png";
          break;
        case ".jpg":
        case ".jpeg":
          mime = "image/jpeg";
          break;
        case ".gif":
          mime = "image/gif";
          break;
        case ".webp":
          mime = "image/webp";
          break;
        default:
          log(
            red(
              simpleTemplate(a.s.e.v.unsupportedImageType2, {
                Ext: ext,
                Image: p,
              }),
            ),
          );
          continue;
      }

      try {
        const stats = await stat(p);
        if (stats.size > MAX_BYTES) {
          throw createError(
            simpleTemplate(a.s.e.lllm.invalidFileSize, {
              MAX_SIZE_MB: MAX_SIZE_MB,
            }),
            { code: "FILE_TOO_LARGE" },
          );
        }

        const buffer = await readFile(p);
        imageURIs.push(`data:${mime};base64,${buffer.toString("base64")}`);
      } catch (err) {
        if (isEnoentError(err)) {
          log(red(simpleTemplate(a.s.e.v.imageNotFound, { Image: p })));
        } else {
          throw err;
        }
        continue;
      }
    }
  }

  if (patterns.length > 0 && imageURIs.length === 0) {
    log(red(simpleTemplate(a.s.e.v.unsupportedImageType, { Args: imageArg })));
  }

  return [...new Set(imageURIs)];
}
