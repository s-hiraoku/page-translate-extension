import { placeTooltip, type Box } from "./tooltip-layout";

export type TooltipState =
  | { kind: "loading" }
  /** `by` names who translated (DeepL unless said). */
  | { kind: "done"; text: string; by?: string }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string };

export interface SelectionTooltip {
  /** The element in the page; used to tell clicks inside the tooltip from clicks outside. */
  host: HTMLElement;
  update(state: TooltipState): void;
  /** Follows the selection after the page scrolled or resized. */
  reposition(): void;
  destroy(): void;
}

const STYLE = `
:host { all: initial; }
.tip {
  position: relative; box-sizing: border-box; min-width: 132px; max-width: min(360px, calc(100vw - 16px));
  padding: 10px 12px 7px; background: #ffffff; color: #141b2d; border: 1px solid #d3d8e1; border-radius: 10px;
  box-shadow: 0 10px 30px rgb(16 24 40 / .22), 0 1px 3px rgb(16 24 40 / .14);
  font: 13.5px/1.7 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif;
  text-align: left; letter-spacing: normal; text-transform: none;
}
.arrow { position: absolute; left: var(--arrow-left, 24px); width: 10px; height: 10px; margin-left: -5px; background: #ffffff; border: 1px solid #d3d8e1; transform: rotate(45deg); }
.tip[data-placement="below"] .arrow { top: -6px; border-right: 0; border-bottom: 0; }
.tip[data-placement="above"] .arrow { bottom: -6px; border-left: 0; border-top: 0; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; }
.body.note { color: #6c7689; }
.body.error { color: #a2382c; }
.loading { display: flex; align-items: center; gap: 8px; color: #6c7689; }
.spinner { width: 13px; height: 13px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
.foot { display: flex; align-items: center; gap: 2px; margin-top: 5px; }
.brand { margin-right: auto; color: #8891a4; font: 600 10px/1 system-ui, sans-serif; letter-spacing: .08em; }
button { appearance: none; border: 0; background: transparent; color: #2450d0; font: 600 12px/1 system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif; padding: 6px 7px; border-radius: 6px; cursor: pointer; }
button:hover { background: #e9efff; }
button:focus-visible { outline: 2px solid #2c5cf0; outline-offset: 1px; }
button.close { color: #6c7689; font-size: 15px; line-height: 1; padding: 4px 8px; }
button.close:hover { background: #eceef3; }
@media (prefers-color-scheme: dark) {
  .tip { background: #1b2133; color: #e8ebf3; border-color: #323a50; box-shadow: 0 10px 30px rgb(0 0 0 / .55); }
  .arrow { background: #1b2133; border-color: #323a50; }
  .body.note, .loading { color: #8e97ab; }
  .body.error { color: #ff9d90; }
  button { color: #93adff; }
  button:hover { background: #1d2a55; }
  button.close { color: #8e97ab; }
  button.close:hover { background: #262d41; }
}
@media (prefers-reduced-motion: no-preference) {
  .tip { animation: pop .14s ease-out; }
}
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pop { from { opacity: 0; transform: translateY(3px) scale(.98); } to { opacity: 1; transform: none; } }
`;

/**
 * The tooltip that shows a translation next to the selected text. It lives in a closed shadow
 * root so the page's styles cannot reach it, and it is marked as extension UI so page scans and
 * page select mode leave it alone. `anchor` returns the selection's box in viewport coordinates.
 */
export function createSelectionTooltip(anchor: () => Box | null, onClose: () => void): SelectionTooltip {
  const host = document.createElement("div");
  host.dataset.pageTranslateUi = "true";
  host.dataset.pageTranslateTooltip = "true";
  Object.assign(host.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "auto" });
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;

  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "status");
  tip.setAttribute("aria-live", "polite");
  const arrow = document.createElement("div");
  arrow.className = "arrow";
  const body = document.createElement("div");
  const foot = document.createElement("div");
  foot.className = "foot";
  const brand = document.createElement("span");
  brand.className = "brand";
  brand.textContent = "DeepL";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "コピー";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.textContent = "×";
  close.setAttribute("aria-label", "閉じる");
  foot.append(brand, copy, close);
  tip.append(arrow, body, foot);
  shadow.append(style, tip);
  document.documentElement.append(host);

  let current: TooltipState = { kind: "loading" };
  let copyTimer = 0;

  close.addEventListener("click", (event) => {
    event.stopPropagation();
    onClose();
  });
  copy.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (current.kind !== "done") return;
    window.clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(current.text);
      copy.textContent = "コピーしました";
    } catch {
      copy.textContent = "コピーできません";
    }
    copyTimer = window.setTimeout(() => { copy.textContent = "コピー"; }, 1500);
  });

  function reposition(): void {
    const box = anchor();
    if (!box) return;
    const size = tip.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
    const placed = placeTooltip(box, { width: size.width, height: size.height }, viewport);
    host.style.left = `${Math.round(placed.left)}px`;
    host.style.top = `${Math.round(placed.top)}px`;
    tip.dataset.placement = placed.placement;
    tip.style.setProperty("--arrow-left", `${Math.round(placed.arrowLeft)}px`);
  }

  function update(state: TooltipState): void {
    current = state;
    body.replaceChildren();
    body.className = "body";
    if (state.kind === "loading") {
      body.className = "loading";
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-hidden", "true");
      body.append(spinner, "翻訳しています…");
    } else {
      if (state.kind !== "done") body.classList.add(state.kind);
      body.textContent = state.text;
      if (state.kind === "done") brand.textContent = state.by ?? "DeepL";
    }
    copy.hidden = state.kind !== "done";
    reposition();
  }

  update(current);
  return {
    host,
    update,
    reposition,
    destroy: () => {
      window.clearTimeout(copyTimer);
      host.remove();
    },
  };
}
