import { createRoot } from "react-dom/client";
import { SemaFrameXRViewer } from "./xr/app";
import { XrViewerHttpTransport } from "./xr/network";
import { BrowserSpeechRecognitionAdapter } from "./xr/speech";
import { resolveXrGatewayOrigin, takeXrPairingToken } from "./xr/entry";
import "./xr.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("SemaFrame XR requires a #root element.");

// This runs before React mounts or XrViewerHttpTransport can issue a request.
const pairingToken = takeXrPairingToken(globalThis.location, globalThis.history);
const speechAdapter = new BrowserSpeechRecognitionAdapter({
  language: globalThis.navigator.language || "en-US",
});
const speech = speechAdapter.probe().available ? speechAdapter : undefined;

try {
  const transport = new XrViewerHttpTransport({
    baseUrl: resolveXrGatewayOrigin(import.meta.env.VITE_XR_GATEWAY_ORIGIN, globalThis.location),
  });
  createRoot(rootElement).render(
    <SemaFrameXRViewer
      transport={transport}
      initialPairingToken={pairingToken}
      scrubPairingToken={() => {
        // `takePairingToken` already scrubbed the fragment before first render.
        // Keep the viewer boundary idempotent if pairing is retried.
        takeXrPairingToken(globalThis.location, globalThis.history);
      }}
      speech={speech}
    />,
  );
} catch (cause) {
  const message = cause instanceof Error ? cause.message : "The XR client could not start.";
  createRoot(rootElement).render(
    <main role="alert" style={{ maxWidth: 680, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>SemaFrame XR configuration error</h1>
      <p>{message}</p>
    </main>,
  );
}
