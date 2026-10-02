import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Page Translate",
  version: "1.6.6",
  description: "Translate English and Japanese web pages with Jev and DeepL, with translations linked to their source.",
  minimum_chrome_version: "116",
  permissions: ["contextMenus", "sidePanel", "storage"],
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
  // Mac uses Control (not Command or Option): Chrome and macOS leave Control+Shift+letter free,
  // and Option+letter types characters. Chrome keeps Alt+Shift+A/B/C/P/T/W/X/Z for itself (a
  // suggested key there is never assigned), hence Y for 訳, K for クリック and S for 選択.
  commands: {
    "translate-page": {
      suggested_key: { default: "Alt+Shift+Y", mac: "MacCtrl+Shift+Y" },
      description: "このページを翻訳",
    },
    "toggle-page-pick": {
      suggested_key: { default: "Alt+Shift+K", mac: "MacCtrl+Shift+K" },
      description: "ページクリックのオン・オフ",
    },
    // S for 選択 (selection): translates the text selected on the page right now, in a tooltip.
    "translate-selection": {
      suggested_key: { default: "Alt+Shift+S", mac: "MacCtrl+Shift+S" },
      description: "選択した文章を翻訳",
    },
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
});
