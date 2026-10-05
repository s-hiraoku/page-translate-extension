#!/usr/bin/env bun
// Checks the grader before any paid run: the labels themselves (oracle) must score 1.0 on
// every page, and skipping everything must miss content wherever the main-prose override
// does not apply. Also prints the free "local rules only" score for comparison.
//
//   bun eval/selection/check.mjs
import { gradeCase, loadCases, runCase } from './selection.mjs';

const cases = await loadCases();
let failed = false;
const pooled = {};
for (const judge of ['oracle', 'skip-all', 'none']) {
  const totals = { tp: 0, fn: 0, tn: 0, fp: 0 };
  for (const c of cases) {
    const { grade } = await gradeCase(c, await runCase(c, { judge }));
    if (judge === 'oracle' && (grade.recall !== 1 || grade.specificity !== 1)) {
      console.error(`FAIL oracle on ${c.id}: ${JSON.stringify(grade)}`);
      failed = true;
    }
    const content = c.segments.filter((s) => c.labels.get(s.sourceText) === 'content').length;
    const chrome = c.segments.filter((s) => c.labels.get(s.sourceText) === 'chrome').length;
    totals.tp += content - grade.content_missed; totals.fn += grade.content_missed;
    totals.fp += grade.chrome_shown; totals.tn += chrome - grade.chrome_shown;
  }
  pooled[judge] = totals;
  const recall = totals.tp / (totals.tp + totals.fn), specificity = totals.tn / (totals.tn + totals.fp);
  console.log(`${judge.padEnd(8)} pooled recall ${recall.toFixed(3)} (${totals.fn} content missed), specificity ${specificity.toFixed(3)} (${totals.fp} chrome shown) over ${cases.length} pages`);
}
if (pooled['skip-all'].fn === 0) {
  console.error('FAIL skip-all missed no content: the grader cannot see a missed paragraph');
  failed = true;
}
process.exit(failed ? 1 : 0);
