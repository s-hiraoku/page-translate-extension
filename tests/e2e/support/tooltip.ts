import type { Page } from "@playwright/test";

interface CdpNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

/**
 * Text inside the selection tooltip, or null when none is shown. The tooltip lives in a closed
 * shadow root that page scripts (and Playwright locators) cannot see, so this reads it through
 * the DevTools protocol, which does expose closed roots.
 */
export async function tooltipText(page: Page): Promise<string | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }) as { root: CdpNode };
    const host = findHost(root);
    if (!host) return null;
    const parts: string[] = [];
    for (const shadowRoot of host.shadowRoots ?? []) collectText(shadowRoot, parts);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

function findHost(node: CdpNode): CdpNode | null {
  const attributes = node.attributes ?? [];
  if (attributes.includes("data-page-translate-tooltip")) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findHost(child);
    if (found) return found;
  }
  return null;
}

function collectText(node: CdpNode, out: string[]): void {
  if (node.nodeName === "STYLE") return;
  if (node.nodeType === 3 && node.nodeValue) out.push(node.nodeValue);
  for (const child of node.children ?? []) collectText(child, out);
}

/** Position of the tooltip in the viewport, or null when none is shown. */
export function tooltipBox(page: Page) {
  return page.locator("[data-page-translate-tooltip]").boundingBox();
}
