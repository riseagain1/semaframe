const MAXIMUM_FRAME_BYTES = 1024 * 1024;
const unresolvedShutdown = process.argv.includes("--unresolved-shutdown");
const unresolvedDisarm = process.argv.includes("--unresolved-disarm");
const hangShutdown = process.argv.includes("--hang-shutdown");
const closeInputOnShutdown = process.argv.includes("--close-input-on-shutdown");
if (hangShutdown) setInterval(() => {}, 60_000).unref?.();
let buffer = Buffer.alloc(0);
let capability;
let activeStage;

function send(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]));
}

function respond(request) {
  const base = { jsonrpc: "2.0", id: request.id };
  if (request.method === "hello") {
    capability = request.capability;
    send({ ...base, result: { protocolVersion: 2, capability } });
    return;
  }
  if (request.capability !== capability) {
    send({ ...base, error: { code: "unauthorized", message: "invalid capability" } });
    return;
  }
  if (request.method === "health") {
    send({ ...base, result: { protocolVersion: 2, platform: "mock", accessibility: "authorized" } });
    return;
  }
  if (request.method === "prepare_accessibility") {
    send({ ...base, result: { protocolVersion: 2, platform: "mock", accessibility: "authorized" } });
    return;
  }
  if (request.method === "stage_draft") {
    activeStage = {
      targetId: request.params.targetId,
      stageId: request.params.stageId,
      expectedDraftDigest: request.params.expectedDraftDigest,
      targetGeneration: request.params.targetGeneration,
    };
    // Model the release-blocking case: the native operation completes, but
    // its acknowledgement arrives after the client timeout/AbortSignal.
    setTimeout(() => send({
      ...base,
      result: {
        outcome: "staged",
        verified: true,
        targetGeneration: request.params.targetGeneration,
      },
    }), 250);
    return;
  }
  if (request.method === "disarm") {
    send({ ...base, result: { armed: false, cleanupResolved: !unresolvedDisarm } });
    return;
  }
  if (request.method === "abort_stage") {
    const exact = activeStage
      && activeStage.targetId === request.params.targetId
      && activeStage.stageId === request.params.stageId
      && activeStage.expectedDraftDigest === request.params.expectedDraftDigest
      && activeStage.targetGeneration === request.params.targetGeneration;
    if (exact) activeStage = undefined;
    send({ ...base, result: { outcome: exact ? "cancelled" : "not_found" } });
    return;
  }
  if (request.method === "shutdown") {
    if (hangShutdown) {
      // Keep an active handle even after stdin EOF so the client must exercise
      // its bounded force-kill fallback.
      setInterval(() => {}, 60_000);
      return;
    }
    send({ ...base, result: { closed: true, cleanupResolved: !unresolvedShutdown } });
    if (closeInputOnShutdown) process.stdin.destroy();
    process.stdin.pause();
    setTimeout(() => process.exit(0), 0);
    return;
  }
  send({ ...base, error: { code: "method_not_found", message: "unknown method" } });
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (length < 2 || length > MAXIMUM_FRAME_BYTES) process.exit(2);
    if (buffer.length < length + 4) return;
    const payload = buffer.subarray(4, length + 4);
    buffer = buffer.subarray(length + 4);
    respond(JSON.parse(payload.toString("utf8")));
  }
});
