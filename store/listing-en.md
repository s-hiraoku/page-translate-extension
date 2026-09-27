# Chrome Web Store Listing (English)

## Product details

- Name: Page Translate
- Short description: Translate English and Japanese pages with Jev and DeepL. Review each result beside its original location.
- Category: Productivity
- Language: English
- Support URL: https://github.com/s-hiraoku/page-translate-extension/issues
- Homepage: https://github.com/s-hiraoku/page-translate-extension
- Privacy policy: https://s-hiraoku.github.io/page-translate-extension/privacy.html (publish and verify HTTP 200 before adding it)

## Detailed description

Translate English and Japanese text without leaving the page you are reading.

Page Translate extracts candidate text from the current page. TypeSafe Jev selects what should be translated, and DeepL translates the selected text. Results appear in the Chrome side panel with their original page locations.

### Features

- Translate page text from English to Japanese or Japanese to English
- Keep the original page text and review translations beside their source locations
- Jump from a result to its source and see a temporary connector
- Show translations directly on the page and restore the original text
- Let TypeSafe Jev classify candidate text before translation
- Writing check: see what your own English conveys, compare it with DeepL's translation of what you meant, and get DeepL Write corrections (paid-plan keys)
- DeepL server detected from your key (free or paid plan can also be chosen manually)
- Keyboard shortcuts: Alt+Shift+Y translates the page, Alt+Shift+K toggles page-click mode (Control+Shift on Mac; customizable)

### API keys

Provide your own TypeSafe Jev and DeepL API keys. Provider quotas and charges depend on your provider accounts. Keys are held only in memory for the current Chrome session and are cleared when Chrome restarts or the extension is reloaded or updated. Page Translate includes no shared API keys or relay server.

### Data handling

When you start a translation, candidate page text and the page title are sent to TypeSafe Jev. Only text selected by Jev is sent to DeepL. API keys are sent directly to each provider for authentication. The recipients are TypeSafe Jev and DeepL; the Page Translate developer does not receive or store page text, API keys, or translations. Before processing begins, the extension explains what is sent and where, and waits for your consent.

Check the terms of TypeSafe Jev and your chosen DeepL API plan before sending text containing personal or confidential information.

### Permissions

- Access to all websites: used to extract text from the page you choose to translate and apply the display mode you select.
- `sidePanel`: displays translations and settings in the Chrome side panel.
- `storage`: saves display settings and data-use consent, and holds API keys only for the Chrome session.
- Connections to TypeSafe Jev and DeepL: used to classify candidate text and translate selected text.

See the support page and privacy policy for more information.

## Images

- Icon: `public/icons/icon128.png`
- English promo tile: `store/images/store-tile.en.png` (440×280)
- Screenshots: `store/images/screenshot-en-*.png` (at least 1280×800; final screenshots must be captured from the running extension)
- Optional marquee image: not created
- Promo video: none
