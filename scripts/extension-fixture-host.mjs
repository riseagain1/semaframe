import process from "node:process";
import { fixtureSupportValue } from "./extension-fixture-support.mjs";

const PROTOCOL = "semaframe.extension.native/1";
const mode = process.argv[2] ?? "normal";
let buffer = Buffer.alloc(0);
let capability = "";
let pendingHostCall = null;

function send(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  frame.set(payload, 4);
  process.stdout.write(frame);
}

function response(id, result) {
  send({ protocol: PROTOCOL, type: "response", id, capability, result });
}

function failure(id, code, message) {
  send({ protocol: PROTOCOL, type: "response", id, capability, error: { code, message } });
}

function onRequest(message) {
  capability = message.capability;
  if (message.method === "initialize") {
    response(message.id, {
      apiVersion: message.params.apiVersion,
      protocol: message.params.protocol,
      extensionId: message.params.extensionId,
      extensionVersion: message.params.extensionVersion,
      manifestSha256: message.params.manifestSha256,
      providerIds: message.params.providers.map((provider) => provider.id),
    });
    return;
  }
  if (message.method === "shutdown") {
    response(message.id, { closed: true });
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (message.method !== "provider.invoke") {
    failure(message.id, "method_not_found", "Fixture method is unavailable.");
    return;
  }
  const providerMethod = message.params.method;
  const fixtureAction = providerMethod === "read" && typeof message.params.input?.fixtureAction === "string"
    ? message.params.input.fixtureAction
    : providerMethod;
  const fixturePayload = providerMethod === "read" && Object.hasOwn(message.params.input ?? {}, "payload")
    ? message.params.input.payload
    : message.params.input;
  if (fixtureAction === "echo") {
    response(message.id, fixturePayload);
    return;
  }
  if (fixtureAction === "environment") {
    response(message.id, {
      hasHome: Object.hasOwn(process.env, "HOME"),
      hasPath: Object.hasOwn(process.env, "PATH"),
      protocol: process.env.SEMAFRAME_EXTENSION_PROTOCOL ?? null,
      custom: process.env.SEMAFRAME_EXTENSION_FIXTURE ?? null,
      support: fixtureSupportValue,
      cwd: process.cwd(),
    });
    return;
  }
  if (fixtureAction === "host_call") {
    pendingHostCall = message.id;
    send({
      protocol: PROTOCOL,
      type: "request",
      id: "x_1",
      capability,
      method: "fixture.reflect",
      params: fixturePayload,
    });
    return;
  }
  if (fixtureAction === "hang") return;
  if (fixtureAction === "oversize") {
    response(message.id, { text: "x".repeat(2 * 1024 * 1024) });
    return;
  }
  if (fixtureAction === "malformed") {
    const payload = Buffer.from("{not json", "utf8");
    const frame = Buffer.allocUnsafe(payload.byteLength + 4);
    frame.writeUInt32BE(payload.byteLength, 0);
    frame.set(payload, 4);
    process.stdout.write(frame);
    return;
  }
  if (fixtureAction === "stderr_flood") {
    process.stderr.write("x".repeat(64 * 1024));
    return;
  }
  if (providerMethod === "probe") {
    response(message.id, { available: true });
    return;
  }
  if (mode === "error") {
    failure(message.id, "fixture_error", "Requested fixture failure.");
    return;
  }
  failure(message.id, "method_not_found", "Fixture provider method is unavailable.");
}

function onMessage(message) {
  if (!message || message.protocol !== PROTOCOL || message.capability !== capability && capability) {
    process.exit(91);
    return;
  }
  if (message.type === "request") {
    onRequest(message);
    return;
  }
  if (message.type === "response" && message.id === "x_1" && pendingHostCall) {
    const original = pendingHostCall;
    pendingHostCall = null;
    if (Object.hasOwn(message, "result")) response(original, { hostResult: message.result });
    else failure(original, "host_call_failed", message.error?.message ?? "Host call failed.");
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  while (buffer.byteLength >= 4) {
    const length = buffer.readUInt32BE(0);
    if (length < 2 || length > 16 * 1024 * 1024) process.exit(92);
    if (buffer.byteLength < length + 4) return;
    const payload = buffer.subarray(4, length + 4);
    buffer = buffer.subarray(length + 4);
    try {
      onMessage(JSON.parse(payload.toString("utf8")));
    } catch {
      process.exit(93);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
