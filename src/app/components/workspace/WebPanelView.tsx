import { useState } from "react";
import type { WorkspaceRenderComponent } from "../../../workspace/renderer/contracts";
import { resolveWebPanelSource } from "../../../workspace/components/webPanelSecurity";
export { resolveWebPanelSource } from "../../../workspace/components/webPanelSecurity";

/**
 * A facade is always rendered first. Activation lives only in this browser
 * view and is intentionally absent from Workspace state/actions, so neither a
 * newly-created Agent panel nor replay can make a network request by itself.
 */
export function WebPanelView({ component }: Readonly<{ component: WorkspaceRenderComponent }>) {
  const sourceUrl = stringValue(component.props.sourceUrl);
  const source = resolveWebPanelSource(sourceUrl);
  const title = stringValue(component.props.title) || component.label;

  if (!source.ok) {
    return (
      <section
        className="workspace-web-panel is-unavailable"
        aria-label={`${title} website panel`}
        data-web-panel-state="unavailable"
      >
        <div className="workspace-web-panel__status" role="status">
          <strong>{title}</strong>
          <span>Website unavailable</span>
          <small>{source.reason}</small>
        </div>
      </section>
    );
  }

  // Key the owner of local activation, not just the iframe. A source change,
  // manifest recreation, undo back to an earlier URL, or ID reuse must mount a
  // fresh facade instead of reviving approval for a previously-loaded target.
  const activationOwner = `${component.instanceRevision ?? "legacy"}:${source.normalizedUrl}`;
  return <ResolvedWebPanelView
    key={activationOwner}
    normalizedUrl={source.normalizedUrl}
    origin={source.origin}
    hostname={source.hostname}
    title={title}
  />;
}

function ResolvedWebPanelView({
  normalizedUrl,
  origin,
  hostname,
  title,
}: Readonly<{
  normalizedUrl: string;
  origin: string;
  hostname: string;
  title: string;
}>) {
  const [activated, setActivated] = useState(false);

  return (
    <section
      className="workspace-web-panel"
      aria-label={`${title} website panel`}
      data-web-panel-state={activated ? "requested" : "facade"}
      data-web-panel-origin={origin}
      data-web-panel-requested-origin={origin}
    >
      <header className="workspace-web-panel__header">
        <span>
          <strong>{title}</strong>
          <small>Requested: {hostname}</small>
        </span>
        <span className="workspace-web-panel__actions">
          <a
            href={normalizedUrl}
            target="_blank"
            rel="noopener noreferrer external"
            referrerPolicy="no-referrer"
            data-no-canvas-drag="true"
          >
            Open in browser
          </a>
          {activated && (
            <button type="button" data-no-canvas-drag="true" onClick={() => setActivated(false)}>
              Unload
            </button>
          )}
        </span>
      </header>
      <div className="workspace-web-panel__viewport">
        {!activated ? (
          <div className="workspace-web-panel__activation">
            <span className="workspace-web-panel__origin" aria-hidden="true">↗</span>
            <strong>{hostname}</strong>
            <p>
              Loading contacts this address. Its scripts run in an opaque-origin
              sandbox. Forms, popups, parent-page navigation, camera, microphone,
              location, clipboard, and fullscreen are blocked. The site can still
              redirect this frame to another HTTPS address.
            </p>
            <button
              type="button"
              data-no-canvas-drag="true"
              aria-label={`Load ${title}`}
              onClick={() => setActivated(true)}
            >
              Load website
            </button>
          </div>
        ) : (
          <>
            <iframe
              src={normalizedUrl}
              title={title}
              loading="lazy"
              sandbox="allow-scripts"
              allow="accelerometer 'none'; autoplay 'none'; camera 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; encrypted-media 'none'; fullscreen 'none'; geolocation 'none'; gyroscope 'none'; microphone 'none'; midi 'none'; payment 'none'; picture-in-picture 'none'; usb 'none'; xr-spatial-tracking 'none'"
              referrerPolicy="no-referrer"
              data-no-canvas-drag="true"
            />
            <p className="workspace-web-panel__frame-note" role="status">
              Embed requested for {hostname}. Some websites forbid framing or redirect
              inside the frame; this app cannot verify the final page. If it stays blank
              or looks unexpected, Unload it and use Open in browser.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
