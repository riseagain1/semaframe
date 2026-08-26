import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ThreeRenderer } from "../../renderer/ThreeRenderer";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function rawSession(id: string): XRSession {
  const target = new EventTarget() as EventTarget & { id: string; end(): Promise<void> };
  target.id = id;
  target.end = vi.fn(async () => { target.dispatchEvent(new Event("end")); });
  return target as unknown as XRSession;
}

describe("ThreeRenderer WebXR lifecycle serialization", () => {
  it("finishes setSession(null) teardown before a rapid replacement enter", async () => {
    const renderer = new ThreeRenderer();
    const internal = renderer as unknown as {
      renderer: {
        xr: {
          isPresenting: boolean;
          enabled: boolean;
          getSession(): XRSession | null;
          setSession(session: XRSession | null): Promise<void>;
          setReferenceSpaceType(): void;
          setFramebufferScaleFactor(): void;
          setFoveation(): void;
          getController(index: number): THREE.Object3D;
        };
      };
      scene: THREE.Scene;
      camera: THREE.PerspectiveCamera;
      controls: { enabled: boolean };
    };
    const first = rawSession("first");
    const second = rawSession("second");
    const nullDetach = deferred();
    const order: string[] = [];
    let active: XRSession | null = null;
    const controllers = [new THREE.Group(), new THREE.Group()];
    internal.renderer = {
      xr: {
        isPresenting: true,
        enabled: false,
        getSession: () => active,
        setSession: vi.fn(async (session) => {
          order.push(session === first ? "first" : session === second ? "second" : "null");
          if (session === null) await nullDetach.promise;
          active = session;
        }),
        setReferenceSpaceType: vi.fn(),
        setFramebufferScaleFactor: vi.fn(),
        setFoveation: vi.fn(),
        getController: (index) => controllers[index]!,
      },
    };
    internal.scene = new THREE.Scene();
    internal.camera = new THREE.PerspectiveCamera();
    internal.scene.add(internal.camera);
    internal.controls = { enabled: true };

    await renderer.enterXR(first);
    const exiting = renderer.exitXR();
    await vi.waitFor(() => expect(order).toEqual(["first", "null"]));
    const reentering = renderer.enterXR(second);
    await Promise.resolve();
    expect(order).toEqual(["first", "null"]);

    nullDetach.resolve();
    await exiting;
    await reentering;
    expect(order).toEqual(["first", "null", "second"]);
  });
});
