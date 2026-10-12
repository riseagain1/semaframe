import { useEffect, useMemo, useRef, useState } from "react";
import {
  AmbientLight, AxesHelper, BufferAttribute, BufferGeometry, Color, DirectionalLight,
  DoubleSide, Mesh, MeshStandardMaterial, PerspectiveCamera, Points, PointsMaterial,
  Scene, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { calibratedGeometry } from "../../../workspace/precision/calibration";
import type { MeasurementGeometry, PrecisionReport, PrecisionStudyV1, PrecisionVec3 } from "../../../workspace/precision/types";

/** Rendering only: subtract the Float64 origin before conversion to Float32. */
export function precisionPreviewCoordinates(geometry: MeasurementGeometry): Readonly<{
  positions: Float32Array;
  center: PrecisionVec3;
  scale: number;
}> {
  const minimum = [Infinity, Infinity, Infinity]; const maximum = [-Infinity, -Infinity, -Infinity];
  for (const point of geometry.positions) for (let axis = 0; axis < 3; axis += 1) {
    minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
    maximum[axis] = Math.max(maximum[axis]!, point[axis]!);
  }
  const center = minimum.map((value, axis) => value + (maximum[axis]! - value) / 2) as unknown as PrecisionVec3;
  const extent = Math.max(...maximum.map((value, axis) => value - minimum[axis]!));
  const scale = extent > 0 ? 2 / extent : 1;
  const positions = new Float32Array(geometry.positions.length * 3);
  geometry.positions.forEach((point, index) => { for (let axis = 0; axis < 3; axis += 1) positions[index * 3 + axis] = (point[axis]! - center[axis]!) * scale; });
  return { positions, center, scale };
}

const CHECK_COLORS = { pass: 0x67daa2, fail: 0xfa7d7d, inconclusive: 0xe0bb6c } as const;

export function PrecisionGeometryPreview({ study, report, rendererFactory }: Readonly<{ study: PrecisionStudyV1; report: PrecisionReport; rendererFactory?: () => WebGLRenderer }>) {
  const host = useRef<HTMLDivElement>(null);
  const [webglReady, setWebglReady] = useState(false);
  const [plane, setPlane] = useState<"XY" | "XZ" | "YZ">("XY");
  const [resetKey, setResetKey] = useState(0);
  const geometry = useMemo(() => {
    try { return calibratedGeometry(study); } catch { return study.geometry; }
  }, [study]);
  const display = useMemo(() => precisionPreviewCoordinates(geometry), [geometry]);
  const checkById = useMemo(() => new Map(report.checks.map((check) => [check.id, check])), [report]);

  useEffect(() => {
    const target = host.current;
    if (!target || typeof WebGLRenderingContext === "undefined") { setWebglReady(false); return; }
    let renderer: WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let observer: ResizeObserver | undefined;
    let disposed = false;
    const scene = new Scene(); scene.background = new Color(0x15202b);
    const camera = new PerspectiveCamera(45, 1, 0.005, 100);
    camera.position.set(3, 2.2, 3); camera.lookAt(0, 0, 0);
    const resources: { dispose(): void }[] = [];
    const render = () => { if (!disposed && renderer) renderer.render(scene, camera); };
    const resize = () => {
      if (!renderer || disposed) return;
      const width = Math.max(1, target.clientWidth || 280); const height = Math.max(1, target.clientHeight || 210);
      camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); render();
    };
    const stopPropagation = (event: Event) => event.stopPropagation();
    const contextLost = (event: Event) => { event.preventDefault(); disposed = true; if (controls) controls.enabled = false; setWebglReady(false); };
    try {
      renderer = rendererFactory ? rendererFactory() : new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" });
      renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
      renderer.domElement.setAttribute("aria-label", "Interactive 3D measurement geometry — drag to orbit, wheel to zoom");
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.tabIndex = 0;
      renderer.domElement.addEventListener("pointerdown", stopPropagation);
      renderer.domElement.addEventListener("wheel", stopPropagation);
      renderer.domElement.addEventListener("webglcontextlost", contextLost);
      target.appendChild(renderer.domElement);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false; controls.minDistance = 0.05; controls.maxDistance = 30;
      controls.addEventListener("change", render);
      const pointGeometry = new BufferGeometry(); pointGeometry.setAttribute("position", new BufferAttribute(display.positions, 3));
      resources.push(pointGeometry);
      const pointMaterial = new PointsMaterial({ color: 0x80bceb, size: 0.012, sizeAttenuation: true }); resources.push(pointMaterial);
      scene.add(new Points(pointGeometry, pointMaterial));
      if (geometry.triangles?.length) {
        const meshGeometry = new BufferGeometry(); meshGeometry.setAttribute("position", new BufferAttribute(display.positions.slice(), 3));
        meshGeometry.setIndex(geometry.triangles.flatMap((triangle) => [...triangle])); meshGeometry.computeVertexNormals();
        const material = new MeshStandardMaterial({ color: 0x4c7b9c, side: DoubleSide, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        resources.push(meshGeometry, material); scene.add(new Mesh(meshGeometry, material));
      }
      const addMarkers = (indices: readonly number[], color: number, size: number) => {
        if (!indices.length) return;
        const positions = new Float32Array(indices.length * 3);
        indices.forEach((index, targetIndex) => positions.set(display.positions.subarray(index * 3, index * 3 + 3), targetIndex * 3));
        const markerGeometry = new BufferGeometry(); markerGeometry.setAttribute("position", new BufferAttribute(positions, 3));
        const material = new PointsMaterial({ color, size, depthTest: false, sizeAttenuation: true });
        const markers = new Points(markerGeometry, material); markers.renderOrder = 2;
        resources.push(markerGeometry, material); scene.add(markers);
      };
      addMarkers(study.controls.map((control) => control.vertexIndex), 0xc399ff, 0.065);
      for (const status of ["pass", "fail", "inconclusive"] as const) addMarkers(study.checks.filter((check) => (checkById.get(check.id)?.status ?? "inconclusive") === status).map((check) => check.vertexIndex), CHECK_COLORS[status], 0.05);
      const axes = new AxesHelper(0.5); axes.position.set(-1.15, -1.15, -1.15); scene.add(axes);
      resources.push(axes.geometry, ...(Array.isArray(axes.material) ? axes.material : [axes.material]));
      scene.add(new AmbientLight(0xffffff, 1.6));
      const light = new DirectionalLight(0xffffff, 2); light.position.set(3, 5, 4); scene.add(light);
      if (typeof ResizeObserver !== "undefined") { observer = new ResizeObserver(resize); observer.observe(target); }
      globalThis.addEventListener("resize", resize); resize(); setWebglReady(true);
    } catch {
      setWebglReady(false);
    }
    return () => {
      disposed = true; observer?.disconnect(); globalThis.removeEventListener("resize", resize);
      controls?.removeEventListener("change", render); controls?.dispose();
      if (renderer) {
        renderer.domElement.removeEventListener("pointerdown", stopPropagation);
        renderer.domElement.removeEventListener("wheel", stopPropagation);
        renderer.domElement.removeEventListener("webglcontextlost", contextLost);
        renderer.domElement.remove();
      }
      for (const resource of resources) resource.dispose();
      scene.clear(); renderer?.dispose(); renderer?.forceContextLoss();
    };
  }, [checkById, display, geometry, study.controls, study.checks, resetKey, rendererFactory]);

  const [horizontal, vertical] = plane === "XY" ? [0, 1] : plane === "XZ" ? [0, 2] : [1, 2];
  const points = geometry.positions;
  const horizontalValues = points.map((point) => point[horizontal]!); const verticalValues = points.map((point) => point[vertical]!);
  const x0 = Math.min(...horizontalValues); const x1 = Math.max(...horizontalValues); const y0 = Math.min(...verticalValues); const y1 = Math.max(...verticalValues);
  const drawingScale = Math.min(276 / Math.max(x1 - x0, 1e-9), 146 / Math.max(y1 - y0, 1e-9));
  const x = (point: PrecisionVec3) => 12 + (point[horizontal]! - x0) * drawingScale;
  const y = (point: PrecisionVec3) => 158 - (point[vertical]! - y0) * drawingScale;
  const stride = Math.max(1, Math.ceil(points.length / 1_200));
  return <figure className="precision-study__preview">
    <div ref={host} className={`precision-study__webgl${webglReady ? " is-ready" : ""}`} />
    {!webglReady && <>
      <label>Fallback projection<select aria-label="Measurement fallback projection" value={plane} onChange={(event) => setPlane(event.target.value as typeof plane)}><option>XY</option><option>XZ</option><option>YZ</option></select></label>
      <svg viewBox="0 0 300 170" role="img" aria-label={`${plane} projection of measurement geometry, calibration controls and independent checks`}>
        {points.map((point, index) => index % stride === 0 ? <circle key={index} cx={x(point)} cy={y(point)} r="1.2" className="precision-study__point" /> : null)}
        {study.controls.map((control) => { const point = points[control.vertexIndex]!; return <rect key={control.id} x={x(point) - 4} y={y(point) - 4} width="8" height="8" className="precision-study__control"><title>Fit control: {control.id}</title></rect>; })}
        {study.checks.map((check) => { const point = points[check.vertexIndex]!; return <circle key={check.id} cx={x(point)} cy={y(point)} r="4" className={`precision-study__check is-${checkById.get(check.id)?.status ?? "inconclusive"}`}><title>Independent check: {check.id}</title></circle>; })}
      </svg>
    </>}
    <figcaption>{webglReady ? "3D · drag to orbit, wheel/pinch to zoom" : `${plane} fallback projection · WebGL unavailable`} · {geometry.units} · {points.length.toLocaleString()} source points · {geometry.triangles?.length ?? 0} triangles. Visual inspection only; numerical analysis remains Float64.{!webglReady && stride > 1 ? " Fallback preview thinned; analysis uses every point." : ""}</figcaption>
    <p className="precision-study__legend">Purple squares: fit controls. Green / red / amber: independent checks passing / failing / inconclusive. Marker sizes are display-only.</p>
    {webglReady && <button type="button" onClick={() => setResetKey((value) => value + 1)}>Reset 3D view</button>}
  </figure>;
}
