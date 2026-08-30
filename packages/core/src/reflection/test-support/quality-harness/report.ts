import type { CallMetrics, FixtureAgreement, FixtureRouteMetrics } from './scorer.js';
import type { ExtractionRoute } from './types.js';

export type FixtureReport = {
  readonly id: string;
  readonly title: string;
  readonly charCount: number;
  readonly routes: readonly FixtureRouteMetrics[];
  readonly agreement: FixtureAgreement;
};

export type SkippedRoute = {
  readonly route: ExtractionRoute;
  readonly reason: string;
};

export type QualityReport = {
  readonly generatedAt: string;
  readonly routesRun: readonly ExtractionRoute[];
  readonly routesSkipped: readonly SkippedRoute[];
  readonly fixtures: readonly FixtureReport[];
};

function byTypeLines(byType: Readonly<Record<string, number>>): string[] {
  const types = Object.keys(byType).sort();
  if (types.length === 0) {
    return ['  (none)'];
  }
  return types.map((type) => `  - ${type}: ${byType[type]}`);
}

function callCell(metrics: CallMetrics): string {
  return metrics.ok ? String(metrics.count) : `error: ${metrics.error ?? 'unknown'}`;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function renderFixture(fixture: FixtureReport): string[] {
  const lines: string[] = [];
  lines.push(`## ${fixture.title} (\`${fixture.id}\`)`, '');
  lines.push(`Episode length: ${fixture.charCount} chars`, '');
  lines.push(
    '| Route | Model | Entities | Cognitive nodes | Entity latency (ms) | Cognitive latency (ms) |',
  );
  lines.push('|---|---|---|---|---|---|');
  for (const route of fixture.routes) {
    lines.push(
      `| ${route.route} | ${route.model} | ${callCell(route.entities)} | ${callCell(route.cognitive)} | ${route.entities.latencyMs} | ${route.cognitive.latencyMs} |`,
    );
  }
  lines.push('');

  if (fixture.agreement.entityNameOverlap !== undefined) {
    lines.push(`Entity name agreement: ${percent(fixture.agreement.entityNameOverlap)}`);
  }
  if (fixture.agreement.cognitiveNameOverlap !== undefined) {
    lines.push(`Cognitive node name agreement: ${percent(fixture.agreement.cognitiveNameOverlap)}`);
  }
  lines.push('');

  for (const route of fixture.routes) {
    lines.push(`### ${route.route} entity types`, ...byTypeLines(route.entities.byType), '');
    lines.push(`### ${route.route} cognitive types`, ...byTypeLines(route.cognitive.byType), '');
  }

  return lines;
}

/**
 * Advisory spot-check output, not a gate report: no pass/fail line, just what each route
 * found so a human can read the counts, types, and latencies side by side.
 */
export function renderMarkdownReport(report: QualityReport): string {
  const lines: string[] = [];
  lines.push('# Extraction quality report', '');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Routes run: ${report.routesRun.length > 0 ? report.routesRun.join(', ') : 'none'}`);
  for (const skipped of report.routesSkipped) {
    lines.push(`Routes skipped: ${skipped.route} (${skipped.reason})`);
  }
  lines.push('');

  for (const fixture of report.fixtures) {
    lines.push(...renderFixture(fixture));
  }

  return lines.join('\n');
}

export function renderJsonReport(report: QualityReport): string {
  return JSON.stringify(report, null, 2);
}
