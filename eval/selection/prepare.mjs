#!/usr/bin/env node
// Prepares the cases of the body-text selection eval (see README.md).
//
//   node eval/selection/prepare.mjs snapshot <id> <url>   save a page as cases/<id>/page.html
//   node eval/selection/prepare.mjs scan [--rescan]       scan every case with the built extension
//   node eval/selection/prepare.mjs review                write labels.md, every case's candidates and labels for review
//
// `scan` loads dist/ (run `npm run build` first) into Chromium, opens each cases/<id>/page.html
// and asks the content script for SCAN_PAGE, exactly as the side panel does. The scan is written
// to cases/<id>/candidates.json; a labels.json with every candidate's text and an empty label is
// created next to it when missing, and new candidates are added to an existing one.
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const casesDir = join(here, "cases");
const root = resolve(here, "../..");
const extensionPath = join(root, "dist");
const extensionId = [...createHash("sha256").update(extensionPath).digest("hex").slice(0, 32)]
  .map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");

const [command, ...rest] = process.argv.slice(2);
if (command === "snapshot") await snapshot(rest[0], rest[1]);
else if (command === "scan") await scan(rest.includes("--rescan"));
else if (command === "review") review();
else {
  console.error("usage: prepare.mjs snapshot <id> <url> | scan [--rescan] | review");
  process.exit(2);
}

/** Saves the rendered page with its stylesheets inlined and its scripts removed, so later scans see the same page. */
async function snapshot(id, url) {
  if (!id || !/^[a-z0-9-]+$/.test(id) || !url) throw new Error("snapshot needs an id (a-z, 0-9, -) and a URL");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  const sheets = await page.evaluate(() => [...document.querySelectorAll('link[rel~="stylesheet"]')].map((link) => link.href));
  const css = {};
  for (const href of sheets) {
    const response = await page.request.get(href).catch(() => null);
    if (response?.ok()) css[href] = await response.text();
  }
  const html = await page.evaluate((css) => {
    for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
      const style = document.createElement("style");
      style.textContent = css[link.href] ?? "";
      link.replaceWith(style);
    }
    for (const node of document.querySelectorAll("script, noscript, iframe")) node.remove();
    return "<!doctype html>\n" + document.documentElement.outerHTML;
  }, css);
  await browser.close();
  const dir = join(casesDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "page.html"), html);
  const casePath = join(dir, "case.json");
  if (!existsSync(casePath)) writeFileSync(casePath, JSON.stringify({ url, saved: new Date().toISOString().slice(0, 10), source: "", note: "" }, null, 2) + "\n");
  console.log(`saved ${id} (${Math.round(html.length / 1024)} KB)`);
}

async function scan(rescan) {
  if (!existsSync(join(extensionPath, "manifest.json"))) throw new Error("dist/ is missing: run `npm run build` first");
  const ids = readdirSync(casesDir).filter((id) => existsSync(join(casesDir, id, "page.html")))
    .filter((id) => rescan || !existsSync(join(casesDir, id, "candidates.json")));
  if (ids.length === 0) {
    console.log("nothing to scan");
    return;
  }
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
    const file = join(casesDir, path);
    if (!file.startsWith(casesDir) || !existsSync(file)) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const driver = await context.newPage();
  // The extension may not read tab URLs: keep the driver and one page tab open, nothing else.
  for (const other of context.pages()) if (other !== driver) await other.close();
  await driver.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  try {
    for (const id of ids) {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/${id}/page.html`, { waitUntil: "load" });
      const result = await driver.evaluate(async () => {
        const own = (await chrome.tabs.getCurrent())?.id;
        const tabs = (await chrome.tabs.query({})).filter((candidate) => candidate.id !== own);
        if (tabs.length !== 1) throw new Error(`expected one page tab, found ${tabs.length}`);
        const [tab] = tabs;
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE" });
          } catch (error) {
            if (attempt >= 100 || !String(error).includes("Receiving end does not exist")) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      });
      await page.close();
      const dir = join(casesDir, id);
      const caseInfo = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
      writeFileSync(join(dir, "candidates.json"), JSON.stringify({ ...result, url: caseInfo.url }, null, 2) + "\n");
      mergeLabels(dir, result.segments);
      console.log(`scanned ${id}: ${result.segments.length} candidates (main content ${result.mainContentDetected ? "found" : "not found"})`);
    }
  } finally {
    await context.close();
    server.close();
  }
}

/** labels.json: one entry per candidate text, label "content" | "chrome" | "either" | "" (not labeled yet). */
function mergeLabels(dir, segments) {
  const path = join(dir, "labels.json");
  const labels = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const known = new Set(labels.map((entry) => entry.text));
  for (const segment of segments) {
    if (known.has(segment.sourceText)) continue;
    labels.push({ text: segment.sourceText, label: "" });
    known.add(segment.sourceText);
  }
  writeFileSync(path, JSON.stringify(labels, null, 2) + "\n");
}

/** One table per case: where the scanner put each candidate and the label it has, for a person to check. */
function review() {
  const lines = ["# Labels for review", "", "content: should be translated · chrome: should be hidden · either: not scored · (blank): not labeled yet", ""];
  for (const id of readdirSync(casesDir).sort()) {
    const dir = join(casesDir, id);
    if (!existsSync(join(dir, "candidates.json"))) continue;
    const info = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
    const scan = JSON.parse(readFileSync(join(dir, "candidates.json"), "utf8"));
    const labels = new Map(JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")).map((entry) => [entry.text, entry.label]));
    lines.push(`## ${id}`, "", `${info.url}${info.note ? ` · ${info.note}` : ""}`, "", "| # | label | region · kind · links | text |", "|---|---|---|---|");
    scan.segments.forEach((segment, index) => {
      const text = segment.sourceText.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 160);
      lines.push(`| ${index + 1} | ${labels.get(segment.sourceText) || " "} | ${segment.region} · ${segment.kind} · ${Math.round(segment.linkDensity * 100)}% | ${text} |`);
    });
    lines.push("");
  }
  writeFileSync(join(here, "labels.md"), lines.join("\n"));
  console.log("wrote eval/selection/labels.md");
}
