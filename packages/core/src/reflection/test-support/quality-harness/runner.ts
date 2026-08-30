import { QUALITY_FIXTURES, type QualityFixture } from './fixtures.js';
import type { FixtureReport, QualityReport, SkippedRoute } from './report.js';
import { computeAgreement, summarizeCognitive, summarizeEntities } from './scorer.js';
import type { CognitiveExtractorFn, EntityExtractorFn, ExtractionRoute } from './types.js';
import { redact } from '../../../redaction/redact.js';
import { renderEpisodeText } from '../../domain/content.js';

export type RouteConfig = {
  readonly route: ExtractionRoute;
  readonly model: string;
  readonly extractEntities: EntityExtractorFn;
  readonly extractCognitive: CognitiveExtractorFn;
};

export type QualityHarnessOptions = {
  readonly routes: readonly RouteConfig[];
  readonly skippedRoutes?: readonly SkippedRoute[];
  readonly fixtures?: readonly QualityFixture[];
  /** Injected for report.test.ts's fixed-input assertions; defaults to the wall clock. */
  readonly now?: () => Date;
};

async function runFixture(
  fixture: QualityFixture,
  routes: readonly RouteConfig[],
): Promise<FixtureReport> {
  const { text } = redact(renderEpisodeText(fixture.content));

  const outcomes = await Promise.all(
    routes.map(async (route) => {
      const [entities, cognitive] = await Promise.all([
        route.extractEntities(text),
        route.extractCognitive(text),
      ]);
      return { route, entities, cognitive };
    }),
  );

  return {
    id: fixture.id,
    title: fixture.title,
    charCount: text.length,
    routes: outcomes.map(({ route, entities, cognitive }) => ({
      route: route.route,
      model: route.model,
      entities: summarizeEntities(entities),
      cognitive: summarizeCognitive(cognitive),
    })),
    agreement: computeAgreement(
      outcomes.map(({ entities, cognitive }) => ({ entities, cognitive })),
    ),
  };
}

/** Runs every fixture against every configured route and assembles the report. Advisory: no gate assertions. */
export async function runQualityHarness(options: QualityHarnessOptions): Promise<QualityReport> {
  const fixtures = options.fixtures ?? QUALITY_FIXTURES;
  const now = options.now ?? (() => new Date());

  // Fixtures run one at a time: the local route's single Ollama instance already fields
  // two concurrent calls per fixture (entities, cognitive), and piling fixtures on top would
  // queue requests behind each other's own 60s abort clock instead of the model's.
  const fixtureReports: FixtureReport[] = [];
  for (const fixture of fixtures) {
    fixtureReports.push(await runFixture(fixture, options.routes));
  }

  return {
    generatedAt: now().toISOString(),
    routesRun: options.routes.map((route) => route.route),
    routesSkipped: options.skippedRoutes ?? [],
    fixtures: fixtureReports,
  };
}
