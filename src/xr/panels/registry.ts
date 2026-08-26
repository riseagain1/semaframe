import type {
  XRPanelKind,
  XRPanelModel,
  XRPanelPresentation,
  XRPanelPresenter,
} from "./contracts";
import { BUILTIN_XR_PANEL_PRESENTERS } from "./presenters";

type RegisteredPresenter = Readonly<{
  source: object;
  id: string;
  kind: XRPanelKind;
  present(model: XRPanelModel): XRPanelPresentation;
}>;

export class XRPanelPresenterRegistry {
  private readonly presenters = new Map<XRPanelKind, RegisteredPresenter>();

  register<K extends XRPanelKind>(presenter: XRPanelPresenter<K>): () => void {
    const id = presenter.id.trim();
    if (!id || id.length > 256) throw new TypeError("XR panel presenter id is invalid");
    if (this.presenters.has(presenter.kind)) {
      throw new Error(`XR panel presenter for ${presenter.kind} is already registered`);
    }
    const registered: RegisteredPresenter = Object.freeze({
      source: presenter,
      id,
      kind: presenter.kind,
      present(model: XRPanelModel): XRPanelPresentation {
        // The registry lookup checks this discriminant before invoking the presenter.
        if (model.kind !== presenter.kind) throw new TypeError("XR panel model/presenter kind mismatch");
        return presenter.present(model as Extract<XRPanelModel, { kind: K }>);
      },
    });
    this.presenters.set(presenter.kind, registered);
    return () => {
      if (this.presenters.get(presenter.kind)?.source === presenter) this.presenters.delete(presenter.kind);
    };
  }

  has(kind: XRPanelKind): boolean {
    return this.presenters.has(kind);
  }

  list(): readonly Readonly<{ id: string; kind: XRPanelKind }>[] {
    return Object.freeze([...this.presenters.values()]
      .map(({ id, kind }) => Object.freeze({ id, kind }))
      .sort((left, right) => left.kind.localeCompare(right.kind)));
  }

  present(model: XRPanelModel): XRPanelPresentation {
    const presenter = this.presenters.get(model.kind);
    if (!presenter) throw new Error(`No XR panel presenter is registered for ${model.kind}`);
    return presenter.present(model);
  }
}

export function createDefaultXRPanelPresenterRegistry(): XRPanelPresenterRegistry {
  const registry = new XRPanelPresenterRegistry();
  registry.register(BUILTIN_XR_PANEL_PRESENTERS[0]);
  registry.register(BUILTIN_XR_PANEL_PRESENTERS[1]);
  registry.register(BUILTIN_XR_PANEL_PRESENTERS[2]);
  registry.register(BUILTIN_XR_PANEL_PRESENTERS[3]);
  return registry;
}
