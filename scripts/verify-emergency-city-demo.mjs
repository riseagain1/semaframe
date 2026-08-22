import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const captureRoot = resolve("video/public/emergency-city");
const evidencePath = join(captureRoot, "evidence.json");
const plannerRoot = join(captureRoot, "planner/final");
const videoPath = resolve("artifacts/semaframe-emergency-city-hero.mp4");
const posterPath = resolve("artifacts/semaframe-emergency-city-poster.png");
const audioPath = resolve("video/public/audio/semaframe-emergency-city-hero.wav");
const verificationPath = resolve("artifacts/semaframe-emergency-city-verification.json");
const schemaPath = resolve("scripts/emergency-city-plan.schema.json");
const FRAME_CONTRACT = Object.freeze({
  "crisis-frames": 120,
  "prompt-frames": 60,
  "understand-frames": 90,
  "collision-frames": 120,
  "plan-frames": 90,
  "response-frames": 300,
  "undo-redo-frames": 90,
  "reopen-frames": 90,
  "final-frames": 150,
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashJSON(value) {
  return sha256(canonicalJSON(value));
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function readJSON(path) {
  invariant(existsSync(path), `Missing JSON artifact: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function probe(path, countFrames = false) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    ...(countFrames ? ["-count_frames"] : []),
    "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_read_frames,sample_rate,channels,color_range,color_space,color_transfer,color_primaries",
    "-of", "json",
    path,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffprobe failed for ${path}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function measureLoudness(path) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-nostats", "-i", path,
    "-vn", "-af", "ebur128=peak=true", "-f", "null", "-",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Loudness measurement failed: ${result.stderr}`);
  const integrated = [...result.stderr.matchAll(/I:\s*(-?[0-9.]+)\s+LUFS/gu)].at(-1);
  const range = [...result.stderr.matchAll(/LRA:\s*([0-9.]+)\s+LU/gu)].at(-1);
  const peak = [...result.stderr.matchAll(/Peak:\s*(-?[0-9.]+)\s+dBFS/gu)].at(-1);
  invariant(integrated && range && peak, "ffmpeg did not report complete EBU R128 measurements.");
  return {
    integratedLufs: Number(integrated[1]),
    loudnessRangeLu: Number(range[1]),
    truePeakDbfs: Number(peak[1]),
  };
}

const evidence = readJSON(evidencePath);
invariant(evidence.syntheticBaseline === true, "The city baseline must be explicitly synthetic.");
invariant(evidence.workspace?.componentCount >= 90, "The capture must contain the complete editable miniature city.");
invariant(evidence.workspace?.atomicBuildOperationCount <= 100, "The city build must remain within the atomic protocol batch limit.");

invariant(evidence.dispatchSnapshot?.connectorType === "inline.snapshot", "The demo must use the deterministic inline snapshot connector.");
invariant(evidence.dispatchSnapshot?.authorizedScope === true, "The capture must prove explicit effect:data_read authorization.");
invariant(evidence.dispatchSnapshot?.snapshotAuthority === "host_normalized", "The dispatch snapshot must be host-normalized.");
invariant(evidence.dispatchSnapshot?.readWasNonMutating === true, "The snapshot read must leave Workspace revision unchanged.");
invariant(evidence.dispatchSnapshot?.initialEtaSeconds === 28, "The opening ETA must match the captured snapshot.");
invariant(evidence.dispatchSnapshot?.initialClearanceM === 1.6, "The opening clearance must match the captured snapshot.");
invariant(evidence.dispatchSnapshot?.requiredClearanceM === 3.2, "The required clearance must match the captured snapshot.");
invariant(evidence.dispatchSnapshot?.finalEtaSeconds === 11, "The resolved ETA must match the final snapshot.");
invariant(evidence.dispatchSnapshot?.finalClearanceM === 3.8, "The resolved clearance must match the final snapshot.");
invariant(evidence.dispatchSnapshot?.finalOutcomeAuthority === "deterministic_synthetic_scenario", "The final feed state must identify its synthetic scenario authority.");
invariant(evidence.dispatchSnapshot?.finalOutcomeGeometryDerived === false, "The demo must not claim that ETA/clearance were derived from vehicle dynamics.");

invariant(evidence.rejectedEndpoint?.errorCode === "spatial_collision", "The unsafe endpoint must fail with spatial_collision.");
invariant(evidence.rejectedEndpoint?.atomic === true, "The rejected endpoint must not change Workspace revision.");
invariant(evidence.rejectedEndpoint?.preflightValid === false, "The unsafe endpoint preflight must be invalid.");
invariant((evidence.rejectedEndpoint?.conflicts ?? []).length > 0, "The rejected endpoint must record at least one real conflict.");

const plannerContext = readJSON(join(plannerRoot, "planner-context.json"));
const plan = readJSON(join(plannerRoot, "emergency-plan.json"));
const plannerManifest = readJSON(join(plannerRoot, "planner-run.json"));
const truthWindow = readJSON(join(plannerRoot, "truth-window-events.json"));
const hostValidationReceipt = readJSON(join(plannerRoot, "host-validation-receipt.json"));
const schema = readJSON(schemaPath);
const rawTrace = readFileSync(join(plannerRoot, "codex-trace.raw.jsonl"), "utf8");
const traceEvents = rawTrace.trim().split(/\r?\n/u).map((line) => JSON.parse(line));

invariant(plannerManifest.mode === "live_codex", "The delivered plan must come from a live Codex run.");
invariant(plannerManifest.live_model === true, "The delivered planner manifest must mark a live model.");
invariant(plannerManifest.hardcoded_fallback === false, "The live planner must not have a hardcoded fallback.");
invariant(plannerManifest.safety?.automatic_fixture_fallback === false, "The planner must prohibit automatic fixture fallback.");
invariant(plannerManifest.safety?.model_working_directory_isolated_from_repository === true, "The planner must be isolated from repository files.");
invariant(plannerManifest.safety?.model_tool_use_allowed === false, "The model planner must not use tools.");
invariant(truthWindow.live_model === true, "The truth window must identify a live model run.");
invariant(traceEvents.length > 0, "The live Codex JSONL trace must not be empty.");
invariant(truthWindow.events?.some((event) => event.status === "schema_valid_preflight_pending"), "Planner truth must stop at schema acceptance pending host preflight.");

invariant(plannerManifest.hashes.context === hashJSON(plannerContext), "Planner context SHA-256 mismatch.");
invariant(plannerManifest.hashes.output_schema === hashJSON(schema), "Planner schema SHA-256 mismatch.");
invariant(plannerManifest.hashes.plan === hashJSON(plan), "Planner plan SHA-256 mismatch.");
invariant(plannerManifest.hashes.raw_trace === sha256(rawTrace), "Planner raw trace SHA-256 mismatch.");
invariant(plannerManifest.hashes.truth_window_events === hashJSON(truthWindow), "Planner truth-window SHA-256 mismatch.");
const recomputedRunHash = hashJSON({
  mode: plannerManifest.mode,
  live_model: plannerManifest.live_model,
  model: plannerManifest.model,
  context_hash: plannerManifest.hashes.context,
  schema_hash: plannerManifest.hashes.output_schema,
  prompt_hash: plannerManifest.hashes.prompt,
  plan_hash: plannerManifest.hashes.plan,
  trace_hash: plannerManifest.hashes.raw_trace,
});
invariant(plannerManifest.run_hash === recomputedRunHash, "Planner run hash mismatch.");
invariant(canonicalJSON(plan.source) === canonicalJSON({
  workspace_id: plannerContext.authority.workspace_id,
  workspace_revision: plannerContext.authority.workspace_revision,
  registry_digest: plannerContext.authority.registry_digest,
  dispatch_snapshot_hash: plannerContext.authority.dispatch_snapshot_hash,
}), "Plan source must exactly match the authoritative context.");

invariant(evidence.planner?.mode === "live_codex" && evidence.planner?.liveModel === true, "Capture evidence must identify the live planner.");
invariant(evidence.planner?.hardcodedFallback === false, "Capture evidence must prove there was no hardcoded fallback.");
invariant(evidence.planner?.runId === plannerManifest.run_id, "Capture evidence planner run ID mismatch.");
invariant(evidence.planner?.runHash === plannerManifest.run_hash, "Capture evidence planner run hash mismatch.");
invariant(evidence.planner?.vehicleToBayAssignmentSupplied === false, "The host must not supply a vehicle-to-bay assignment.");
invariant(evidence.planner?.safeBayCandidateRegionsSupplied === true, "Evidence must disclose host-supplied safe-bay regions.");
invariant(evidence.planner?.endpointCoordinatesAuthoredByModelWithinHostRegions === true, "Capture evidence must identify model-authored coordinates within host regions.");
invariant(evidence.planner?.requiredEffectsDefinedByHostMission === true, "Evidence must disclose the host-defined required effects.");
invariant(evidence.planner?.actionCountWasNotPresentedAsAnOpenDecision === true, "Evidence must not overstate action-count autonomy.");
invariant(evidence.planner?.hostMissionContractValidated === true, "The host mission contract must be validated.");
invariant(evidence.planner?.hostPreflightRevision === plan.source.workspace_revision, "Every endpoint must be preflighted at the plan source revision.");
invariant(evidence.planner?.preflightRevisionAfter === plan.source.workspace_revision, "Endpoint preflight must leave the plan revision unchanged.");
invariant(evidence.planner?.dispatchSnapshotReadRevision === plan.source.workspace_revision, "The dispatch snapshot must be re-read at the planner revision.");
invariant(evidence.planner?.dispatchSnapshotReadRegistryDigest === plan.source.registry_digest, "The planner snapshot read must use the source registry digest.");
invariant(evidence.planner?.successfulAttempt >= 1 && evidence.planner.successfulAttempt <= 3, "The successful live planner attempt must be bounded.");
invariant(evidence.planner?.hostValidationReceiptHash === hashJSON(hostValidationReceipt), "Host validation receipt SHA-256 mismatch.");
invariant(hostValidationReceipt.planner_run_id === plannerManifest.run_id, "Host validation receipt planner ID mismatch.");
invariant(hostValidationReceipt.planner_plan_hash === plannerManifest.hashes.plan, "Host validation receipt plan hash mismatch.");
invariant(hostValidationReceipt.all_endpoints_valid === true, "Host validation receipt must accept every endpoint.");

const safePreflights = evidence.validatedPlan?.safePreflights ?? [];
const modelMoveCount = plan.control.actions.filter((action) => action.action === "move_to").length;
const modelStateCount = plan.control.actions.filter((action) => action.action === "show" || action.action === "hide").length;
invariant(safePreflights.length === modelMoveCount, "Every model move endpoint must have one host preflight receipt.");
invariant(canonicalJSON(hostValidationReceipt.endpoint_receipts) === canonicalJSON(safePreflights), "Capture evidence and host endpoint receipts must match exactly.");
invariant(safePreflights.every((entry) => (
  entry.valid === true
  && entry.conflicts.length === 0
  && entry.workspaceId === plan.source.workspace_id
  && entry.workspaceRevision === plan.source.workspace_revision
  && entry.registryDigest === plan.source.registry_digest
)), "Every final model endpoint must pass same-revision spatial preflight.");
invariant(evidence.validatedPlan?.authoringSource === "codex_cli_live", "The compiled routes must be sourced from the live Codex plan.");
invariant(evidence.validatedPlan?.planActionCount === plan.control.actions.length, "The evidence action count must match the model plan.");
invariant(evidence.validatedPlan?.routeCount === plan.control.actions.length, "Every model action must compile to exactly one route.");

invariant(evidence.oneClickResponse?.pointerInput === true, "The response must come from a real pointer click.");
invariant(evidence.oneClickResponse?.revisionDelta === 1, "The entire response must commit in one revision.");
invariant(evidence.oneClickResponse?.pressEventCount === 1, "The capture must contain exactly one source press event.");
invariant(evidence.oneClickResponse?.movedEventCount === modelMoveCount, "The click must route every model move action.");
invariant(evidence.oneClickResponse?.routedVisibilityEventCount === modelStateCount, "The click must route every model scene-state action.");
invariant(evidence.oneClickResponse?.routedActionCount === plan.control.actions.length, "The real click fan-out must equal the model plan.");
invariant(evidence.undoRedo?.ambulanceRestored === true, "Undo/Redo must restore the model-selected ambulance endpoint.");

invariant(evidence.saveReopen?.realUiSave === true && evidence.saveReopen?.realUiOpen === true, "Save/Reopen must use the real file UI path.");
invariant(evidence.saveReopen?.savedRevision === evidence.saveReopen?.reopenedRevision, "Reopen must preserve revision.");
invariant(evidence.saveReopen?.savedComponentCount === evidence.saveReopen?.reopenedComponentCount, "Reopen must preserve components.");
invariant(evidence.saveReopen?.savedResourceCount === evidence.saveReopen?.reopenedResourceCount, "Reopen must preserve resources.");
invariant(evidence.saveReopen?.savedConnectionCount === evidence.saveReopen?.reopenedConnectionCount, "Reopen must preserve connections.");
invariant(evidence.saveReopen?.ambulanceEndpointRestored === true, "Reopen must restore the model-selected ambulance endpoint.");
invariant(evidence.saveReopen?.dispatchSnapshotRestored === true, "Reopen must restore the resolved dispatch snapshot.");
invariant(evidence.saveReopen?.modelRoutesRestoredExactly === true, "Reopen must preserve every compiled model route definition.");
invariant(evidence.saveReopen?.modelRouteCount === plan.control.actions.length, "Reopened route count must match the model plan.");
invariant(/^sha256:[a-f0-9]{64}$/u.test(evidence.saveReopen?.modelRoutesHash ?? ""), "Reopened route definitions must have an audit hash.");

invariant(evidence.validation?.collisionConflictCount === 0, "The reopened city must have zero collision conflicts.");
invariant(evidence.validation?.physicsFeasible === true, "The reopened bounded physics preflight must be feasible.");
invariant((evidence.validation?.physicsIssues ?? []).length === 0, "The reopened bounded physics preflight must have no issues.");

invariant(evidence.capture?.fps === 30, "The capture contract must be 30 fps.");
invariant(evidence.capture?.durationSeconds === 37, "The capture contract must be exactly 37 seconds.");
invariant(evidence.capture?.totalSourceFrames === 1_110, "The capture must contain 1110 one-to-one source frames.");
invariant(evidence.capture?.sourceFrameMapping === "one_source_image_per_30fps_output_frame", "The final edit must use one source image per output frame.");
invariant(evidence.capture?.webgl?.contextLost === false, "The capture must finish with a healthy WebGL context.");
invariant(evidence.capture?.stabilization === "two_requestAnimationFrame_then_webgl_finish_before_each_capture", "Every source frame must cross the render stabilization barrier.");
invariant(canonicalJSON(evidence.capture?.frameCounts) === canonicalJSON(FRAME_CONTRACT), "Evidence frame counts must exactly match the V2 contract.");
const visualLayers = evidence.capture?.visualLayersM;
invariant(visualLayers?.plinthTopY - visualLayers?.stageGroundTopY >= 0.2, "The city plinth must be physically separated from the stage ground.");
invariant(visualLayers?.roadMainY - visualLayers?.plinthTopY >= visualLayers?.minimumOverlappingSurfaceGapM, "The main road must be separated from the plinth to prevent z-fighting.");
invariant(visualLayers?.routeBlockedY - visualLayers?.roadCrossY >= visualLayers?.minimumOverlappingSurfaceGapM, "The blocked route must be separated from the crossing road.");
invariant(visualLayers?.routeOpenY - visualLayers?.routeBlockedY >= visualLayers?.minimumOverlappingSurfaceGapM, "The open and blocked route surfaces must not be coplanar.");

for (const [folder, expectedCount] of Object.entries(FRAME_CONTRACT)) {
  const path = join(captureRoot, folder);
  invariant(existsSync(path), `Missing capture folder ${folder}.`);
  const frames = readdirSync(path).filter((name) => /^frame-\d{4}\.jpg$/u.test(name)).sort();
  invariant(frames.length === expectedCount, `${folder} has ${frames.length} frames; expected ${expectedCount}.`);
  invariant(frames[0] === "frame-0000.jpg", `${folder} must start at frame-0000.jpg.`);
  invariant(frames.at(-1) === `frame-${String(expectedCount - 1).padStart(4, "0")}.jpg`, `${folder} must end on the contracted frame.`);
  for (const sample of [frames[0], frames.at(-1)]) {
    const still = probe(join(path, sample));
    const stream = still.streams?.find((entry) => entry.codec_type === "video");
    invariant(stream?.codec_name === "mjpeg" && stream.width === 1920 && stream.height === 1080, `${folder}/${sample} must be a decodable 1920x1080 JPEG.`);
  }
}

invariant(existsSync(audioPath), `Missing generated score: ${audioPath}`);
const audio = probe(audioPath);
invariant(Math.abs(Number(audio.format?.duration) - 37) < 0.05, "The generated score must be exactly 37 seconds.");
invariant(audio.streams?.some((stream) => stream.codec_type === "audio" && stream.sample_rate === "48000" && stream.channels === 2), "The score must be 48 kHz stereo audio.");

invariant(existsSync(videoPath), `Missing rendered hero video: ${videoPath}`);
const video = probe(videoPath, true);
const videoStream = video.streams?.find((stream) => stream.codec_type === "video");
const audioStream = video.streams?.find((stream) => stream.codec_type === "audio");
invariant(videoStream?.codec_name === "h264", "The hero video must use H.264.");
invariant(videoStream?.width === 1920 && videoStream?.height === 1080, "The hero video must be 1920x1080.");
invariant(videoStream?.pix_fmt === "yuv420p", "The hero video must use yuv420p.");
invariant(videoStream?.r_frame_rate === "30/1" && videoStream?.avg_frame_rate === "30/1", "The hero video must be constant 30 fps.");
invariant(Number(videoStream?.nb_read_frames) === 1_110, "The hero video must contain exactly 1110 decoded frames.");
invariant(videoStream?.color_range === "tv" && videoStream?.color_space === "bt709", "The hero video must be tagged BT.709 limited range.");
invariant(Math.abs(Number(video.format?.duration) - 37) < 0.15, "The hero video must be 37 seconds.");
invariant(audioStream?.codec_type === "audio" && audioStream.sample_rate === "48000" && audioStream.channels === 2, "The hero video must contain 48 kHz stereo audio.");
const loudness = measureLoudness(videoPath);
invariant(loudness.integratedLufs >= -16.5 && loudness.integratedLufs <= -15.5, `Integrated loudness ${loudness.integratedLufs} LUFS is outside the -16 LUFS delivery window.`);
invariant(loudness.loudnessRangeLu >= 4 && loudness.loudnessRangeLu <= 9, `Loudness range ${loudness.loudnessRangeLu} LU is outside the cinematic 4-9 LU window.`);
invariant(loudness.truePeakDbfs <= -1, `True peak ${loudness.truePeakDbfs} dBFS exceeds the -1 dBTP ceiling.`);

invariant(existsSync(posterPath), `Missing rendered hero poster: ${posterPath}`);
const poster = probe(posterPath);
const posterStream = poster.streams?.find((stream) => stream.codec_type === "video");
invariant(posterStream?.width === 1920 && posterStream?.height === 1080, "The hero poster must be 1920x1080.");

const verification = {
  verificationVersion: "2.0",
  verifiedAt: new Date().toISOString(),
  planner: {
    runId: plannerManifest.run_id,
    runHash: plannerManifest.run_hash,
    model: plannerManifest.model,
    actionCount: plan.control.actions.length,
    moveCount: modelMoveCount,
    stateActionCount: modelStateCount,
    liveModel: true,
    hardcodedFallback: false,
  },
  workspace: {
    revision: evidence.workspace.revision,
    componentCount: evidence.workspace.componentCount,
    collisionConflicts: evidence.validation.collisionConflictCount,
    physicsFeasible: evidence.validation.physicsFeasible,
    saveReopenPreserved: true,
  },
  media: {
    durationSeconds: Number(video.format.duration),
    decodedFrames: Number(videoStream.nb_read_frames),
    codec: videoStream.codec_name,
    pixelFormat: videoStream.pix_fmt,
    loudness,
  },
  hashes: {
    captureEvidence: hashFile(evidencePath),
    plannerRun: hashFile(join(plannerRoot, "planner-run.json")),
    video: hashFile(videoPath),
    poster: hashFile(posterPath),
    score: hashFile(audioPath),
  },
};
writeFileSync(verificationPath, `${JSON.stringify(verification, null, 2)}\n`);
console.log("Emergency-city hero V2 verification passed.");
console.log(JSON.stringify(verification, null, 2));
