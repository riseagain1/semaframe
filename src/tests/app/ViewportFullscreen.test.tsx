import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ComponentProps, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Viewport } from "../../app/components/Viewport";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(document, "exitFullscreen");
});

describe("Viewport full screen", () => {
  it("uses an immersive fixed-position fallback without remounting or mutating the scene", async () => {
    let mounts = 0;
    let unmounts = 0;
    const onFrameAll = vi.fn();
    const onResetView = vi.fn();

    function Scene() {
      useEffect(() => {
        mounts += 1;
        return () => { unmounts += 1; };
      }, []);
      return <>
        <div data-testid="hybrid-scene">Scene media</div>
        <nav className="workspace-tool-dock">Workspace tools</nav>
        <aside className="workspace-tool-panel">Inspector</aside>
        <div className="workspace-resize-handles">Resize handles</div>
      </>;
    }

    renderViewport(<Scene />, { onFrameAll, onResetView });
    const scene = screen.getByTestId("hybrid-scene");
    const enter = screen.getByRole("button", { name: "Enter full screen" });
    enter.focus();
    fireEvent.click(enter);

    const shell = document.querySelector(".viewport-shell");
    await waitFor(() => expect(shell).toHaveAttribute("data-fullscreen-mode", "fallback"));
    expect(shell).toHaveClass("is-immersive", "is-fullscreen-fallback");
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeVisible();
    expect(screen.getByTestId("hybrid-scene")).toBe(scene);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(onFrameAll).not.toHaveBeenCalled();
    expect(onResetView).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(shell).toHaveAttribute("data-fullscreen-mode", "off"));
    expect(shell).not.toHaveClass("is-immersive", "is-fullscreen-fallback");
    expect(screen.getByText("Workspace tools")).toBeVisible();
    expect(screen.getByText("Inspector")).toBeVisible();
    expect(screen.getByRole("button", { name: "Enter full screen" })).toHaveFocus();
    expect(screen.getByTestId("hybrid-scene")).toBe(scene);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it("contains fallback focus inside the immersive scene", async () => {
    render(<>
      <button type="button">Covered project control</button>
      <Viewport
        status="ready"
        entityCount={1}
        revision={12}
        onFrameAll={vi.fn()}
        onResetView={vi.fn()}
      >
        <div>Scene</div>
      </Viewport>
    </>);

    fireEvent.click(screen.getByRole("button", { name: "Enter full screen" }));
    const shell = document.querySelector(".viewport-shell");
    await waitFor(() => expect(shell).toHaveAttribute("data-fullscreen-mode", "fallback"));

    screen.getByRole("button", { name: "Covered project control" }).focus();
    await waitFor(() => expect(screen.getByRole("button", { name: "Exit full screen" })).toHaveFocus());
  });

  it("enters and exits the native Fullscreen API while restoring focus", async () => {
    let nativeElement: Element | null = null;
    setNativeFullscreenElement(() => nativeElement);
    const exitFullscreen = vi.fn(async () => {
      nativeElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });

    renderViewport(<div data-testid="hybrid-scene">Scene</div>);
    const shell = document.querySelector<HTMLElement>(".viewport-shell")!;
    const requestFullscreen = vi.fn(async () => {
      nativeElement = shell;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(shell, "requestFullscreen", { configurable: true, value: requestFullscreen });

    const enter = screen.getByRole("button", { name: "Enter full screen" });
    enter.focus();
    fireEvent.click(enter);
    await waitFor(() => expect(shell).toHaveAttribute("data-fullscreen-mode", "native"));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(shell).toHaveClass("is-immersive");
    expect(shell).not.toHaveClass("is-fullscreen-fallback");

    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    await waitFor(() => expect(shell).toHaveAttribute("data-fullscreen-mode", "off"));
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Enter full screen" })).toHaveFocus();
  });

  it("tracks a browser-owned fullscreen exit through fullscreenchange", async () => {
    let nativeElement: Element | null = null;
    setNativeFullscreenElement(() => nativeElement);
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: vi.fn(async () => { nativeElement = null; }),
    });

    renderViewport(<div>Scene</div>);
    const shell = document.querySelector<HTMLElement>(".viewport-shell")!;
    Object.defineProperty(shell, "requestFullscreen", {
      configurable: true,
      value: vi.fn(async () => {
        nativeElement = shell;
        document.dispatchEvent(new Event("fullscreenchange"));
      }),
    });

    const enter = screen.getByRole("button", { name: "Enter full screen" });
    enter.focus();
    fireEvent.click(enter);
    await waitFor(() => expect(shell).toHaveAttribute("data-fullscreen-mode", "native"));

    nativeElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    await waitFor(() => expect(shell).toHaveAttribute("data-fullscreen-mode", "off"));
    expect(screen.getByRole("button", { name: "Enter full screen" })).toHaveFocus();
  });

  it("keeps scene fullscreen active while descendant media enters and exits fullscreen", async () => {
    let nativeElement: Element | null = null;
    setNativeFullscreenElement(() => nativeElement);

    renderViewport(<video data-testid="scene-video" />);
    const shell = document.querySelector<HTMLElement>(".viewport-shell")!;
    const video = screen.getByTestId("scene-video");
    Object.defineProperty(shell, "requestFullscreen", {
      configurable: true,
      value: vi.fn(async () => {
        nativeElement = shell;
        document.dispatchEvent(new Event("fullscreenchange"));
      }),
    });
    const exitFullscreen = vi.fn(async () => {
      nativeElement = nativeElement === video ? shell : null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });

    fireEvent.click(screen.getByRole("button", { name: "Enter full screen" }));
    await waitFor(() => expect(shell).toHaveAttribute("data-fullscreen-mode", "native"));

    nativeElement = video;
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(shell).toHaveAttribute("data-fullscreen-mode", "native");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(exitFullscreen).toHaveBeenCalledTimes(1));
    expect(shell).toHaveAttribute("data-fullscreen-mode", "native");
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(shell).toHaveAttribute("data-fullscreen-mode", "off"));
    expect(exitFullscreen).toHaveBeenCalledTimes(2);
  });

  it("falls back when the browser refuses a native fullscreen request", async () => {
    renderViewport(<div>Scene</div>);
    const shell = document.querySelector<HTMLElement>(".viewport-shell")!;
    const requestFullscreen = vi.fn(async () => { throw new Error("Fullscreen denied"); });
    Object.defineProperty(shell, "requestFullscreen", { configurable: true, value: requestFullscreen });

    fireEvent.click(screen.getByRole("button", { name: "Enter full screen" }));
    await waitFor(() => expect(shell).toHaveAttribute("data-fullscreen-mode", "fallback"));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeVisible();
  });
});

function renderViewport(
  children: ReactNode,
  overrides: Partial<Pick<ComponentProps<typeof Viewport>, "onFrameAll" | "onResetView">> = {},
) {
  return render(<Viewport
    status="ready"
    entityCount={1}
    revision={12}
    agentControlStatus="Connected"
    onFrameAll={overrides.onFrameAll ?? vi.fn()}
    onResetView={overrides.onResetView ?? vi.fn()}
  >
    {children}
  </Viewport>);
}

function setNativeFullscreenElement(read: () => Element | null) {
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: read,
  });
}
