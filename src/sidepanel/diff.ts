export interface DiffPart {
  kind: "same" | "removed" | "added";
  text: string;
}

/** Words, punctuation and whitespace, so a diff never splits inside a word. */
function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}'’-]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

/**
 * Word-level diff from `before` (the reader's English) to `after` (a suggestion),
 * based on the longest common subsequence of tokens. Whitespace-only changes are
 * reported as unchanged so that line wrapping does not show up as edits.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const same = (x: string, y: string) => x === y || (/^\s+$/.test(x) && /^\s+$/.test(y));
  // Keep the table small (a few MB); very long texts are shown as a whole replacement.
  if (a.length * b.length > 4_000_000) {
    return [{ kind: "removed", text: before }, { kind: "added", text: after }];
  }

  // lengths[i][j] = LCS length of a[i..] and b[j..]
  const lengths: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = same(a[i], b[j]) ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i], b[j])) {
      push("same", b[j]);
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      push("removed", a[i]);
      i += 1;
    } else {
      push("added", b[j]);
      j += 1;
    }
  }
  while (i < a.length) push("removed", a[i++]);
  while (j < b.length) push("added", b[j++]);
  return parts;
}

/** Whether the suggestion differs from the reader's English in anything but spacing. */
export function hasChanges(parts: DiffPart[]): boolean {
  return parts.some((part) => part.kind !== "same" && part.text.trim() !== "");
}
