import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentBridgeProposalRecord,
  AgentBridgeSessionAccess,
} from "../../agent/AgentGatewayClient";
import {
  SceneBridgeDialog,
  type SceneBridgeDialogProps,
  type SceneBridgeProposalItem,
} from "../../app/components/SceneBridgeDialog";
import type {
  SemaFrameBridgeChangeProposal,
  SemaFrameBridgeProposalReview,
  SemaFrameSha256,
} from "../../bridge";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const digest = `sha256:${"a".repeat(64)}` as SemaFrameSha256;
const bearer = "b".repeat(43);

const session: AgentBridgeSessionAccess = Object.freeze({
  sessionId: "11111111-2222-4333-8444-555555555555",
  bearer,
  target: "blender",
  expiresAt: "2026-08-27T12:00:00.000Z",
  pullUrl: `http://127.0.0.1:8788/v1/bridge/sessions/11111111-2222-4333-8444-555555555555?token=${bearer}`,
  exchangeUrl: "http://127.0.0.1:8788/v1/bridge/sessions/11111111-2222-4333-8444-555555555555/exchange",
});

const proposal: SemaFrameBridgeChangeProposal = Object.freeze({
  format: "semaframe-bridge-change-proposal",
  version: "1.0",
  proposalId: "blender-edit-1",
  target: "blender",
  source: Object.freeze({
    workspaceId: "workspace-1",
    baseRevision: 4,
    exchangeDigest: digest,
  }),
  note: "Move the chair and replace its material.",
  changes: Object.freeze([
    Object.freeze({
      changeId: "move-chair",
      kind: "transform" as const,
      componentId: "chair",
      placement: Object.freeze({
        space: "world3d" as const,
        position: Object.freeze({ x: 1, y: 0, z: 2 }),
        rotation: Object.freeze({ x: 0, y: 0, z: 0 }),
        scale: Object.freeze({ x: 1, y: 1, z: 1 }),
      }),
    }),
    Object.freeze({
      changeId: "replace-material",
      kind: "properties" as const,
      componentId: "chair",
      props: Object.freeze({ material: "red" }),
    }),
  ]),
});

const record: AgentBridgeProposalRecord = Object.freeze({
  cursor: 7,
  receivedAt: "2026-08-27T10:00:00.000Z",
  proposal,
});

function proposalItem(stale = false): SceneBridgeProposalItem {
  const review: SemaFrameBridgeProposalReview = Object.freeze({
    proposal,
    status: "review_required",
    stale,
    issues: Object.freeze(stale ? [{
      code: "stale_exchange",
      message: "The Workspace advanced after this proposal was authored.",
    }] : [{
      changeId: "replace-material",
      code: "locked_component",
      message: "The material is locked in the current Workspace.",
    }]),
    eligibleChangeIds: Object.freeze(["move-chair"]),
    ineligibleChangeIds: Object.freeze(["replace-material"]),
  });
  return Object.freeze({ record, review });
}

function callbacks(): Pick<SceneBridgeDialogProps,
  | "onClose"
  | "onCreate"
  | "onPublish"
  | "onRefreshProposals"
  | "onApplyProposal"
  | "onDiscardThrough"
  | "onCloseSession"
> {
  return {
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onPublish: vi.fn(),
    onRefreshProposals: vi.fn(),
    onApplyProposal: vi.fn(),
    onDiscardThrough: vi.fn(),
    onCloseSession: vi.fn(),
  };
}

describe("SceneBridgeDialog", () => {
  it("creates a session for the explicitly selected target", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(<SceneBridgeDialog open {...handlers} />);

    expect(screen.getByRole("dialog", { name: "Scene Bridge" })).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "Destination tool" }), "freecad");
    await user.click(screen.getByRole("button", { name: "Create FreeCAD session" }));

    expect(handlers.onCreate).toHaveBeenCalledOnce();
    expect(handlers.onCreate).toHaveBeenCalledWith("freecad");
  });

  it("copies setup JSON with a separate Authorization header and no bearer in either URL", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<SceneBridgeDialog
      open
      session={session}
      publication={{ sequence: 1, revision: 4, digest }}
      {...callbacks()}
    />);

    expect(screen.getByText(/Authorization stays out of the URL/i)).toBeVisible();
    expect(document.body).not.toHaveTextContent(bearer);
    await user.click(screen.getByRole("button", { name: "Copy setup JSON" }));

    expect(writeText).toHaveBeenCalledOnce();
    const copied = JSON.parse(String(writeText.mock.calls[0]?.[0])) as {
      pullUrl: string;
      exchangeUrl: string;
      authorization: { header: string; value: string };
    };
    expect(copied.authorization).toEqual({
      header: "Authorization",
      value: `Bearer ${bearer}`,
    });
    expect(copied.pullUrl).not.toContain(bearer);
    expect(copied.exchangeUrl).not.toContain(bearer);
    expect(copied.pullUrl).not.toMatch(/[?&]token=/u);
    expect(await screen.findByRole("button", { name: "Setup JSON copied" })).toBeVisible();
  });

  it("applies only changes explicitly selected from the eligible set", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(<SceneBridgeDialog
      open
      session={session}
      publication={{ sequence: 1, revision: 4, digest }}
      proposals={[proposalItem()]}
      {...handlers}
    />);

    const eligible = screen.getByRole("checkbox", { name: /Transform move-chair Component chair/i });
    const ineligible = screen.getByRole("checkbox", { name: /Properties replace-material Component chair/i });
    const apply = screen.getByRole("button", { name: "Apply selected" });
    expect(eligible).toBeEnabled();
    expect(ineligible).toBeDisabled();
    expect(apply).toBeDisabled();
    expect(screen.getAllByText(/material is locked/i)).toHaveLength(2);

    await user.click(eligible);
    await user.click(screen.getByRole("button", { name: "Apply 1" }));

    expect(handlers.onApplyProposal).toHaveBeenCalledOnce();
    expect(handlers.onApplyProposal).toHaveBeenCalledWith(record, ["move-chair"]);
  });

  it("keeps all stale proposal changes disabled even when the old review listed an eligible ID", () => {
    render(<SceneBridgeDialog
      open
      session={session}
      publication={{ sequence: 2, revision: 5, digest }}
      proposals={[proposalItem(true)]}
      {...callbacks()}
    />);

    expect(screen.getByText("Stale")).toBeVisible();
    expect(screen.getAllByRole("checkbox").every((checkbox) => checkbox.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: "Apply selected" })).toBeDisabled();
    expect(screen.getAllByText(/older publication/i)).toHaveLength(2);
  });

  it("closes the dialog with Escape and revokes a session only from its explicit action", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(<SceneBridgeDialog
      open
      session={session}
      publication={{ sequence: 1, revision: 4, digest }}
      {...handlers}
    />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Close Scene Bridge" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(handlers.onClose).toHaveBeenCalledOnce();
    expect(handlers.onCloseSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close session" }));
    expect(handlers.onCloseSession).toHaveBeenCalledOnce();
  });
});
