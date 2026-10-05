# Body-text selection: metrics

Each case is one saved page. The extension's scanner turns it into candidates; every candidate carries a label in `eval/selection/cases/<id>/labels.json`: `content` (a reader wants it translated), `chrome` (it should be hidden) or `either` (not scored). Text already in Japanese is dropped before judging, as in the extension, and is not scored.

A candidate counts as **shown** when the side panel would show it: the judge said translate or review, or said skip on main prose (`isMainProse` override).

- **Recall**: content shown / content. The main metric: missed body text is the complaint.
- **Specificity**: chrome hidden / chrome (1 when a page has no chrome candidates).
- **Precision**: content among shown, labeled candidates.
- **Missed** / **Chrome shown**: the counts behind recall and specificity. Pooled counts across pages are the number to compare; per-page means weight a 5-candidate page like a 50-candidate one.

Not measured here: text the scanner never extracts (that is the content script's job, before any judge).
