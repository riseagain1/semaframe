import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceChrome, WorkspaceInspector, type WorkspaceComponentUpdateRequest } from "../../app/components/workspace";
import type { WorkspaceRenderComponent } from "../../workspace/renderer";

afterEach(cleanup);

describe("human component creation", () => {
  it("supports a Sources-only dock without exposing component creation or inspection", async () => {
    const user = userEvent.setup();
    render(<WorkspaceChrome
      catalog={[]}
      sources={[]}
      sourcesOnly
      onCreate={vi.fn()}
      onUpdate={vi.fn()}
      onAction={vi.fn()}
      onCreateShowcase={vi.fn()}
    />);

    expect(screen.queryByRole("button", { name: "Components" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inspector" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sources" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByRole("region", { name: "sources panel" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Data sources" })).toBeVisible();
  });

  it("discovers, creates, configures, and atomically updates an inline video player", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onUpdate = vi.fn();

    function Harness() {
      const [selected, setSelected] = useState<WorkspaceRenderComponent>();
      const create = (typeId: string) => {
        onCreate(typeId);
        if (typeId === "video-player") setSelected(videoComponent());
      };
      const update = (request: WorkspaceComponentUpdateRequest) => {
        onUpdate(request);
        setSelected((current) => current ? {
          ...current,
          label: request.label ?? current.label,
          props: { ...current.props, ...request.props },
        } : current);
      };
      return <WorkspaceChrome
        catalog={[
          {
            typeId: "video-player",
            displayName: "Video Player",
            description: "Play YouTube, Vimeo, or direct HTTPS media",
            placements: ["canvas2d", "surface", "billboard", "viewport"],
            trustTier: "builtin",
            configureOnCreate: true,
          },
          {
            typeId: "recipe.focus-meter",
            displayName: "Focus meter",
            description: "viewport · declarative",
            placements: ["viewport"],
            trustTier: "declarative",
          },
        ]}
        selected={selected}
        sources={[]}
        onCreate={create}
        onUpdate={update}
        onAction={vi.fn()}
        onCreateShowcase={vi.fn()}
      />;
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Components" }));
    expect(screen.getByRole("button", { name: /Video Player.*Play YouTube, Vimeo, or direct HTTPS media/i })).toBeVisible();
    expect(screen.getByText("Custom recipe")).toBeVisible();
    expect(screen.getByRole("region", { name: "Custom component help" })).toHaveTextContent(
      "Ask an approved Agent to define a bounded declarative recipe",
    );

    await user.click(screen.getByRole("button", { name: /Video Player.*Play YouTube/i }));
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledWith("video-player");
    expect(await screen.findByRole("heading", { name: "Player setup" })).toBeVisible();
    const source = screen.getByRole("textbox", { name: "Video source URL" });
    expect(source).toHaveValue("https://www.youtube.com/watch?v=M7lc1UVf-VE");

    await user.clear(source);
    await user.type(source, "https://media.internal/private.mp4");
    expect(screen.getByRole("combobox", { name: "Source type" })).toHaveValue("auto");
    await user.click(screen.getByRole("button", { name: "Save player" }));
    expect(screen.getByRole("alert")).toHaveTextContent("public hostname");
    expect(onUpdate).not.toHaveBeenCalled();

    await user.clear(source);
    await user.type(source, "https://vimeo.com/76979871");
    const title = screen.getByRole("textbox", { name: "Player title" });
    await user.clear(title);
    await user.type(title, "Product briefing");
    await user.click(screen.getByRole("button", { name: "Save player" }));

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledWith({
      componentId: "CMP_VIDEO",
      label: "Product briefing",
      props: expect.objectContaining({
        sourceUrl: "https://vimeo.com/76979871",
        sourceKind: "auto",
        title: "Product briefing",
        controls: true,
        autoplay: false,
      }),
    });
    expect(screen.getByRole("complementary", { name: "Inspector for Product briefing" })).toBeVisible();
  });

  it("edits universal visual effects as one explicit Inspector request", async () => {
    const user = userEvent.setup();
    const onVisualEffects = vi.fn();
    render(<WorkspaceInspector component={{
      ...videoComponent(),
      visualEffects: {
        opacity: 1,
        emissive: { color: "#FFFFFF", intensity: 0 },
        glow: { color: "#68D5FF", intensity: 0, spread: 0.5 },
      },
    }} onVisualEffects={onVisualEffects} />);

    const opacity = screen.getByRole("slider", { name: /Object opacity/i });
    fireEvent.change(opacity, { target: { value: "0.65" } });
    const emission = screen.getByRole("spinbutton", { name: "Emission" });
    await user.clear(emission);
    await user.type(emission, "2.2");
    const glow = screen.getByRole("spinbutton", { name: "Glow" });
    await user.clear(glow);
    await user.type(glow, "1.4");
    await user.click(screen.getByRole("button", { name: "Apply effects" }));

    expect(onVisualEffects).toHaveBeenCalledOnce();
    expect(onVisualEffects).toHaveBeenCalledWith({
      componentId: "CMP_VIDEO",
      visualEffects: {
        opacity: 0.65,
        emissive: { color: "#FFFFFF", intensity: 2.2 },
        glow: { color: "#68D5FF", intensity: 1.4, spread: 0.5 },
      },
    });
  });

  it("offers an explicit, lock-aware upgrade for a legacy pinned component", async () => {
    const user = userEvent.setup();
    const onUpgradeManifest = vi.fn();
    const legacy = videoComponent();
    const { rerender } = render(<WorkspaceInspector
      component={legacy}
      manifestUpgrade={{ fromVersion: "1.0.0", toVersion: "1.2.0" }}
      onUpgradeManifest={onUpgradeManifest}
    />);

    expect(screen.getByText(/pinned to 1\.0\.0/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Upgrade component interactions" }));
    expect(onUpgradeManifest).toHaveBeenCalledWith("CMP_VIDEO");

    rerender(<WorkspaceInspector
      component={{ ...legacy, locks: { ...legacy.locks, actions: true } }}
      manifestUpgrade={{ fromVersion: "1.0.0", toVersion: "1.2.0" }}
      onUpgradeManifest={onUpgradeManifest}
    />);
    expect(screen.getByRole("button", { name: "Upgrade component interactions" })).toBeDisabled();
    expect(screen.getByText(/Unlock properties and actions/i)).toBeVisible();
  });
});

function videoComponent(): WorkspaceRenderComponent {
  return {
    id: "CMP_VIDEO",
    type: { typeId: "video-player", version: "1.0.0", digest: "video-digest" },
    label: "Video Player",
    props: {
      sourceUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
      sourceKind: "youtube",
      title: "YouTube player demo",
      controls: true,
      autoplay: false,
      muted: true,
      loop: false,
      allowFullscreen: true,
    },
    durableState: {},
    placement: {
      space: "viewport",
      anchor: "center",
      offset: { x: 0, y: 0 },
      size: { width: 480, height: 306 },
    },
    tags: [],
    visibility: "visible",
    locks: { placement: false, props: false, deletion: false, actions: false },
  };
}
