import { createHash } from "node:crypto";

/** Uses the public MCP surface and the real browser importer/CAD Worker. Synthetic geometry only. */
export async function runPrecisionAgentSmoke({ call, session, cdp, captureSavedProject, rememberSensitive }) {
  const ask = async (name, input = {}) => {
    console.log(`Precision browser check: ${name}${input.action ? `/${input.action}` : ""}`);
    const result = await call(name, { ...session, ...input });
    if (!result.ok) throw new Error(`Precision smoke ${name}/${input.action ?? "default"}: ${result.error?.code ?? "invalid response"}`);
    return result.data;
  };
  const commit = async (intent, count, operations) => {
    const prepared = await ask("begin_workspace_update", { intent, ...(count > 0 ? { requested_component_ids: count } : {}) });
    rememberSensitive(prepared.transaction_token);
    const ops = operations(prepared);
    return ask("submit_workspace_batch", { transaction_token: prepared.transaction_token, batch: { ...prepared.envelope, operations: ops } });
  };
  const ref = (prepared, typeId) => {
    const manifest = prepared.capability_manifest.component_types.find((item) => item.typeId === typeId);
    if (!manifest) throw new Error(`Missing precision capability ${typeId}`);
    return { typeId, version: manifest.version, digest: manifest.digest };
  };
  const vertices = Array.from({ length: 36 }, (_, index) => [index % 6 / 5, Math.floor(index / 6) / 5, 0]);
  const faces = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    const a = y * 6 + x + 1; faces.push([a, a + 1, a + 6], [a + 1, a + 7, a + 6]);
  }
  const bytes = Buffer.from([...vertices.map((v) => `v ${v.join(" ")}`), ...faces.map((f) => `f ${f.join(" ")}`), ""].join("\n"));
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const workspace = await ask("inspect_workspace");
  const grant = await ask("begin_workspace_asset_import", { request_id: "precision_smoke_source", workspace_id: workspace.workspace_id,
    display_name: "Synthetic precision plate.obj", format: "obj", media_type: "model/obj", purpose: "measurement_source", byte_length: bytes.length, sha256 });
  rememberSensitive(grant.upload?.token, grant.candidate_handle);
  if (!grant.upload?.url) throw new Error("Measurement source upload grant missing");
  const upload = await fetch(grant.upload.url, { method: "PUT", headers: { Authorization: `Bearer ${grant.upload.token}`, "Content-Type": grant.upload.content_type }, body: bytes });
  if (!upload.ok) throw new Error(`Measurement source upload rejected (${upload.status})`);
  const completion = await ask("complete_workspace_asset_import", { candidate_handle: grant.candidate_handle });
  const studyId = completion.result?.component_id;
  if (!studyId) throw new Error("Measurement import did not create a precision-study");
  const preparedSource = await ask("analyze_workspace_precision", { component_id: studyId, action: "prepare_source",
    options: { sourceDigest: sha256, format: "obj", units: "metre", coordinateBasis: "RUB", provenance: "Synthetic exact SI fixture, not physical measurements" } });
  const document = preparedSource.document;
  document.policy = { ...document.policy, intendedUse: "Synthetic software acceptance only", toleranceM: 0.001,
    minimumIndependentChecks: 3, requiredRegions: ["plate"], uncertaintyBasis: "Known synthetic coordinates", surfaceUncertaintyM: 0.0001, surfaceUncertaintyBasis: "Synthetic plane; no physical claim" };
  document.checks = [0, 5, 35].map((vertexIndex, index) => ({ id: `heldout-${index}`, vertexIndex, referencePointM: vertices[vertexIndex], uncertaintyM: 0.00001,
    provenance: "Independent fixture generator coordinates; synthetic", regionId: "plate" }));
  await commit("Admit synthetic plate and independent checks", 0, () => [{ op: "update_component", op_id: "admit_source", id: studyId, patch: { props: { document } } }]);
  const inspected = await ask("analyze_workspace_precision", { component_id: studyId });
  if (inspected.analysis?.report?.status !== "pass_for_scope") throw new Error("Exact independent fixture did not pass its declared scope");
  const proposal = await ask("analyze_workspace_precision", { component_id: studyId, action: "propose_plate", options: {
    partId: "precision_smoke_plate", toleranceM: 0.001, thicknessM: 0.02, thicknessProvenance: "Synthetic 20 mm thickness; absent from plane scan" } });
  const definition = proposal.analysis?.proposal?.definition;
  if (!definition) throw new Error("Host did not produce an editable plate proposal");
  let cadId;
  const world = { space: "world3d", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  await commit("Evaluate scan-derived plate through real browser CAD Worker", 2, (prepared) => {
    const [stageId, targetId] = prepared.reserved_component_ids; cadId = targetId;
    return [{ op: "create_component", op_id: "precision_stage", id: stageId, component_type: ref(prepared, "stage-3d"), placement: world },
      { op: "create_component", op_id: "precision_cad", id: targetId, component_type: ref(prepared, "cad-part"), placement: world,
        props: { definition }, label: "Synthetic editable plate" }];
  });
  const comparison = await ask("analyze_workspace_precision", { component_id: studyId, action: "compare_cad", options: { targetComponentId: cadId } });
  if (!comparison.comparison?.sourceToCad || comparison.comparison.status === "pass_for_scope") throw new Error("Extra CAD thickness was incorrectly certified by planar scan checks");
  const cadInspection = await ask("inspect_workspace_component", { component_id: cadId });
  if (!cadInspection.component?.props?.evaluation) throw new Error("CAD proposal lacks actual host evaluation");
  let current = await ask("inspect_workspace");
  await ask("undo_workspace_batch", { expected_workspace_revision: current.workspace_revision });
  current = await ask("inspect_workspace");
  await ask("redo_workspace_batch", { expected_workspace_revision: current.workspace_revision });
  const comparedAgain = await ask("analyze_workspace_precision", { component_id: studyId, action: "compare_cad", options: { targetComponentId: cadId } });
  if (comparedAgain.comparison.dependencyDigest !== comparison.comparison.dependencyDigest) throw new Error("Undo/redo changed precision comparison inputs");
  const saved = JSON.parse(await captureSavedProject(cdp));
  const savedStudy = saved.workspace.components.find(([id]) => id === studyId)?.[1];
  if (savedStudy?.props.document.geometry.source.sha256 !== sha256 || savedStudy?.props.evidenceSources[0]?.digest !== sha256) throw new Error("Saved project dropped measurement provenance or geometry");
  // Mutate coordinates without changing the alleged original SHA: the host must catch it.
  const forged = structuredClone(document); forged.geometry.positions[1][2] = 0.002;
  await commit("Exercise provenance mismatch failure path", 0, () => [{ op: "update_component", op_id: "mismatch", id: studyId, patch: { props: { document: forged } } }]);
  const rejected = await call("analyze_workspace_precision", { ...session, component_id: studyId });
  if (rejected.ok || rejected.error?.code !== "precision_source_geometry_mismatch") throw new Error("Modified coordinates kept an authenticated original-source claim");
  current = await ask("inspect_workspace");
  await ask("undo_workspace_batch", { expected_workspace_revision: current.workspace_revision });
  await ask("analyze_workspace_precision", { component_id: studyId });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const previewDeadline = Date.now() + 8_000;
  while (Date.now() < previewDeadline && !await cdp.evaluate("Boolean(document.querySelector('.precision-study__webgl.is-ready canvas'))")) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!await cdp.evaluate("Boolean(document.querySelector('.precision-study__webgl.is-ready canvas'))")) throw new Error("Measurement mesh preview did not create a real browser WebGL canvas");
  const previewLayout = await cdp.evaluate(`(() => {
    const card = document.querySelector('.workspace-projected-component .precision-study');
    const host = card?.querySelector('.precision-study__webgl');
    const canvas = host?.querySelector('canvas');
    const header = card?.querySelector('header');
    if (!host || !canvas || !header) return { missing: true };
    const h = host.getBoundingClientRect(), c = canvas.getBoundingClientRect(), title = header.getBoundingClientRect();
    const hit = document.elementFromPoint(title.x + title.width / 2, title.y + title.height / 2);
    return { canvasHeight: c.height, hostHeight: h.height,
      escaped: c.x < h.x - 1 || c.y < h.y - 1 || c.right > h.right + 1 || c.bottom > h.bottom + 1,
      headerCoveredByCanvas: hit === canvas, headerBeforePreview: title.bottom <= h.top + 1 };
  })()`);
  if (previewLayout.missing || previewLayout.escaped || previewLayout.headerCoveredByCanvas || !previewLayout.headerBeforePreview
    || previewLayout.canvasHeight < 100 || previewLayout.canvasHeight > 220) throw new Error(`Precision preview obscures its report: ${JSON.stringify(previewLayout)}`);
  // Exercise the separate human authoring path too: its placement must retain
  // the measured working frame, not a default cosmetic component-grid offset.
  await commit("Move first fixture aside before human Inspector creation", 0, () => [{ op: "place_component", op_id: "move_test_cad", id: cadId,
    placement: { ...world, position: { x: 10, y: 0, z: 0 } } }]);
  console.log("Precision browser check: human Inspector inputs");
  const click = (label) => cdp.call(`function(label) {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
    if (!button || button.disabled) return false; button.click(); return true;
  }`, label);
  if (!await click("Inspector")) throw new Error("Precision Inspector unavailable");
  const inspectorDeadline = Date.now() + 8_000;
  while (Date.now() < inspectorDeadline && !await cdp.evaluate("Boolean(document.querySelector('.precision-study--inspector'))")) await new Promise((resolve) => setTimeout(resolve, 100));
  const editedInputs = await cdp.evaluate(`(() => {
    const inspector = document.querySelector('.precision-study--inspector'); if (!inspector) return false;
    const summary = [...inspector.querySelectorAll('summary')].find((item) => item.textContent === 'Fit editable CAD proposal');
    if (!summary) return false; summary.click();
    for (const [label, value] of [['Measured plate thickness (metres)', '0.02'], ['Thickness measurement provenance', 'Synthetic browser fixture; not physical evidence']]) {
      const input = [...inspector.querySelectorAll('label')].find((item) => item.textContent.startsWith(label))?.querySelector('input');
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new Event('change', {bubbles: true}));
    } return true;
  })()`);
  if (!editedInputs || !await click("Propose fitted plate")) throw new Error("Human plate proposal inputs were not usable");
  const proposalDeadline = Date.now() + 8_000;
  while (Date.now() < proposalDeadline && !await cdp.evaluate("Boolean(document.querySelector('.precision-study__proposal'))")) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!await click("Create editable CAD proposal")) throw new Error("Human editable CAD action unavailable");
  console.log("Precision browser check: human CAD evaluation and save");
  const humanDeadline = Date.now() + 35_000;
  while (Date.now() < humanDeadline && await cdp.evaluate("Boolean(document.querySelector('.precision-study--inspector'))")) await new Promise((resolve) => setTimeout(resolve, 100));
  const humanSaved = JSON.parse(await captureSavedProject(cdp));
  const humanCad = humanSaved.workspace.components.map(([, component]) => component).find((component) => component.type.typeId === "cad-part" && component.id !== cadId);
  if (!humanCad || humanCad.placement.space !== "world3d" || !["x", "y", "z"].every((axis) =>
    humanCad.placement.position[axis] === 0 && humanCad.placement.rotation[axis] === 0 && humanCad.placement.scale[axis] === 1)
    || !humanCad.props.evaluation) throw new Error("Human-created precision CAD lost its measured frame or kernel evidence");
  await ask("analyze_workspace_precision", { component_id: studyId, action: "compare_cad", options: { targetComponentId: humanCad.id } });
  await click("Inspector");
  console.log("Precision browser MCP smoke passed: streamed OBJ -> retained source -> metric study -> held-out checks -> real OCCT editable CAD -> conservative bidirectional comparison -> undo/redo/save -> forged-provenance rejection -> human Inspector CAD creation in the same measured frame. Synthetic workflow evidence, not measured field accuracy.");
}
