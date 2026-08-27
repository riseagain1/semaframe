import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSourcePanel } from "../../app/components/workspace";
import { DEFAULT_COMPONENT_REGISTRY, deterministicDigest } from "../../workspace/components";
import type { WorkspaceHostFeedSaveRequest } from "../../workspace/data";
import { toRenderSnapshot } from "../../workspace/renderer";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";

afterEach(cleanup);

describe("WorkspaceSourcePanel", () => {
  it("shows freshness, provenance, binding diagnostics, and a bounded reapply action", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<WorkspaceSourcePanel
      sources={[{
        id: "RES_market",
        label: "Market snapshot",
        connectorType: "inline.snapshot",
        connectorVersion: "1.0.0",
        status: "ready",
        retrievedAt: "2026-08-15T01:02:03.000Z",
        provenanceLabel: "SemaFrame inline snapshot",
        bindingCount: 1,
        editableJson: '{"price":188.4}',
        reapplyable: true,
        diagnostics: [{
          bindingId: "BIND_price",
          componentId: "CMP_chart",
          resourceId: "RES_market",
          targetProp: "series",
          code: "source_path_not_found",
          severity: "error",
          message: "Binding path $.series does not exist",
        }],
      }]}
      diagnostics={[{
        bindingId: "BIND_price",
        componentId: "CMP_chart",
        resourceId: "RES_market",
        targetProp: "series",
        code: "source_path_not_found",
        severity: "error",
        message: "Binding path $.series does not exist",
      }]}
      onRefresh={onRefresh}
    />);

    expect(screen.getByText(/Retrieved .*1 binding/u)).toBeVisible();
    expect(screen.getByText(/Provenance: SemaFrame inline snapshot/u)).toBeVisible();
    expect(screen.getAllByText(/source_path_not_found/u)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Reapply" }));
    expect(onRefresh).toHaveBeenCalledWith("RES_market");
  });

  it("creates or updates a local CSV chart snapshot without offering a network fetch", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => true);
    render(<WorkspaceSourcePanel
      sources={[]}
      bindingTargets={[{
        id: "CMP_chart",
        label: "Price chart",
        typeId: "chart",
        writableProps: ["labels", "series"],
      }]}
      onSaveInlineSource={onSave}
    />);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /Local JSON \/ CSV/u }));
    await user.clear(screen.getByRole("textbox", { name: "Source label" }));
    await user.type(screen.getByRole("textbox", { name: "Source label" }), "ACME intraday");
    await user.selectOptions(screen.getByRole("combobox", { name: "Format" }), "csv");
    fireEvent.change(screen.getByRole("textbox", { name: "Snapshot data" }), {
      target: { value: "time,Close\n09:30,188.4\n09:31,189.1" },
    });
    await user.click(screen.getByRole("button", { name: "Preview snapshot" }));
    expect(screen.getByRole("region", { name: "Snapshot preview" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Choose destination" }));
    await user.click(screen.getByRole("radio", { name: /Use an existing component/u }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Existing component" }), "CMP_chart");
    expect(screen.getByText(/automatically binds \$\.labels and \$\.series/u)).toBeVisible();
    expect(screen.getByText(/no URL is fetched/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save snapshot" }));

    expect(onSave).toHaveBeenCalledWith({
      label: "ACME intraday",
      format: "csv",
      text: "time,Close\n09:30,188.4\n09:31,189.1",
      targetComponentId: "CMP_chart",
      sourcePath: "$",
    });
  });

  it("previews a host-brokered feed and saves a closed Data Panel mapping with refresh policy", async () => {
    const user = userEvent.setup();
    const retrievedAt = "2026-08-15T03:04:05.000Z";
    const onPreviewHostFeed = vi.fn(async () => ({
      version: 1 as const,
      requestedUrl: "https://feeds.example.test/news.xml",
      finalUrl: "https://cdn.example.test/news.xml",
      format: "rss" as const,
      contentType: "application/rss+xml",
      retrievedAt,
      outputSchema: { type: "object" },
      snapshot: {
        data: { title: "Daily news", items: [{ title: "Alpha" }] },
        contentHash: "sha256:test",
        retrievedAt,
        stale: false,
        provenance: [{ publisher: "Example News", retrievedAt }],
      },
    }));
    const onSaveHostFeed = vi.fn(async () => true);
    render(<WorkspaceSourcePanel
      sources={[]}
      bindingTargets={[{
        id: "CMP_data",
        label: "News data",
        typeId: "data-panel",
        writableProps: ["data", "title", "view"],
      }]}
      onPreviewHostFeed={onPreviewHostFeed}
      onSaveHostFeed={onSaveHostFeed}
    />);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /Public HTTPS feed/u }));
    await user.type(screen.getByRole("textbox", { name: "HTTPS feed URL" }), "https://feeds.example.test/news.xml");
    await user.selectOptions(screen.getByRole("combobox", { name: "Feed format" }), "rss");
    await user.selectOptions(screen.getByRole("combobox", { name: "Refresh policy" }), "interval");
    await user.clear(screen.getByRole("spinbutton", { name: "Refresh interval (seconds)" }));
    await user.type(screen.getByRole("spinbutton", { name: "Refresh interval (seconds)" }), "45");
    await user.click(screen.getByRole("button", { name: "Preview feed" }));

    expect(onPreviewHostFeed).toHaveBeenCalledWith({
      url: "https://feeds.example.test/news.xml",
      format: "rss",
      policy: {
        mode: "interval",
        intervalMs: 45_000,
        offline: "keep_last_good",
      },
    });
    expect(await screen.findByText(/RSS from https:\/\/cdn\.example\.test/u)).toBeVisible();
    expect(screen.getByText(/Publisher: Example News/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Choose destination" }));
    await user.click(screen.getByRole("radio", { name: /Use an existing component/u }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Existing component" }), "CMP_data");
    expect(screen.getByText(/complete feed automatically binds/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save feed" }));

    expect(onSaveHostFeed).toHaveBeenCalledWith(expect.objectContaining({
      label: "External feed",
      requestedFormat: "rss",
      policy: {
        mode: "interval",
        intervalMs: 45_000,
        offline: "keep_last_good",
      },
      targetComponentId: "CMP_data",
      mapping: expect.objectContaining({
        targetType: "data-panel",
        bindings: [{ targetProp: "data", sourcePath: "$", transform: { kind: "identity" } }],
      }),
    }));
  });

  it("hands interval feed output to the canonical Store boundary and projects it into a Data Panel", async () => {
    const user = userEvent.setup();
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "create_data_panel", [{
      op: "create_component",
      op_id: "create_data_panel",
      id: "CMP_data",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("data-panel"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
    }]));
    const retrievedAt = "2026-08-15T03:04:05.000Z";
    const data = { items: [{ title: "Alpha" }, { title: "Beta" }] };
    const feed = {
      version: 1 as const,
      requestedUrl: "https://feeds.example.test/news.json",
      finalUrl: "https://cdn.example.test/news.json",
      format: "json" as const,
      contentType: "application/json",
      retrievedAt,
      outputSchema: { type: "object" },
      snapshot: {
        data,
        contentHash: deterministicDigest(data),
        retrievedAt,
        stale: false,
        provenance: [{
          uri: "https://cdn.example.test/news.json",
          publisher: "cdn.example.test",
          retrievedAt,
          citation: "https://cdn.example.test/news.json",
        }],
      },
    };
    const onSaveHostFeed = vi.fn(async (request: WorkspaceHostFeedSaveRequest) => {
      const mapping = request.mapping;
      if (!request.targetComponentId || !mapping) return false;
      store.apply(workspaceBatch(store, "connect_host_feed", [{
        op: "upsert_resource",
        op_id: "upsert_host_feed",
        resource: {
          id: "RES_feed",
          label: request.label,
          connectorType: "http.feed",
          connectorVersion: "1.0.0",
          outputSchema: structuredClone(request.feed.outputSchema),
          config: { url: request.feed.requestedUrl, format: request.requestedFormat },
          policy: structuredClone(request.policy),
          snapshot: structuredClone(request.feed.snapshot),
          status: "ready",
        },
      }, ...mapping.bindings.map((binding, index) => ({
        op: "bind_resource" as const,
        op_id: `bind_host_feed_${index}`,
        binding: {
          kind: "resource_binding" as const,
          id: `BIND_feed_${index}`,
          resourceId: "RES_feed",
          componentId: request.targetComponentId!,
          targetProp: binding.targetProp,
          sourcePath: binding.sourcePath,
          mode: "snapshot" as const,
          transform: structuredClone(binding.transform),
          enabled: true,
        },
      }))]));
      return true;
    });

    render(<WorkspaceSourcePanel
      sources={[]}
      bindingTargets={[{
        id: "CMP_data",
        label: "News data",
        typeId: "data-panel",
        writableProps: ["data", "title", "view"],
      }]}
      onPreviewHostFeed={vi.fn(async () => feed)}
      onSaveHostFeed={onSaveHostFeed}
    />);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /Public HTTPS feed/u }));
    await user.type(screen.getByRole("textbox", { name: "HTTPS feed URL" }), feed.requestedUrl);
    await user.selectOptions(screen.getByRole("combobox", { name: "Refresh policy" }), "interval");
    await user.clear(screen.getByRole("spinbutton", { name: "Refresh interval (seconds)" }));
    await user.type(screen.getByRole("spinbutton", { name: "Refresh interval (seconds)" }), "45");
    await user.click(screen.getByRole("button", { name: "Preview feed" }));
    await screen.findByText(/JSON from https:\/\/cdn\.example\.test/u);
    await user.click(screen.getByRole("button", { name: "Choose destination" }));
    await user.click(screen.getByRole("radio", { name: /Use an existing component/u }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Existing component" }), "CMP_data");
    await user.click(screen.getByRole("button", { name: "Save feed" }));

    expect(onSaveHostFeed).toHaveBeenCalledWith(expect.objectContaining({
      policy: { mode: "interval", intervalMs: 45_000, offline: "keep_last_good" },
    }));
    expect(store.getState().resources.get("RES_feed")?.policy).toEqual({
      mode: "interval",
      intervalMs: 45_000,
      offline: "keep_last_good",
    });
    expect(toRenderSnapshot(store.getState()).components.find(({ id }) => id === "CMP_data")?.props.data).toEqual(data);
    expect(store.canUndoUserCommand()).toBe(true);
  });

  it("labels host-backed source refresh separately and preserves its last-good metadata", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<WorkspaceSourcePanel
      sources={[{
        id: "RES_feed",
        label: "Weather feed",
        connectorType: "http.feed",
        connectorVersion: "1.0.0",
        status: "stale",
        retrievedAt: "2026-08-15T01:02:03.000Z",
        provenanceLabel: "Weather Bureau",
        refreshable: true,
        lastError: "Host timed out; showing last good data",
      }]}
      onRefresh={onRefresh}
    />);

    expect(screen.getByText(/Last good/u)).toBeVisible();
    expect(screen.getByText(/Host timed out; showing last good data/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledWith("RES_feed");
  });

  it("manages, re-previews, adds bindings, unbinds, and confirms cascade deletion for an existing feed", async () => {
    const user = userEvent.setup();
    const retrievedAt = "2026-08-15T04:05:06.000Z";
    const feed = {
      version: 1 as const,
      requestedUrl: "https://feeds.example.test/weather.json",
      finalUrl: "https://feeds.example.test/weather.json",
      format: "json" as const,
      contentType: "application/json",
      retrievedAt,
      outputSchema: { type: "object" },
      snapshot: {
        data: { temperature: 24 },
        contentHash: deterministicDigest({ temperature: 24 }),
        retrievedAt,
        stale: false,
        provenance: [{
          uri: "https://feeds.example.test/weather.json",
          publisher: "feeds.example.test",
          retrievedAt,
          citation: "https://feeds.example.test/weather.json",
        }],
      },
    };
    const onSaveHostFeed = vi.fn(async () => true);
    const onUnbindSource = vi.fn();
    const onDeleteSource = vi.fn();
    render(<WorkspaceSourcePanel
      sources={[{
        id: "RES_feed",
        label: "Weather feed",
        connectorType: "http.feed",
        connectorVersion: "1.0.0",
        status: "ready",
        retrievedAt,
        refreshable: true,
        automationPaused: true,
        hostFeedConfig: {
          url: feed.requestedUrl,
          format: "json",
          policy: { mode: "on_open", offline: "keep_last_good" },
        },
        bindings: [{
          id: "BIND_weather",
          componentId: "CMP_existing",
          componentLabel: "Existing panel",
          targetProp: "data",
          sourcePath: "$",
        }],
      }]}
      bindingTargets={[{
        id: "CMP_second",
        label: "Second panel",
        typeId: "data-panel",
        writableProps: ["data", "title", "view"],
      }]}
      onPreviewHostFeed={vi.fn(async () => feed)}
      onSaveHostFeed={onSaveHostFeed}
      onUnbindSource={onUnbindSource}
      onDeleteSource={onDeleteSource}
    />);

    expect(screen.getByText(/Existing panel\.data ← \$/u)).toBeVisible();
    expect(screen.getByText("Automation paused; Preview/update to enable.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByRole("textbox", { name: "Feed label" })).toHaveValue("Weather feed");
    expect(screen.getByRole("textbox", { name: "HTTPS feed URL" })).toHaveValue(feed.requestedUrl);
    expect(screen.getByRole("combobox", { name: "Refresh policy" })).toHaveValue("on_open");
    await user.click(screen.getByRole("button", { name: "Preview feed" }));
    expect(await screen.findByRole("region", { name: "Feed preview" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to edit" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Refresh policy" }), "manual");
    expect(screen.queryByRole("region", { name: "Feed preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update feed" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Preview feed" }));
    await user.click(screen.getByRole("button", { name: "Choose destination" }));
    await user.click(screen.getByRole("radio", { name: /Use an existing component/u }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Existing component" }), "CMP_second");
    await user.click(screen.getByRole("button", { name: "Update feed" }));
    expect(onSaveHostFeed).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: "RES_feed",
      label: "Weather feed",
      policy: { mode: "manual", offline: "keep_last_good" },
      targetComponentId: "CMP_second",
      mapping: expect.objectContaining({
        bindings: [{ targetProp: "data", sourcePath: "$", transform: { kind: "identity" } }],
      }),
    }));

    await user.click(screen.getByRole("button", { name: "Unbind" }));
    expect(onUnbindSource).toHaveBeenCalledWith("BIND_weather");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDeleteSource).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(onDeleteSource).toHaveBeenCalledWith("RES_feed");
  });

  it("requests one atomic create-and-bind command for a new destination", async () => {
    const user = userEvent.setup();
    const onSaveInlineSource = vi.fn(() => true);
    const onCommitSourceWithNewTarget = vi.fn(async () => true);
    render(<WorkspaceSourcePanel
      sources={[]}
      onSaveInlineSource={onSaveInlineSource}
      onCommitSourceWithNewTarget={onCommitSourceWithNewTarget}
    />);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /Local JSON \/ CSV/u }));
    await user.click(screen.getByRole("button", { name: "Preview snapshot" }));
    await user.click(screen.getByRole("button", { name: "Choose destination" }));
    await user.click(screen.getByRole("radio", { name: /Create a new component/u }));
    await user.click(screen.getByRole("button", { name: "Save snapshot" }));

    expect(onSaveInlineSource).not.toHaveBeenCalled();
    expect(onCommitSourceWithNewTarget).toHaveBeenCalledWith(expect.objectContaining({
      kind: "local",
      source: expect.objectContaining({ label: "Market snapshot", format: "json" }),
      destination: expect.objectContaining({
        mode: "create",
        componentType: "data-panel",
        mapping: expect.objectContaining({
          targetType: "data-panel",
          bindings: [{ targetProp: "data", sourcePath: "$", transform: { kind: "identity" } }],
        }),
      }),
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("Source connected");
  });

  it("ignores a host preview that resolves after close or a project generation change", async () => {
    const user = userEvent.setup();
    const retrievedAt = "2026-08-15T03:04:05.000Z";
    const result = {
      version: 1 as const,
      requestedUrl: "https://feeds.example.test/data.json",
      finalUrl: "https://feeds.example.test/data.json",
      format: "json" as const,
      contentType: "application/json",
      retrievedAt,
      outputSchema: { type: "object" },
      snapshot: {
        data: { value: 4 },
        contentHash: "sha256:test",
        retrievedAt,
        stale: false,
        provenance: [{ publisher: "Example", retrievedAt }],
      },
    };
    let resolvePreview: ((value: typeof result) => void) | undefined;
    const onPreviewHostFeed = vi.fn(() => new Promise<typeof result>((resolve) => { resolvePreview = resolve; }));
    const props = {
      sources: [],
      onPreviewHostFeed,
      onSaveHostFeed: vi.fn(async () => true),
    } as const;
    const { rerender } = render(<WorkspaceSourcePanel {...props} scopeKey="project-a" />);

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /Public HTTPS feed/u }));
    await user.type(screen.getByRole("textbox", { name: "HTTPS feed URL" }), result.requestedUrl);
    await user.click(screen.getByRole("button", { name: "Preview feed" }));
    rerender(<WorkspaceSourcePanel {...props} scopeKey="project-b" />);
    await act(async () => { resolvePreview?.(result); });
    expect(screen.queryByRole("region", { name: "Feed preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Source setup" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add source" }));
    await user.click(screen.getByRole("button", { name: /Public HTTPS feed/u }));
    await user.type(screen.getByRole("textbox", { name: "HTTPS feed URL" }), result.requestedUrl);
    await user.click(screen.getByRole("button", { name: "Preview feed" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => { resolvePreview?.(result); });
    expect(screen.queryByRole("region", { name: "Feed preview" })).not.toBeInTheDocument();
  });
});
