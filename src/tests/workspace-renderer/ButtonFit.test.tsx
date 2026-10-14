import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceComponentView } from "../../app/components/workspace/WorkspaceComponentViews";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

afterEach(cleanup);

const workspaceCss = readFileSync(resolve("src/app/components/workspace/workspace.css"), "utf8");
function rule(selector: string): CSSStyleDeclaration {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = workspaceCss.match(new RegExp(`^${escaped} \\{([^}]+)\\}`, "mu"));
  if (!match) throw new Error(`Missing CSS rule ${selector}`);
  const element = document.createElement("div");
  element.style.cssText = match[1]!;
  return element.style;
}

describe("button fitted rendering", () => {
  it("uses the allocated box without intrinsic minimum or wrapper padding that clips saved compact panels", () => {
    const wrapper = rule(".workspace-button-component");
    const button = rule(".workspace-button");
    for (const style of [wrapper, button]) {
      expect(style.boxSizing).toBe("border-box");
      expect(style.width).toBe("100%");
      expect(style.height).toBe("100%");
      expect(style.minWidth).toBe("0");
      expect(style.minHeight).toBe("0");
      expect(style.paddingTop).toBe("0px");
      expect(style.paddingBottom).toBe("0px");
    }
    expect(wrapper.paddingLeft).toBe("0px");
    expect(wrapper.paddingRight).toBe("0px");
    expect(button.display).toBe("block");
    expect(button.whiteSpace).toBe("nowrap");
    expect(button.textOverflow).toBe("ellipsis");
    expect(button.overflow).toBe("hidden");
    expect(rule(".workspace-button:focus-visible").outlineOffset).toBe("-4px");
  });

  it.each([32, 40, 46, 48])("preserves the full accessible name and semantic action for a narrow %i px control", (height) => {
    const label = "Pull the chair away from the workbench safely — 把椅子拉出来";
    const onAction = vi.fn();
    const component: WorkspaceRenderComponent = {
      id: "BUTTON",
      type: { typeId: "button", version: height < 46 ? "1.2.0" : "1.3.0", digest: "fixture" },
      label: "Chair control", props: { label, variant: "primary" }, durableState: { pressCount: 0 },
      placement: { space: "viewport", anchor: "top_left", offset: { x: 20, y: 80 }, size: { width: 80, height } },
      visibility: "visible", tags: [],
      locks: { placement: false, props: false, deletion: false, actions: false },
    };
    const { rerender } = render(<WorkspaceComponentView component={component} onAction={onAction} />);
    const button = screen.getByRole("button", { name: label });
    expect(button).toHaveAttribute("title", label);
    expect(button).toHaveTextContent(label);
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ componentId: "BUTTON", action: "press" });
    rerender(<WorkspaceComponentView component={{
      ...component, locks: { ...component.locks, actions: true },
    }} onAction={onAction} />);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
