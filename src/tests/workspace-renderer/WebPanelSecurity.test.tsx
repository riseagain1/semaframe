import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWebPanelSource,
  WebPanelView,
} from "../../app/components/workspace/WebPanelView";
import { WorkspaceCanvasOverlay } from "../../app/components/workspace/WorkspaceCanvasOverlay";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import type { ProjectedComponent, WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

afterEach(cleanup);

describe("website panel URL boundary", () => {
  it("accepts ordinary HTTPS pages and canonicalizes the saved target", () => {
    expect(resolveWebPanelSource("  https://Example.COM/reports?q=quarterly#chart  ")).toEqual({
      ok: true,
      normalizedUrl: "https://example.com/reports?q=quarterly#chart",
      origin: "https://example.com",
      hostname: "example.com",
    });
    expect(resolveWebPanelSource("https://example.com:443/path")).toMatchObject({
      ok: true,
      normalizedUrl: "https://example.com/path",
    });
    expect(resolveWebPanelSource("https://example.com/?monkey=capuchin")).toMatchObject({ ok: true });
    expect(resolveWebPanelSource("https://example.com/?code=US")).toMatchObject({ ok: true });
    expect(resolveWebPanelSource("https://example.com/login/enterprise-dashboard")).toMatchObject({ ok: true });
    expect(resolveWebPanelSource("https://example.com/#section-overview")).toMatchObject({ ok: true });
    expect(resolveWebPanelSource("https://example.com/#/login/enterprise-dashboard")).toMatchObject({ ok: true });
    expect(resolveWebPanelSource("https://example.com/#code=US")).toMatchObject({ ok: true });
    expect(resolveWebPanelSource(`https://example.com/#next=${encodeURIComponent("https://docs.example.org/invite/project-alpha")}`))
      .toMatchObject({ ok: true });
    expect(resolveWebPanelSource("https://8.8.8.8/")).toMatchObject({ ok: true });
    expect(resolveWebPanelSource("https://[2606:4700:4700::1111]/")).toMatchObject({ ok: true });
  });

  it.each([
    ["http://example.com", /Only HTTPS/i],
    ["javascript:alert(1)", /Only HTTPS/i],
    ["https://user:pass@example.com", /usernames or passwords/i],
    ["https://example.com:8443/dashboard", /Custom network ports/i],
    ["https://example.com/?accessToken=top-secret", /query parameters/i],
    ["https://example.com/?api%2Dkey=top-secret", /query parameters/i],
    ["https://example.com/?%2561ccess%255Ftoken=top-secret", /query parameters/i],
    ["https://example.com/?q=Bearer%20abcdefghi", /query parameters/i],
    ["https://example.com/?payload=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", /query parameters/i],
    ["https://example.com/#session_token=top-secret", /URL fragments/i],
    ["https://example.com/?code=0123456789abcdef0123456789abcdef", /query parameters/i],
    ["https://example.com/#eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", /URL fragments/i],
    ["https://example.com/magic-login/0123456789abcdef0123456789abcdef", /capability URLs/i],
    ["https://example.com/reset/89c1d3fa-b344-4db8-a926-79c88d72d18f", /capability URLs/i],
    [`https://example.com/?next=${encodeURIComponent("https://accounts.example.org/invite/0123456789abcdef0123456789abcdef")}`, /query parameters/i],
    ["https://example.com/#access_token=abcdefghijklmnopqrstuvwxyz012345", /URL fragments/i],
    ["https://example.com/#/callback?code=SuperSecretOAuthCode123456", /URL fragments/i],
    [`https://example.com/#next=${encodeURIComponent("https://accounts.example.org/invite/0123456789abcdef0123456789abcdef")}`, /URL fragments/i],
    ["https://localhost/", /Local, private/i],
    ["https://console.localhost/", /Local, private/i],
    ["https://intranet/", /Local, private/i],
    ["https://router.local/", /Local, private/i],
    ["https://127.1/", /Local, private/i],
    ["https://2130706433/", /Local, private/i],
    ["https://10.0.0.1/", /Local, private/i],
    ["https://100.64.0.1/", /Local, private/i],
    ["https://169.254.169.254/latest/meta-data/", /Local, private/i],
    ["https://172.31.255.255/", /Local, private/i],
    ["https://192.168.1.1/", /Local, private/i],
    ["https://198.18.0.1/", /Local, private/i],
    ["https://224.0.0.1/", /Local, private/i],
    ["https://[::1]/", /Local, private/i],
    ["https://[::ffff:127.0.0.1]/", /Local, private/i],
    ["https://[fc00::1]/", /Local, private/i],
    ["https://[fe80::1]/", /Local, private/i],
    ["https://[2001:db8::1]/", /Local, private/i],
  ])("rejects unsafe target %s", (url, reason) => {
    const result = resolveWebPanelSource(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it("declares no load action that an Agent or event route can invoke", () => {
    const manifest = DEFAULT_COMPONENT_REGISTRY.require("web-panel");
    expect(manifest.version).toBe("1.2.0");
    expect(manifest.defaultDurableState).toEqual({});
    expect(manifest.actions).not.toHaveProperty("load");
    expect(manifest.actions).not.toHaveProperty("open");
    expect(manifest.actions).toMatchObject({
      show: expect.any(Object),
      hide: expect.any(Object),
      toggle_visibility: expect.any(Object),
    });
    expect(manifest.resizePolicy.viewport).toMatchObject({
      kind: "box2d",
      defaultSize: { width: 560, height: 420 },
      minSize: { width: 280, height: 200 },
    });
  });
});

describe("WebPanelView activation and isolation", () => {
  it("mounts no browsing context until the user explicitly loads that panel", () => {
    render(<WebPanelView component={webPanel("web-1", "https://example.com/dashboard", "Operations")} />);

    const region = screen.getByRole("region", { name: "Operations website panel" });
    expect(region).toHaveAttribute("data-web-panel-state", "facade");
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.getByText(/Loading contacts this address/i)).toBeVisible();
    expect(screen.getByText(/redirect this frame to another HTTPS address/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Load Operations" }));
    const frame = screen.getByTitle("Operations");
    expect(region).toHaveAttribute("data-web-panel-state", "requested");
    expect(frame).toHaveAttribute("src", "https://example.com/dashboard");
    expect(frame).toHaveAttribute("loading", "lazy");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("allow")).toMatch(/camera 'none'/u);
    expect(frame.getAttribute("allow")).toMatch(/microphone 'none'/u);
    expect(frame.getAttribute("allow")).toMatch(/geolocation 'none'/u);
    expect(frame.getAttribute("allow")).toMatch(/clipboard-read 'none'/u);
    expect(screen.getByText(/Some websites forbid framing/i)).toBeVisible();
    expect(screen.getByText(/cannot verify the final page/i)).toBeVisible();

    const external = screen.getByRole("link", { name: "Open in browser" });
    expect(external).toHaveAttribute("href", "https://example.com/dashboard");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external.getAttribute("rel")).toContain("noopener");
    expect(external.getAttribute("rel")).toContain("noreferrer");
    expect(external).toHaveAttribute("referrerpolicy", "no-referrer");

    fireEvent.click(screen.getByRole("button", { name: "Unload" }));
    expect(frame.isConnected).toBe(false);
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(region).toHaveAttribute("data-web-panel-state", "facade");
  });

  it("requires a new user gesture after every source change, including returning to a previously approved URL", () => {
    const view = render(<WebPanelView component={webPanel("web-1", "https://example.com/one", "Reports")} />);
    fireEvent.click(screen.getByRole("button", { name: "Load Reports" }));
    const oldFrame = screen.getByTitle("Reports");

    view.rerender(<WebPanelView component={webPanel("web-1", "https://example.com/two", "Reports")} />);

    expect(oldFrame.isConnected).toBe(false);
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load Reports" })).toBeVisible();

    view.rerender(<WebPanelView component={webPanel("web-1", "https://example.com/one", "Reports")} />);

    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load Reports" })).toBeVisible();
  });

  it("drops local approval when a deleted component ID is reused by a new instance", () => {
    const first = { ...webPanel("REUSED_WEB", "https://example.com/", "Reused"), instanceRevision: 1 };
    const projection: ProjectedComponent = {
      componentId: first.id,
      space: "viewport",
      left: 0,
      top: 0,
      width: 560,
      height: 420,
      zIndex: 1,
      visible: true,
      spatialOnly: false,
    };
    const view = render(<WorkspaceCanvasOverlay
      components={[first]}
      projections={new Map([[first.id, projection]])}
      selectedId={first.id}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Load Reused" }));
    const oldFrame = screen.getByTitle("Reused");

    const recreated = { ...first, instanceRevision: 7 };
    view.rerender(<WorkspaceCanvasOverlay
      components={[recreated]}
      projections={new Map([[recreated.id, projection]])}
      selectedId={recreated.id}
    />);

    expect(oldFrame.isConnected).toBe(false);
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load Reused" })).toBeVisible();
  });

  it("scopes activation to a single panel and keeps an external fallback for framing refusals", () => {
    render(<>
      <WebPanelView component={webPanel("web-a", "https://example.com/a", "Panel A")} />
      <WebPanelView component={webPanel("web-b", "https://example.org/b", "Panel B")} />
    </>);

    fireEvent.click(screen.getByRole("button", { name: "Load Panel A" }));
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Load Panel B" })).toBeVisible();

    expect(screen.getAllByRole("link", { name: "Open in browser" }).some((link) =>
      link.getAttribute("href") === "https://example.com/a")).toBe(true);
    expect(screen.getByText(/Some websites forbid framing/i)).toBeVisible();
    expect(screen.getByTitle("Panel A")).toBeInTheDocument();
  });

  it("never creates a browsing context for an invalid persisted target", () => {
    render(<WebPanelView component={webPanel("web-invalid", "https://example.com/?token=secret", "Unsafe")} />);
    expect(screen.getByRole("status")).toHaveTextContent("Website unavailable");
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load Unsafe/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open in browser" })).not.toBeInTheDocument();
  });
});

function webPanel(id: string, sourceUrl: string, title: string): WorkspaceRenderComponent {
  return {
    id,
    type: { typeId: "web-panel", version: "1.2.0", digest: "test-web-panel" },
    label: title,
    props: { sourceUrl, title },
    durableState: {},
    placement: {
      space: "viewport",
      anchor: "center",
      offset: { x: 0, y: 0 },
      size: { width: 560, height: 420 },
    },
    tags: [],
    visibility: "visible",
    locks: { placement: false, props: false, deletion: false, actions: false },
  };
}
