import { useEffect, useRef, type ReactNode } from "react";

export type AgentWorkspaceGateProps = Readonly<{
  active: boolean;
  connection: ReactNode;
  children: ReactNode;
}>;

/**
 * Keeps the Workspace runtime mounted while Agent authorization is temporarily
 * gated. The opaque connection surface owns desktop focus and interaction, but
 * long-lived projections such as a paired XR authority continue to run.
 */
export function AgentWorkspaceGate({ active, connection, children }: AgentWorkspaceGateProps) {
  const gateRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (active) return;
    const frame = globalThis.requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused === document.body || (focused instanceof Node && workspaceRef.current?.contains(focused))) {
        gateRef.current?.focus({ preventScroll: true });
      }
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [active]);

  return <>
    {!active && <main
      ref={gateRef}
      className="agent-connection-gate is-blocking"
      aria-label="Agent connection"
      tabIndex={-1}
    >
      {connection}
    </main>}
    <main
      ref={workspaceRef}
      id="workspace-panel"
      className={`app-workspace${active ? " agent-control-active" : " is-desktop-gated"}`}
      aria-label="Workspace"
      aria-hidden={active ? undefined : true}
      inert={active ? undefined : true}
      data-agent-workspace-active={active ? "true" : "false"}
    >
      {children}
    </main>
  </>;
}
