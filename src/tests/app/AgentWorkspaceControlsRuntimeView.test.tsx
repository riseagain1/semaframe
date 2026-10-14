import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentWorkspaceControls, type AgentWorkspaceStatus } from "../../app/components/AgentWorkspaceControls";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

let stylesheet: HTMLStyleElement | undefined;
afterEach(() => { cleanup(); stylesheet?.remove(); stylesheet = undefined; });

describe("Agent control bounds during runtime-view guarded commits", () => {
  it("uses content-independent CSS tracks while status and history remain accessible", () => {
    stylesheet = document.createElement("style");
    stylesheet.textContent = styles;
    document.head.append(stylesheet);
    const onHistory = vi.fn();
    const onManage = vi.fn();
    const clientName = "DeepSeek Harness modeling rerun";
    const controls = (status: AgentWorkspaceStatus, historyCount: number) => <AgentWorkspaceControls
      status={status} clientName={clientName} historyCount={historyCount}
      onHistory={onHistory} onManage={onManage} />;
    const view = render(controls("connected", 0));
    const root = screen.getByRole("region", { name: "Agent workspace controls" });
    // JSDOM does not perform pixel layout: verify the structural CSS contract,
    // leaving actual getBoundingClientRect equality to browser acceptance.
    const layout = () => {
      const style = getComputedStyle(root);
      return { width: style.width, columns: style.gridTemplateColumns, minHeight: style.minHeight };
    };
    const before = layout();
    const desktopRule = [...stylesheet.sheet!.cssRules].find((rule): rule is CSSStyleRule =>
      "selectorText" in rule && rule.selectorText === ".agent-workspace-controls");
    expect(desktopRule?.style.getPropertyValue("width")).toBe("min(520px, calc(100% - 32px))");
    expect(before).toMatchObject({ columns: "minmax(0, 1fr) 120px 94px", minHeight: "44px" });
    expect(before.width).not.toBe("");
    for (const [status, count, label] of [
      ["applying", 0, `Applying ${clientName} change`],
      ["connected", 1, `${clientName} connected`],
      ["applying", 1_000, `Applying ${clientName} change`],
      ["disconnected", 1_000, `${clientName} disconnected`],
    ] as const) {
      view.rerender(controls(status, count));
      expect(layout()).toEqual(before);
      expect(screen.getByRole("status")).toHaveTextContent(label);
      expect(screen.getByTitle(label)).toHaveTextContent(label);
      const textStyle = getComputedStyle(screen.getByTitle(label));
      expect(textStyle.overflow).toBe("hidden");
      expect(textStyle.textOverflow).toBe("ellipsis");
    }
    expect(screen.getByLabelText("1000 entries")).toHaveTextContent("999+");
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(onHistory).toHaveBeenCalledOnce();
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("keeps the mobile toolbar anchored to both edges rather than intrinsic label width", () => {
    stylesheet = document.createElement("style");
    stylesheet.textContent = styles;
    document.head.append(stylesheet);
    const media = [...stylesheet.sheet!.cssRules].filter((rule): rule is CSSMediaRule =>
      "conditionText" in rule && String(rule.conditionText).includes("max-width: 520px"));
    const controlRule = media.flatMap((rule) => [...rule.cssRules]).find((rule): rule is CSSStyleRule =>
      "selectorText" in rule && rule.selectorText === ".agent-workspace-controls");
    expect(controlRule?.style.getPropertyValue("width")).toBe("auto");
    expect(controlRule?.style.getPropertyValue("left")).toBe("8px");
    expect(controlRule?.style.getPropertyValue("right")).toBe("8px");
    expect(controlRule?.style.getPropertyValue("grid-template-columns")).toBe("minmax(0, 1fr) 48px 48px");
  });
});
