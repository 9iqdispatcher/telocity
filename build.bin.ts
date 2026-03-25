import type { CompileBuildOptions } from "bun";

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";

import packageJson from "./package.json" with { type: "json" };

const { name: title, version, description, author: copyright } = packageJson;
const publisher = copyright;

const targets = [
  { target: "bun-windows-x64", os: "windows-x64" },
  { target: "bun-linux-x64", os: "linux-x64" },
  { target: "bun-darwin-arm64", os: "macos-arm64" },
] as const;

const outDir = path.resolve("./dist");

const shouldCompress = process.argv.includes("--compress");
const allPlatforms = process.argv.includes("--all");

for (const buildTarget of targets) {
  const { target, os } = buildTarget;
  if (!allPlatforms) {
    if (os !== "windows-x64") {
      continue;
    }
  }
  console.log(`\n=== Building for ${target} (output folder: ${os}) ===`);

  const osOutDir = path.join(outDir, os);

  fs.mkdirSync(osOutDir, { recursive: true });

  const exeFileName = target.startsWith("bun-windows") ? `${title}.exe` : title;

  const compileOptions: CompileBuildOptions = {
    target,
    outfile: `${os}/${exeFileName}`,
  };

  if (target.startsWith("bun-windows")) {
    compileOptions.windows = {
      title,
      publisher,
      version,
      description,
      copyright,
      hideConsole: false,
      icon: "./icon.ico",
    };
  }

  console.log("Compiling...");
  await Bun.build({
    entrypoints: [
      "./bin/start.ts",
      "./src/libs/vendoring/worker/tokenworker.js",
    ],
    outdir: "./dist",
    target: "bun",
    format: "esm",
    minify: true,
    bytecode: true,
    compile: compileOptions,
  });

  const generatedExePath = path.join(osOutDir, exeFileName);
  if (!fs.existsSync(generatedExePath)) {
    console.warn(
      `Warning: expected output file not found: ${generatedExePath}`,
    );
  } else {
    console.log(`Built: ${generatedExePath}`);
  }

  if (shouldCompress) {
    if (!fs.existsSync(generatedExePath)) {
      console.warn(
        `Skipping compression for ${os} because the expected binary wasn't found.`,
      );
      continue;
    }

    const zipName = `${title}-${version}-${os}`;
    const zipPath = path.join(outDir, zipName);

    console.log(
      `Compressing ${generatedExePath} -> ${zipPath} using 7z.exe (max compression)...`,
    );
    try {
      const result =
        await $`7z a -t7z -m0=lzma2 -mx=9 -mfb=273 -md=256m -ms=on ${zipPath}.7z ${generatedExePath}`;
      if (result && result.exitCode === 0) {
        console.log(`Created archive: ${zipPath}.7z`);
      } else {
        console.error("7z returned a non-zero exit code.", result);
        throw new Error("Compression failed");
      }
    } catch (err) {
      console.error(
        "Compression step failed. Make sure 7z is installed and on PATH.",
        err,
      );
      throw err;
    }
  } else {
    console.log("Skipping compression for this target (compression disabled).");
  }
}

console.log("\nAll builds completed successfully!");
