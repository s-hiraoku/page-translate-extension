import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(resolve(root, "dist/manifest.json"), "utf8"));
const outputDirectory = resolve(root, ".output");
const archive = resolve(outputDirectory, `page-translate-v${manifest.version}-chrome.zip`);

mkdirSync(outputDirectory, { recursive: true });
rmSync(archive, { force: true });
execFileSync("zip", ["-qr", archive, "."], { cwd: resolve(root, "dist") });
console.log(`Created ${archive}`);
