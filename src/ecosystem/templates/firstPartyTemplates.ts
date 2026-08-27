import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import {
  parseTemplateDescriptor,
  type ModelTemplateDescriptor,
  type ProjectTemplateDescriptor,
} from "../catalog";

function projectDescriptor(value: unknown): ProjectTemplateDescriptor {
  const descriptor = parseTemplateDescriptor(value);
  if (descriptor.kind !== "project") throw new TypeError("Expected a project template descriptor");
  return descriptor;
}

function modelDescriptor(value: unknown): ModelTemplateDescriptor {
  const descriptor = parseTemplateDescriptor(value);
  if (descriptor.kind !== "model") throw new TypeError("Expected a model template descriptor");
  return descriptor;
}

export const FIRST_PARTY_PROJECT_TEMPLATES: readonly ProjectTemplateDescriptor[] = Object.freeze([
  projectDescriptor({
    schemaVersion: "1",
    kind: "project",
    id: "first-party.decision-board",
    version: "1.0.0",
    title: "Decision board",
    summary: "A small evidence, decision, and next-actions workspace.",
    license: "Apache-2.0",
    minimumAppVersion: "0.4.0-rc.1",
    requiredPermissions: ["workspace:write", "component:create"],
    newProject: { suggestedTitle: "Decision board" },
    operations: [{
      op: "create_component",
      op_id: "create_context",
      id: "CONTEXT",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("text"),
      placement: { space: "viewport", anchor: "center", offset: { x: -360, y: 0 } },
      props: { text: "Context and evidence" },
    }, {
      op: "create_component",
      op_id: "create_decision",
      id: "DECISION",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("text"),
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 } },
      props: { text: "Decision" },
    }, {
      op: "create_component",
      op_id: "create_next_actions",
      id: "NEXT_ACTIONS",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("checklist"),
      placement: { space: "viewport", anchor: "center", offset: { x: 360, y: 0 } },
      props: { title: "Next actions" },
    }],
  }),
]);

export const FIRST_PARTY_MODEL_TEMPLATES: readonly ModelTemplateDescriptor[] = Object.freeze([
  modelDescriptor({
    schemaVersion: "1",
    kind: "model",
    id: "first-party.reference-block",
    version: "1.0.0",
    title: "Reference block",
    summary: "A neutral one-metre primitive for spatial scale and composition checks.",
    license: "CC0-1.0",
    minimumAppVersion: "0.4.0-rc.1",
    requiredPermissions: ["workspace:write", "component:create", "component:update"],
    operations: [{
      op: "create_component",
      op_id: "create_reference_stage",
      id: "REFERENCE_STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }, {
      op: "create_component",
      op_id: "create_reference_assembly",
      id: "REFERENCE_ASSEMBLY",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("model-assembly"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      props: { description: "One-metre reference block", collisionPolicy: "external_only" },
    }, {
      op: "create_component",
      op_id: "create_reference_block",
      id: "REFERENCE_BLOCK",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0.5, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      parent_id: "REFERENCE_ASSEMBLY",
      props: { geometry: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } } },
    }, {
      op: "publish_model",
      op_id: "publish_reference_block",
      model_id: "first-party.reference-block",
      version: "1.0.0",
      display_name: "Reference block",
      root_id: "REFERENCE_ASSEMBLY",
    }],
  }),
]);

export const FIRST_PARTY_TEMPLATE_DESCRIPTORS = Object.freeze([
  ...FIRST_PARTY_PROJECT_TEMPLATES,
  ...FIRST_PARTY_MODEL_TEMPLATES,
]);
