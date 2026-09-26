import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Page Translate",
  version: "0.1.0",
  description: "Translate English and Japanese web pages with Jev and DeepL, with translations linked to their source.",
  minimum_chrome_version: "114",
  permissions: ["sidePanel", "storage"],
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  host_permissions: [
    "https://api.typesafe.ai/*",
    "https://api-free.deepl.com/*",
    "https://api.deepl.com/*",
  ],
  background: { service_worker: "src/background/service-worker.ts", type: "module" },
  action: {
    default_title: "Open Page Translate",
    default_icon: {
      16: "icons/icon16.png",
      32: "icons/icon32.png",
      48: "icons/icon48.png",
    },
  },
  side_panel: { default_path: "src/sidepanel/index.html" },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
});
