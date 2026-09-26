# Chrome Web Store submission checklist

## Prepared in the repository

- [x] Manifest V3 metadata and minimum Chrome version
- [x] Extension icons at 16, 32, 48, and 128 pixels
- [x] Japanese and English listing copy
- [x] Japanese and English 440×280 promo tiles
- [x] Japanese and English privacy policy source
- [x] Privacy-practices dashboard draft
- [x] API keys restricted to in-memory Chrome session storage
- [x] First-use disclosure and affirmative consent before page scanning
- [x] Reproducible ZIP packaging command (`npm run zip`)

## Still required before submission

- [ ] Capture at least one authentic 1280×800 or larger screenshot from the running extension for each listing language; do not use an illustrative mockup as a product screenshot.
- [ ] Build the package and confirm the ZIP root contains `manifest.json`, all four icons, the side panel, content script, and service worker.
- [ ] Test a fresh install, first-use consent, API-key entry/removal, TypeSafe classification, DeepL translation, both display modes, and restore behavior. Current provider verification is blocked by exhausted TypeSafe credits; DeepL has not yet been verified in the released build.
- [ ] Publish `docs/privacy.html` at the privacy URL in both listing drafts and confirm the exact URL returns HTTP 200.
- [ ] Reconcile the privacy-practices Dashboard answers with this policy and the shipped behavior.
- [ ] In the Developer Dashboard, complete product details, languages, category, support URL, privacy URL, data disclosures, Limited Use certification, and distribution/visibility settings.
- [ ] Upload the exact `.output/page-translate-v<version>-chrome.zip` package and inspect the selected version before submitting for review.

## Publisher-owned steps

The Chrome Web Store Developer Dashboard submission requires the publisher's developer account. This repository preparation does not create or submit a Dashboard item.
