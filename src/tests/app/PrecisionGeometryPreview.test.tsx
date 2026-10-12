import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrecisionGeometryPreview, precisionPreviewCoordinates } from "../../app/components/workspace/PrecisionGeometryPreview";
import { createPrecisionStudy } from "../../workspace/precision/validation";
import { evaluatePrecisionStudy } from "../../workspace/precision/verification";
import type { MeasurementGeometry } from "../../workspace/precision/types";
import type { WebGLRenderer } from "three";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function geometry(): MeasurementGeometry {
  return { geometryId: "mesh", units: "metre", coordinateBasis: "RUB", source: { sha256: `sha256:${"a".repeat(64)}`, format: "synthetic", provenance: "Synthetic rendering fixture" },
    positions: [[1e8, 0, 0], [1e8 + 0.00001, 0, 0], [1e8, 0.00001, 0], [1e8, 0, 0.00001]], triangles: [[0, 1, 2], [0, 1, 3]] };
}

describe("precision geometry visual inspection", () => {
  it("recentres Float64 geometry before Float32 conversion without mutating source data", () => {
    const source = geometry(); const before = JSON.stringify(source);
    const preview = precisionPreviewCoordinates(source);
    expect(preview.positions[0]).not.toBe(preview.positions[3]);
    expect(Math.max(...preview.positions)).toBeCloseTo(1, 4);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("provides equal-scale XY/XZ/YZ fallback with fit controls distinct from independent checks", () => {
    const base = createPrecisionStudy(geometry());
    const study = { ...base, controls: [{ id: "fit", vertexIndex: 0, referencePointM: [0, 0, 0] as const, uncertaintyM: 0.0001, provenance: "declared fixture", regionId: "test" }],
      checks: [{ id: "check", vertexIndex: 3, referencePointM: [1e8, 0, 0.00001] as const, uncertaintyM: 0.0001, provenance: "held-out fixture", regionId: "test" }] };
    render(<PrecisionGeometryPreview study={study} report={evaluatePrecisionStudy(study)} />);
    expect(screen.getByRole("img", { name: /XY projection/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Measurement fallback projection"), { target: { value: "XZ" } });
    expect(screen.getByRole("img", { name: /XZ projection/ })).toBeInTheDocument();
    expect(screen.getByText("Fit control: fit").parentElement?.tagName).toBe("rect");
    expect(screen.getByText("Independent check: check").parentElement?.tagName).toBe("circle");
    expect(screen.getByText(/Visual inspection only/)).toBeInTheDocument();
  });

  it("creates a real Three scene and orbit controls, falls back on context loss, and releases rendering resources", () => {
    vi.stubGlobal("WebGLRenderingContext", class {});
    const study = createPrecisionStudy(geometry());
    const renderer = { domElement: document.createElement("canvas"), render: vi.fn(), dispose: vi.fn(), forceContextLoss: vi.fn(), setPixelRatio: vi.fn(), setSize: vi.fn() };
    const rendererFactory = vi.fn(() => renderer as unknown as WebGLRenderer);
    const rendered = render(<PrecisionGeometryPreview study={study} report={evaluatePrecisionStudy(study)} rendererFactory={rendererFactory} />);
    expect(rendererFactory).toHaveBeenCalledOnce();
    expect(renderer.render).toHaveBeenCalled();
    const [scene] = renderer.render.mock.calls[0]!;
    expect(scene.children.some((child: { type: string }) => child.type === "Mesh")).toBe(true);
    expect(scene.children.some((child: { type: string }) => child.type === "Points")).toBe(true);
    expect(screen.getByRole("button", { name: "Reset 3D view" })).toBeInTheDocument();
    fireEvent(renderer.domElement, new Event("webglcontextlost", { cancelable: true }));
    expect(screen.getByLabelText("Measurement fallback projection")).toBeInTheDocument();
    rendered.unmount();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(renderer.domElement.isConnected).toBe(false);
  });
});
