import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { Select } from "~/components/ui/select";
import { useUiStateStore } from "~/uiStateStore";

import { AgentsPanel } from "./AgentsPanel";

/** The fields an agent row reads plus the one ordering breaks ties on; the
    rest never reaches the DOM. */
function subagent(agent: Partial<RuntimeSubagent> & { id: string }): RuntimeSubagent {
  return {
    kind: "subagent",
    title: agent.id,
    status: "running",
    activationCount: 1,
    firstSeenAt: "2026-08-01T10:00:00.000Z",
    ...agent,
  } as RuntimeSubagent;
}

function panelModel(directAgents: ReadonlyArray<RuntimeSubagent>): AgentPanelModel {
  return {
    workflows: [],
    directAgents,
    runningCount: 0,
    waitingCount: 0,
    idleCount: 0,
    settledCount: 0,
    totalTokens: 0,
    hasAgents: true,
    liveCount: 0,
  };
}

function settledRoster(count: number): ReadonlyArray<RuntimeSubagent> {
  return Array.from({ length: count }, (_, index) =>
    subagent({
      id: `settled-${index}`,
      title: `Settled agent ${index}`,
      status: "completed",
      completedAt: `2026-08-01T1${index}:00:00.000Z`,
    }),
  );
}

function renderPanel(model: AgentPanelModel) {
  let created: ReactTestRenderer | undefined;
  act(() => {
    created = create(<AgentsPanel model={model} />);
  });
  const renderer = created!;
  return {
    text: () => JSON.stringify(renderer.toJSON()),
    // The sort trigger is expandable too, so group headers are the buttons
    // that expand without opening a popup.
    collapseToggles: () =>
      renderer.root.findAll(
        (node) =>
          node.type === "button" &&
          node.props["aria-expanded"] !== undefined &&
          node.props["aria-haspopup"] === undefined,
      ),
    /** The host button the picker opens from, popup semantics and all. */
    sortTrigger: () =>
      renderer.root.find(
        (node) => node.type === "button" && node.props["aria-label"] === "Sort agents",
      ),
    /** The popup is portalled and shut in a DOM-less render, so drive the value. */
    pickSort: (sort: string) =>
      act(() => renderer.root.findByType(Select).props.onValueChange(sort)),
    rerender: (next: AgentPanelModel) => act(() => renderer.update(<AgentsPanel model={next} />)),
    unmount: () => act(() => renderer.unmount()),
  };
}

/** The titles in render order. A title that never rendered is a failure, not a
    silent first place. */
function titleOrder(text: string, titles: ReadonlyArray<string>): ReadonlyArray<string> {
  const at = (title: string) => {
    const index = text.indexOf(title);
    if (index < 0) {
      throw new Error(`${title} never rendered`);
    }
    return index;
  };
  return [...titles].sort((left, right) => at(left) - at(right));
}

describe("AgentsPanel direct spawn groups", () => {
  afterEach(() => {
    useUiStateStore.getState().setAgentsPanelSort("status");
  });

  it("heads each group with its count and leaves out the groups with nothing in them", () => {
    const panel = renderPanel(
      panelModel([
        subagent({ id: "run-1", title: "Runner", status: "running" }),
        subagent({ id: "done-1", title: "Finished", status: "completed" }),
      ]),
    );

    const text = panel.text();
    expect(text).toContain("Working (1)");
    expect(text).toContain("Settled (1)");
    expect(text).not.toContain("Waiting (");
    expect(text).not.toContain("Direct spawns");
    panel.unmount();
  });

  it("starts a Settled group of more than five collapsed and reveals it on click", () => {
    const panel = renderPanel(panelModel(settledRoster(6)));

    expect(panel.text()).toContain("Settled (6)");
    expect(panel.text()).not.toContain("Settled agent 0");
    const [toggle, ...rest] = panel.collapseToggles();
    expect(rest).toHaveLength(0);
    expect(toggle!.props["aria-expanded"]).toBe(false);

    act(() => toggle!.props.onClick());

    expect(panel.text()).toContain("Settled agent 0");
    panel.unmount();
  });

  it("leaves a five-row Settled group expanded with no toggle", () => {
    const panel = renderPanel(panelModel(settledRoster(5)));

    expect(panel.text()).toContain("Settled agent 4");
    expect(panel.collapseToggles()).toHaveLength(0);
    panel.unmount();
  });

  it("still collapses a long Settled group under a non-default sort", () => {
    useUiStateStore.getState().setAgentsPanelSort("name");
    const panel = renderPanel(panelModel(settledRoster(6)));

    expect(panel.text()).toContain("Settled (6)");
    expect(panel.text()).not.toContain("Settled agent 0");
    panel.unmount();
  });

  it("shows the rows again when a collapsed Settled group shrinks past the limit", () => {
    const panel = renderPanel(panelModel(settledRoster(6)));
    expect(panel.text()).not.toContain("Settled agent 0");

    panel.rerender(panelModel(settledRoster(5)));

    expect(panel.text()).toContain("Settled agent 0");
    expect(panel.collapseToggles()).toHaveLength(0);
    panel.unmount();
  });

  it("reorders rows when the sort changes and keeps the choice across a remount", () => {
    const model = panelModel([
      subagent({ id: "a", title: "Alpha", status: "running", usage: { totalTokens: 1 } }),
      subagent({ id: "b", title: "Beta", status: "running", usage: { totalTokens: 900 } }),
    ]);
    const panel = renderPanel(model);
    expect(titleOrder(panel.text(), ["Alpha", "Beta"])).toEqual(["Alpha", "Beta"]);
    // A styled button with no popup semantics would leave the sort unreachable.
    expect(panel.sortTrigger().props["aria-haspopup"]).toBe("listbox");

    panel.pickSort("tokens");

    expect(titleOrder(panel.text(), ["Alpha", "Beta"])).toEqual(["Beta", "Alpha"]);
    panel.unmount();

    const remounted = renderPanel(model);
    expect(titleOrder(remounted.text(), ["Alpha", "Beta"])).toEqual(["Beta", "Alpha"]);
    remounted.unmount();
  });
});
