# Chrome Web Store Privacy Practices — proposed dashboard answers

Use these answers only after comparing them with the exact Privacy practices questions in the Developer Dashboard.

## Single purpose

Translate between English and Japanese: text from the page the user chooses (TypeSafe Jev optionally selects candidate text, DeepL translates it; results are shown beside their source or on the page), and English the user writes, which is translated back into Japanese and compared with DeepL's translation and DeepL Write correction so the user can check it.

## Data handled

- Website content: page title, extracted text candidates, and text-location labels. Sent to TypeSafe Jev for classification; only selected text is sent to DeepL.
- User-entered text (writing check): English and optional Japanese text the user types in the side panel, and, if the user keeps "use the open page as context" on, the page title and main text. Sent directly to DeepL (translate, and DeepL Write with API Pro keys). Not stored. Check which Dashboard category fits (likely "Personal communications" or "Website content") before submitting.
- Authentication information: user-provided TypeSafe Jev and DeepL API keys. Held in Chrome session storage and sent to the respective provider only for authentication.
- Web browsing activity: the active page URL is read to show its hostname in the panel. The URL is not included in the provider request bodies.
- User settings and consent: target language, display mode, DeepL server choice (auto-detected from the key by default), whether Jev is used, writing check options (English variant, DeepL Write style, page context), and the version of the user's affirmative consent. The consent version was raised to 2 when the writing check was added, so existing users are asked again before any text is sent. Stored locally in the Chrome profile.

## Use and sharing

All handled data is used only to provide the user-facing translation feature. Page text, page title, location labels, target language, and authentication requests are sent directly from the extension to TypeSafe Jev and DeepL over HTTPS. The extension developer operates no relay service and receives no page content, credentials, results, URLs, analytics, or telemetry. No advertising, sale, profiling, or unrelated use.

## Storage and retention

- API keys: Chrome `storage.session` (in-memory for the extension's current session); cleared on browser restart, extension disable, reload, or update. The user can clear them in Settings.
- Settings and consent state: Chrome `storage.local`, not Chrome Sync.
- Page text, writing check input and translated text: held in panel/page memory only; not persisted by the extension.

## Privacy policy and limited use certification

Privacy policy URL (after deployment and HTTP 200 verification): https://s-hiraoku.github.io/page-translate-extension/privacy.html

Suggested Limited Use statement:

> Page Translate uses page text, page titles, location labels, the active page URL, user-provided provider API keys, and extension settings only to provide its page-translation feature. Candidate text is sent directly to TypeSafe Jev for classification; only selected text is sent directly to DeepL for translation. The extension developer does not receive or store this data and does not use it for advertising, sale, profiling, or any unrelated purpose. API keys remain in Chrome session memory and are cleared when the Chrome session or extension session ends. The extension does not collect analytics or telemetry.

## Reviewer notes

- The extension asks for all-page access because its content script identifies page text blocks on ordinary web pages. The actual scan is initiated only by the user's translation action, after in-extension disclosure and affirmative consent.
- The required host permissions are limited to TypeSafe Jev and DeepL endpoints.
- There is no remote code, developer-controlled API, analytics SDK, advertising SDK, or account login.
- Do not mark the product as collecting no user data: it handles website content and authentication information, even though the developer does not receive the provider requests.
