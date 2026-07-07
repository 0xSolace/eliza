/**
 * Keeps deterministic mock-eval plugin-view journeys in lockstep with the app
 * GUI visual smoke matrix. The viewType union still includes future modalities,
 * but this guard only tracks shipped GUI views.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_VIEW_LLM_MOCK_CASES,
  PLUGIN_VIEW_LLM_MOCK_JOURNEYS,
  type PluginViewMockCase,
} from "./view-user-journeys.js";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function caseKey(view: Pick<PluginViewMockCase, "id" | "viewType" | "path">) {
  return `${view.id}:${view.viewType}:${view.path}`;
}

function readVisualMatrixCases(): PluginViewMockCase[] {
  const source = readFileSync(
    resolve(repoRoot, "packages/app/test/ui-smoke/plugin-view-cases.ts"),
    "utf8",
  );
  const match = source.match(
    /const VIEW_CASES: ViewCase\[] = \(?\s*\[([\s\S]*?)\]\s*(?:satisfies[\s\S]*?)?\)?\s*\.map/,
  );
  expect(match?.[1], "VIEW_CASES declaration was not found").toBeTruthy();
  const viewCasesSource = match?.[1] ?? "";

  return Array.from(
    viewCasesSource.matchAll(
      /\["([^"]+)",\s*"gui",\s*"([^"]+)"(?:,\s*\{[^}]*\})?\]/g,
    ),
  ).flatMap((caseMatch) => {
    const id = caseMatch[1];
    const path = caseMatch[2];
    if (!id || !path) return [];
    return [{ id, viewType: "gui", path }];
  });
}

function mockLlmViewPlanner(message: string): {
  action: "show";
  view: string;
  viewType: "gui";
  path: string;
} | null {
  const lower = message.toLowerCase();
  const exactPath = [...PLUGIN_VIEW_LLM_MOCK_CASES]
    .sort((left, right) => right.path.length - left.path.length)
    .find((view) => lower.includes(view.path.toLowerCase()));
  if (!exactPath || exactPath.viewType !== "gui") return null;

  return {
    action: "show",
    view: exactPath.id,
    viewType: exactPath.viewType,
    path: exactPath.path,
  };
}

describe("plugin view LLM mock coverage", () => {
  it("keeps mock LLM journeys in lockstep with the GUI visual smoke matrix", () => {
    const visualCases = readVisualMatrixCases();

    expect(new Set(visualCases.map(caseKey))).toEqual(
      new Set(PLUGIN_VIEW_LLM_MOCK_CASES.map(caseKey)),
    );
  });

  it("has one deterministic mock-eval journey for every shipped GUI view case", () => {
    const visualCases = readVisualMatrixCases();
    const journeyByKey = new Map(
      PLUGIN_VIEW_LLM_MOCK_JOURNEYS.map((journey) => [
        journey.id.replace(/^plugin-view-/, ""),
        journey,
      ]),
    );

    expect(PLUGIN_VIEW_LLM_MOCK_JOURNEYS).toHaveLength(
      PLUGIN_VIEW_LLM_MOCK_CASES.length,
    );

    for (const view of visualCases) {
      const journey = journeyByKey.get(`${view.id}-${view.viewType}`);

      expect(journey, `missing mock journey for ${caseKey(view)}`).toBeTruthy();
      expect(journey?.userMessage).toContain(view.path);
      expect(journey?.expectedBehavior).toContain(`"${view.id}"`);
      expect(journey?.expectedBehavior).toContain(`"${view.viewType}"`);
      expect(journey?.verificationCriteria.join("\n")).toContain(view.path);
    }
  });

  it("routes every mock journey through the deterministic planner contract", () => {
    for (const journey of PLUGIN_VIEW_LLM_MOCK_JOURNEYS) {
      const expected = PLUGIN_VIEW_LLM_MOCK_CASES.find(
        (view) =>
          journey.expectedBehavior.includes(`"${view.id}"`) &&
          journey.expectedBehavior.includes(`"${view.viewType}"`) &&
          journey.expectedBehavior.includes(`"${view.path}"`),
      );
      const planned = mockLlmViewPlanner(journey.userMessage);

      expect(expected, `missing case backing ${journey.id}`).toBeTruthy();
      expect(planned, `mock planner failed ${journey.id}`).toEqual({
        action: "show",
        view: expected?.id,
        viewType: expected?.viewType,
        path: expected?.path,
      });
    }
  });
});
