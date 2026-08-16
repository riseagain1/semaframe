import type { ComponentPlacement, Vec3 } from "../components/componentTypes";

export const WORKSPACE_PHYSICS_VERSION = "2.0" as const;

export type PhysicsBodyType = "static" | "dynamic" | "kinematic";
export type PhysicsStabilityMode = "report" | "enforce";
export type PhysicsConstraintType = "fixed" | "hinge" | "slider" | "ball";

export type PhysicsConstraint = Readonly<{
  id: string;
  type: PhysicsConstraintType;
  targetId: string;
  anchor: Vec3;
  targetAnchor: Vec3;
  axis: Vec3;
  limits?: Readonly<{ min: number; max: number }>;
  enabled: boolean;
}>;

export type SpatialPhysicsConfig = Readonly<{
  /** Master switch for stability, constraint, and settle participation. Collision remains independent. */
  enabled: boolean;
  bodyType: PhysicsBodyType;
  massKg: number;
  /** Local offset from the resolved collider/bounds center, in meters. */
  centerOfMass: Vec3;
  friction: number;
  restitution: number;
  gravityScale: number;
  stabilityMode: PhysicsStabilityMode;
  constraints: readonly PhysicsConstraint[];
}>;

export const DEFAULT_SPATIAL_PHYSICS: SpatialPhysicsConfig = Object.freeze({
  enabled: true,
  bodyType: "static",
  massKg: 1,
  centerOfMass: Object.freeze({ x: 0, y: 0, z: 0 }),
  friction: 0.6,
  restitution: 0.1,
  gravityScale: 1,
  stabilityMode: "report",
  constraints: Object.freeze([]),
});

export type PhysicsSupport = Readonly<{
  componentId: string;
  kind: "ground" | "component";
  supportingComponentId?: string;
  contactHeight: number;
  contactAreaM2: number;
  /** True only when the complete load path reaches ground or an anchored body. */
  grounded: boolean;
}>;

export type PhysicsIssueCode =
  | "collision"
  | "collider_missing"
  | "ground_penetration"
  | "unsupported"
  | "tip_risk"
  | "constraint_target_missing"
  | "constraint_anchor_gap"
  | "constraint_axis_invalid"
  | "constraint_unstable"
  | "capacity_exceeded"
  | "settle_incomplete";

export type PhysicsIssue = Readonly<{
  code: PhysicsIssueCode;
  componentId: string;
  message: string;
  relatedComponentId?: string;
  constraintId?: string;
}>;

export type PhysicsBodyReport = Readonly<{
  componentId: string;
  enabled: boolean;
  bodyType: PhysicsBodyType;
  massKg: number;
  centerOfMassWorld: Vec3;
  friction: number;
  restitution: number;
  gravityScale: number;
  stabilityMode: PhysicsStabilityMode;
  stable: boolean;
  grounded: boolean;
  stabilityReason:
    | "disabled"
    | "anchored"
    | "driven"
    | "weightless"
    | "constrained"
    | "supported"
    | "unsupported"
    | "tip_risk"
    | "collision"
    | "collider_missing"
    | "penetrating";
  supportPolygon: readonly Readonly<{ x: number; z: number }>[];
  stabilityMarginM: number | null;
  supports: readonly PhysicsSupport[];
  constraints: readonly PhysicsConstraint[];
}>;

export type PhysicsValidationReport = Readonly<{
  format: "workspace-physics-report";
  version: typeof WORKSPACE_PHYSICS_VERSION;
  model: "quasi_static_rigid_support_v2";
  workspaceId: string;
  workspaceRevision: number;
  feasible: boolean;
  bodies: readonly PhysicsBodyReport[];
  issues: readonly PhysicsIssue[];
}>;

export type PhysicsSettleProposal = Readonly<{
  componentId: string;
  from: ComponentPlacement;
  to: ComponentPlacement;
  dropDistanceM: number;
  settled: boolean;
}>;

export type PhysicsSettleResult = Readonly<{
  format: "workspace-physics-settle";
  version: typeof WORKSPACE_PHYSICS_VERSION;
  model: "quasi_static_vertical_drop_v2";
  workspaceId: string;
  workspaceRevision: number;
  durationMs: number;
  timeStepMs: number;
  appliedSteps: number;
  modeledProperties: readonly ["gravity_scale", "solid_collision_geometry", "grounded_supports", "fixed_step_time"];
  ignoredProperties: readonly ["mass_kg", "friction", "restitution", "angular_motion"];
  mutatesWorkspace: false;
  feasible: boolean;
  proposals: readonly PhysicsSettleProposal[];
  report: PhysicsValidationReport;
}>;
