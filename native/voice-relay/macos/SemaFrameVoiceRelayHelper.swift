import Foundation
import AppKit
import ApplicationServices
import CryptoKit
import Darwin

private let protocolVersion = 2
private let maximumFrameBytes = 1_048_576
private let maximumTraversalNodes = 5_000
private let maximumTextCharacters = 20_000
private let maximumObservations = 128
private let observationRetentionSeconds: TimeInterval = 125
private let controlPairAmbiguityMargin = 24

private struct Candidate {
    let id: String
    let pid: pid_t
    let launchDate: Date
    let knownAgentSurface: Bool
    let appName: String
    let window: AXUIElement
    let windowTitle: String
    let composer: AXUIElement?
    let send: AXUIElement?
    let composerIdentity: ControlIdentity?
    let sendIdentity: ControlIdentity?
    let interactionRoot: AXUIElement?
    let responseRoot: AXUIElement?
    let responseRootIdentity: ControlIdentity?
}

private struct Profile {
    let targetId: String
    let generation: String
    let pid: pid_t
    let launchDate: Date
    let knownAgentSurface: Bool
    let label: String
    let window: AXUIElement
    let composer: AXUIElement
    let send: AXUIElement
    let composerIdentity: ControlIdentity
    let sendIdentity: ControlIdentity
    let interactionRoot: AXUIElement
    let responseRoot: AXUIElement?
    let responseRootIdentity: ControlIdentity?
}

private struct ControlIdentity: Equatable {
    let identifier: String
    let role: String
    let subrole: String
}

private struct ActiveStage {
    let stageId: String
    let digest: String
    let targetGeneration: String
}

private struct ActiveProbe {
    let digest: String
    let targetGeneration: String
}

private enum OwnedDraftCleanupOutcome {
    case none
    case cleared
    case humanChanged
    case unresolved

    var resolved: Bool {
        self != .unresolved
    }

    var unchangedOrEmpty: Bool {
        self == .none || self == .cleared
    }
}

private struct BoundControls {
    let composer: AXUIElement
    let send: AXUIElement
    let composerIdentity: ControlIdentity
    let sendIdentity: ControlIdentity
    let interactionRoot: AXUIElement
    let score: Int
}

private struct Observation {
    let id: String
    let baseline: ResponseSnapshot
    let sentDraft: String
    var lastText: String
    var sequence: Int
    var stableReads: Int
    var lastChange: Date
    let createdAt: Date
}

private enum ResponseMessageKind {
    case assistant
    case user
    case ambiguous
}

private struct ResponseMessage {
    let kind: ResponseMessageKind
    let text: String
}

private struct ResponseSnapshot {
    let messages: [String: ResponseMessage]
    let order: [String]
}

private final class RelayRuntime {
    private var capability: String?
    private var candidates: [String: Candidate] = [:]
    private var profile: Profile?
    private var armed = false
    private var activeStage: ActiveStage?
    private var activeProbe: ActiveProbe?
    private var observations: [String: Observation] = [:]
    var shouldExit = false

    func handle(_ value: Any) -> [String: Any] {
        guard let body = value as? [String: Any],
              body["jsonrpc"] as? String == "2.0",
              let id = body["id"] as? NSNumber,
              let suppliedCapability = body["capability"] as? String,
              let method = body["method"] as? String,
              let params = body["params"] as? [String: Any] else {
            return response(id: 0, error: "invalid_request", message: "Invalid helper request envelope.")
        }
        let requestId = id.intValue
        if method == "hello" {
            guard capability == nil,
                  isCapability(suppliedCapability),
                  params["protocolVersion"] as? Int == protocolVersion else {
                return response(id: requestId, error: "handshake_failed", message: "Helper handshake failed.")
            }
            capability = suppliedCapability
            return response(id: requestId, result: [
                "protocolVersion": protocolVersion,
                "capability": suppliedCapability,
            ])
        }
        guard suppliedCapability == capability else {
            return response(id: requestId, error: "unauthorized", message: "Helper capability is invalid.")
        }

        switch method {
        case "prepare_accessibility":
            // This RPC is reached only from the explicit desktop setup action.
            // Passive health/diagnostics below must never trigger an OS prompt.
            let promptOptions = [
                kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
            ] as CFDictionary
            let trusted = AXIsProcessTrustedWithOptions(promptOptions)
            return response(id: requestId, result: [
                "protocolVersion": protocolVersion,
                "platform": "macos",
                "accessibility": trusted ? "authorized" : "denied",
            ])
        case "health":
            return response(id: requestId, result: [
                "protocolVersion": protocolVersion,
                "platform": "macos",
                "accessibility": AXIsProcessTrusted() ? "authorized" : "denied",
            ])
        case "discover_targets":
            guard AXIsProcessTrusted() else {
                return response(id: requestId, result: ["targets": []])
            }
            let targets = discoverTargets()
            return response(id: requestId, result: ["targets": targets])
        case "configure_target":
            guard cleanupActiveDraftIfUnchanged() else {
                return response(id: requestId, error: "active_draft_changed", message: "The prior Agent draft changed and was preserved.")
            }
            guard let candidateId = safeIdentifier(params["candidateId"]),
                  let candidate = candidates[candidateId],
                  let composer = candidate.composer,
                  let send = candidate.send,
                  let composerIdentity = candidate.composerIdentity,
                  let sendIdentity = candidate.sendIdentity,
                  let interactionRoot = candidate.interactionRoot,
                  processIsSameLaunch(candidate.pid, candidate.launchDate),
                  validateBoundInteraction(
                    pid: candidate.pid,
                    knownAgentSurface: candidate.knownAgentSurface,
                    window: candidate.window,
                    composer: composer,
                    send: send,
                    composerIdentity: composerIdentity,
                    sendIdentity: sendIdentity,
                    interactionRoot: interactionRoot
                  ),
                  validateOptionalResponseRoot(
                    pid: candidate.pid,
                    window: candidate.window,
                    composer: composer,
                    interactionRoot: interactionRoot,
                    responseRoot: candidate.responseRoot,
                    responseRootIdentity: candidate.responseRootIdentity
                  ) else {
                return response(id: requestId, error: "target_incompatible", message: "Selected Agent target is unavailable or incompatible.")
            }
            let targetId = "target-\(UUID().uuidString.lowercased())"
            let label = boundedTargetLabel(
                appName: candidate.appName,
                windowTitle: candidate.windowTitle,
                composer: composer,
                send: send
            )
            let targetGeneration = "generation-\(UUID().uuidString.lowercased())"
            profile = Profile(
                targetId: targetId,
                generation: targetGeneration,
                pid: candidate.pid,
                launchDate: candidate.launchDate,
                knownAgentSurface: candidate.knownAgentSurface,
                label: label,
                window: candidate.window,
                composer: composer,
                send: send,
                composerIdentity: composerIdentity,
                sendIdentity: sendIdentity,
                interactionRoot: interactionRoot,
                responseRoot: candidate.responseRoot,
                responseRootIdentity: candidate.responseRootIdentity
            )
            armed = false
            activeStage = nil
            activeProbe = nil
            observations.removeAll(keepingCapacity: false)
            return response(
                id: requestId,
                result: targetWire(
                    targetId: targetId,
                    targetGeneration: targetGeneration,
                    label: label,
                    replyObservation: candidate.responseRoot != nil
                )
            )
        case "arm":
            guard let targetId = safeIdentifier(params["targetId"]),
                  let profile,
                  profile.targetId == targetId,
                  validate(profile) else {
                return response(id: requestId, error: "target_lost", message: "Configured Agent target is unavailable.")
            }
            armed = true
            return response(id: requestId, result: ["armed": true])
        case "disarm":
            let cleanup = cleanupOwnedDraft()
            armed = false
            observations.removeAll(keepingCapacity: false)
            return response(id: requestId, result: [
                "armed": false,
                "cleanupResolved": cleanup.resolved,
            ])
        case "test_draft_round_trip":
            return draftProbe(id: requestId, params: params)
        case "stage_draft":
            return stageDraft(id: requestId, params: params)
        case "abort_stage":
            return abortStage(id: requestId, params: params)
        case "confirm_draft":
            return confirmDraft(id: requestId, params: params)
        case "cancel_draft":
            return cancelDraft(id: requestId, params: params)
        case "read_reply":
            return readReply(id: requestId, params: params)
        case "shutdown":
            let cleanup = cleanupOwnedDraft()
            armed = false
            observations.removeAll(keepingCapacity: false)
            candidates.removeAll(keepingCapacity: false)
            // Keep the profile until cleanupBeforeExit so a transient native
            // failure gets one final exact cleanup attempt after the response.
            shouldExit = true
            return response(id: requestId, result: [
                "closed": true,
                "cleanupResolved": cleanup.resolved,
            ])
        default:
            return response(id: requestId, error: "method_not_found", message: "Unknown helper method.")
        }
    }

    private func discoverTargets() -> [[String: Any]] {
        let previousCandidates = Array(candidates.values)
        var nextCandidates: [String: Candidate] = [:]
        var reusedCandidateIds = Set<String>()
        var result: [[String: Any]] = []
        let ownPid = ProcessInfo.processInfo.processIdentifier
        for app in NSWorkspace.shared.runningApplications where result.count < 128 {
            let pid = app.processIdentifier
            guard pid != ownPid,
                  app.activationPolicy == .regular,
                  !app.isTerminated,
                  !isForbiddenApplication(app),
                  let launchDate = app.launchDate else { continue }
            let appName = boundedLabel(app.localizedName ?? app.bundleIdentifier ?? "Application")
            let knownAgentSurface = isKnownAgentApplication(app)
            let application = AXUIElementCreateApplication(pid)
            // Chromium/Electron applications may defer their web accessibility
            // tree until an assistive client explicitly requests it.
            _ = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            _ = AXUIElementSetAttributeValue(application, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            let windows: [AXUIElement] = attribute(application, kAXWindowsAttribute) ?? []
            let rankedWindows = windows.sorted { windowScore($0) > windowScore($1) }
            for window in rankedWindows.prefix(32) where result.count < 128 {
                let subrole: String = attribute(window, kAXSubroleAttribute) ?? ""
                guard subrole == kAXStandardWindowSubrole else { continue }
                let title = boundedLabel(attribute(window, kAXTitleAttribute) as String? ?? "Window")
                let controls = findControls(in: window, knownAgentSurface: knownAgentSurface)
                let responseBinding = controls.flatMap {
                    findResponseRoot(
                        interactionRoot: $0.interactionRoot,
                        composer: $0.composer,
                        window: window
                    )
                }
                let compatible = controls != nil
                // Ignore auxiliary glass/pet/system overlays unless they are
                // themselves a compatible Agent surface.
                if !compatible && windowScore(window) < 1_000 { continue }
                let reusable = previousCandidates.first {
                    !reusedCandidateIds.contains($0.id)
                        && $0.pid == pid
                        && $0.launchDate == launchDate
                        && $0.knownAgentSurface == knownAgentSurface
                        && sameElement($0.window, window)
                        && sameElement($0.composer, controls?.composer)
                        && sameElement($0.send, controls?.send)
                        && sameElement($0.interactionRoot, controls?.interactionRoot)
                        && sameElement($0.responseRoot, responseBinding?.root)
                }
                let id = reusable?.id ?? "candidate-\(UUID().uuidString.lowercased())"
                reusedCandidateIds.insert(id)
                nextCandidates[id] = Candidate(
                    id: id,
                    pid: pid,
                    launchDate: launchDate,
                    knownAgentSurface: knownAgentSurface,
                    appName: appName,
                    window: window,
                    windowTitle: title,
                    composer: controls?.composer,
                    send: controls?.send,
                    composerIdentity: controls?.composerIdentity,
                    sendIdentity: controls?.sendIdentity,
                    interactionRoot: controls?.interactionRoot,
                    responseRoot: responseBinding?.root,
                    responseRootIdentity: responseBinding?.identity
                )
                var wire: [String: Any] = [
                    "candidateId": id,
                    "label": controls.map {
                        boundedTargetLabel(
                            appName: appName,
                            windowTitle: title,
                            composer: $0.composer,
                            send: $0.send
                        )
                    } ?? boundedLabel("\(appName) — \(title)"),
                    "applicationLabel": appName,
                    "compatible": compatible,
                ]
                if !compatible {
                    wire["incompatibilityReason"] = "No writable Agent composer and locally bound explicit Send control were verified."
                }
                result.append(wire)
            }
        }
        // Replace the cache only after a complete discovery. A candidate ID is
        // therefore stable while the exact window/composer/Send identities are
        // stable, but stale identities cannot be configured later.
        candidates = nextCandidates
        return result
    }

    private func draftProbe(id: Int, params: [String: Any]) -> [String: Any] {
        guard let targetId = safeIdentifier(params["targetId"]),
              let text = safeText(params["text"], maximum: 4_000),
              let expectedDigest = safeDigest(params["expectedDraftDigest"]),
              let targetGeneration = safeIdentifier(params["targetGeneration"]),
              let profile,
              profile.targetId == targetId,
              profile.generation == targetGeneration,
              validate(profile) else {
            return response(id: id, result: ["outcome": "blocked", "reason": "target_lost"])
        }
        guard stringValue(profile.composer).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return response(id: id, result: ["outcome": "blocked", "reason": "composer_not_empty"])
        }
        guard activeStage == nil, activeProbe == nil else {
            return response(id: id, result: ["outcome": "blocked", "reason": "composer_not_empty"])
        }
        // Record cleanup ownership before the native write. If AX reports an
        // error after mutating the field, catch/EOF cleanup still knows the
        // exact generation and digest it is allowed to erase.
        activeProbe = ActiveProbe(digest: expectedDigest, targetGeneration: targetGeneration)
        guard setStringValue(profile.composer, text) else {
            _ = cleanupActiveDraftIfUnchanged()
            return response(id: id, result: ["outcome": "blocked", "reason": "draft_mismatch"])
        }
        guard digest(stringValue(profile.composer)) == expectedDigest else {
            return response(id: id, result: ["outcome": "blocked", "reason": "draft_mismatch"])
        }
        // Keep ownership when this immediate cleanup cannot be proven. A later
        // disarm/EOF gets one more digest-checked cleanup opportunity.
        guard cleanupActiveDraftIfUnchanged() else {
            return response(id: id, result: ["outcome": "blocked", "reason": "cleanup_failed"])
        }
        return response(id: id, result: ["outcome": "passed"])
    }

    private func stageDraft(id: Int, params: [String: Any]) -> [String: Any] {
        guard armed,
              let targetId = safeIdentifier(params["targetId"]),
              let stageId = safeIdentifier(params["stageId"]),
              let text = safeText(params["text"], maximum: 4_000),
              let expectedDigest = safeDigest(params["expectedDraftDigest"]),
              let targetGeneration = safeIdentifier(params["targetGeneration"]),
              let profile,
              profile.targetId == targetId,
              profile.generation == targetGeneration,
              validate(profile) else {
            return response(id: id, result: ["outcome": "blocked", "verified": false, "reason": "target_lost"])
        }
        guard activeStage == nil,
              activeProbe == nil,
              stringValue(profile.composer).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return response(id: id, result: ["outcome": "blocked", "verified": false, "reason": "composer_not_empty"])
        }
        guard digest(text) == expectedDigest else {
            return response(id: id, result: ["outcome": "blocked", "verified": false, "reason": "draft_mismatch"])
        }
        // Own the exact tuple before AX mutation so an exception/lost reply
        // between SetValue and readback remains compensatable by abort_stage
        // or digest-checked EOF cleanup.
        activeStage = ActiveStage(
            stageId: stageId,
            digest: expectedDigest,
            targetGeneration: profile.generation
        )
        guard setStringValue(profile.composer, text),
              digest(stringValue(profile.composer)) == expectedDigest else {
            return response(id: id, result: ["outcome": "blocked", "verified": false, "reason": "draft_mismatch"])
        }
        return response(id: id, result: [
            "outcome": "staged",
            "verified": true,
            "targetGeneration": profile.generation,
        ])
    }

    private func abortStage(id: Int, params: [String: Any]) -> [String: Any] {
        guard let targetId = safeIdentifier(params["targetId"]),
              let stageId = safeIdentifier(params["stageId"]),
              let expectedDigest = safeDigest(params["expectedDraftDigest"]),
              let targetGeneration = safeIdentifier(params["targetGeneration"]),
              let profile,
              profile.targetId == targetId,
              profile.generation == targetGeneration else {
            return response(id: id, result: ["outcome": "target_lost"])
        }
        guard let activeStage,
              activeStage.stageId == stageId,
              activeStage.digest == expectedDigest,
              activeStage.targetGeneration == targetGeneration else {
            return response(id: id, result: ["outcome": "not_found"])
        }
        guard validateOwnedComposer(profile) else {
            return response(id: id, result: ["outcome": "target_lost"])
        }
        guard let current = optionalStringValue(profile.composer) else {
            return response(id: id, result: ["outcome": "target_lost"])
        }
        guard digest(current) == expectedDigest else {
            // A proven mismatch is a human/external edit. Release ownership
            // while preserving the replacement text.
            self.activeStage = nil
            return response(id: id, result: ["outcome": "draft_changed"])
        }
        guard setStringValue(profile.composer, ""),
              let after = optionalStringValue(profile.composer) else {
            // Keep ownership so disarm/EOF can retry the exact cleanup.
            return response(id: id, result: ["outcome": "target_lost"])
        }
        if after.isEmpty {
            self.activeStage = nil
            return response(id: id, result: ["outcome": "cancelled"])
        }
        if digest(after) != expectedDigest {
            self.activeStage = nil
            return response(id: id, result: ["outcome": "draft_changed"])
        }
        // The exact relay draft remains; retain ownership for the final retry.
        return response(id: id, result: ["outcome": "target_lost"])
    }

    private func confirmDraft(id: Int, params: [String: Any]) -> [String: Any] {
        guard armed,
              let targetId = safeIdentifier(params["targetId"]),
              let stageId = safeIdentifier(params["stageId"]),
              let expectedDigest = safeDigest(params["expectedDraftDigest"]),
              let targetGeneration = safeIdentifier(params["targetGeneration"]),
              let profile,
              profile.targetId == targetId,
              validate(profile) else {
            return response(id: id, result: ["outcome": "blocked", "reason": "target_lost"])
        }
        guard let activeStage,
              activeStage.stageId == stageId,
              activeStage.digest == expectedDigest,
              activeStage.targetGeneration == targetGeneration,
              targetGeneration == profile.generation,
              digest(stringValue(profile.composer)) == expectedDigest else {
            return response(id: id, result: ["outcome": "blocked", "reason": "draft_changed"])
        }
        let sentDraft = stringValue(profile.composer)
        let baseline: ResponseSnapshot? = {
            guard validateOptionalResponseRoot(
                pid: profile.pid,
                window: profile.window,
                composer: profile.composer,
                interactionRoot: profile.interactionRoot,
                responseRoot: profile.responseRoot,
                responseRootIdentity: profile.responseRootIdentity
            ), let responseRoot = profile.responseRoot else { return nil }
            return responseSnapshot(from: responseRoot)
        }()
        guard AXUIElementPerformAction(profile.send, kAXPressAction as CFString) == .success else {
            return response(id: id, result: ["outcome": "blocked", "reason": "send_unavailable"])
        }
        self.activeStage = nil
        guard let baseline else {
            // The configured target advertised replyObservation=false. Sending
            // is complete and the host may stage the next utterance at once.
            return response(id: id, result: ["outcome": "sent"])
        }
        pruneObservations()
        let observationId = "observation-\(UUID().uuidString.lowercased())"
        let now = Date()
        observations[observationId] = Observation(
            id: observationId,
            baseline: baseline,
            sentDraft: sentDraft,
            lastText: "",
            sequence: 0,
            stableReads: 0,
            lastChange: now,
            createdAt: now
        )
        return response(id: id, result: ["outcome": "sent", "observationId": observationId])
    }

    private func cancelDraft(id: Int, params: [String: Any]) -> [String: Any] {
        guard armed,
              let targetId = safeIdentifier(params["targetId"]),
              let stageId = safeIdentifier(params["stageId"]),
              let expectedDigest = safeDigest(params["expectedDraftDigest"]),
              let targetGeneration = safeIdentifier(params["targetGeneration"]),
              let profile,
              profile.targetId == targetId,
              validate(profile) else {
            return response(id: id, result: ["outcome": "target_lost"])
        }
        guard let activeStage,
              activeStage.stageId == stageId,
              activeStage.digest == expectedDigest,
              activeStage.targetGeneration == targetGeneration,
              targetGeneration == profile.generation,
              digest(stringValue(profile.composer)) == expectedDigest else {
            return response(id: id, result: ["outcome": "draft_changed"])
        }
        guard setStringValue(profile.composer, ""), stringValue(profile.composer).isEmpty else {
            return response(id: id, result: ["outcome": "draft_changed"])
        }
        self.activeStage = nil
        return response(id: id, result: ["outcome": "cancelled"])
    }

    private func readReply(id: Int, params: [String: Any]) -> [String: Any] {
        pruneObservations()
        guard armed,
              let targetId = safeIdentifier(params["targetId"]),
              let observationId = safeIdentifier(params["observationId"]),
              let afterSequence = (params["afterSequence"] as? NSNumber)?.intValue,
              afterSequence >= 0,
              let profile,
              profile.targetId == targetId,
              validateOwnedComposer(profile),
              var observation = observations[observationId] else {
            return response(id: id, result: ["phase": "unavailable", "sequence": 0])
        }
        guard validateOptionalResponseRoot(
            pid: profile.pid,
            window: profile.window,
            composer: profile.composer,
            interactionRoot: profile.interactionRoot,
            responseRoot: profile.responseRoot,
            responseRootIdentity: profile.responseRootIdentity
        ), let responseRoot = profile.responseRoot,
           let current = responseSnapshot(from: responseRoot) else {
            observations.removeValue(forKey: observationId)
            return response(id: id, result: ["phase": "unavailable", "sequence": observation.sequence])
        }
        let delta: String
        switch responseDelta(
            baseline: observation.baseline,
            current: current,
            sentDraft: observation.sentDraft
        ) {
        case .waiting:
            delta = ""
        case let .reply(text):
            delta = text
        case .ambiguous:
            observations.removeValue(forKey: observationId)
            return response(id: id, result: ["phase": "unavailable", "sequence": observation.sequence])
        }
        if delta != observation.lastText {
            observation.lastText = String(delta.prefix(maximumTextCharacters))
            observation.sequence += 1
            observation.stableReads = 0
            observation.lastChange = Date()
        } else if !delta.isEmpty {
            observation.stableReads += 1
        }
        observations[observationId] = observation
        let settled = !observation.lastText.isEmpty
            && observation.stableReads >= 2
            && Date().timeIntervalSince(observation.lastChange) >= 0.75
        var result: [String: Any] = [
            "phase": observation.lastText.isEmpty ? "waiting" : settled ? "complete" : "streaming",
            "sequence": observation.sequence,
        ]
        if observation.sequence > afterSequence && !observation.lastText.isEmpty {
            result["text"] = observation.lastText
        }
        return response(id: id, result: result)
    }

    private func validate(_ profile: Profile) -> Bool {
        processIsSameLaunch(profile.pid, profile.launchDate)
            && element(profile.window, belongsTo: profile.pid)
            && element(profile.composer, belongsTo: profile.pid)
            && element(profile.send, belongsTo: profile.pid)
            && element(profile.interactionRoot, belongsTo: profile.pid)
            && validateBoundInteraction(
                pid: profile.pid,
                knownAgentSurface: profile.knownAgentSurface,
                window: profile.window,
                composer: profile.composer,
                send: profile.send,
                composerIdentity: profile.composerIdentity,
                sendIdentity: profile.sendIdentity,
                interactionRoot: profile.interactionRoot
            )
    }

    @discardableResult
    private func cleanupOwnedDraft() -> OwnedDraftCleanupOutcome {
        let ownership: (digest: String, targetGeneration: String)? = {
            if let activeStage { return (activeStage.digest, activeStage.targetGeneration) }
            if let activeProbe { return (activeProbe.digest, activeProbe.targetGeneration) }
            return nil
        }()
        guard let ownership else { return .none }
        guard let profile,
              ownership.targetGeneration == profile.generation,
              validate(profile),
              let current = optionalStringValue(profile.composer) else {
            return .unresolved
        }
        guard digest(current) == ownership.digest else {
            activeStage = nil
            activeProbe = nil
            return .humanChanged
        }
        guard setStringValue(profile.composer, ""),
              let after = optionalStringValue(profile.composer) else {
            return .unresolved
        }
        if after.isEmpty {
            activeStage = nil
            activeProbe = nil
            return .cleared
        }
        if digest(after) != ownership.digest {
            activeStage = nil
            activeProbe = nil
            return .humanChanged
        }
        return .unresolved
    }

    @discardableResult
    private func cleanupActiveDraftIfUnchanged() -> Bool {
        cleanupOwnedDraft().unchangedOrEmpty
    }

    func cleanupBeforeExit() {
        _ = cleanupOwnedDraft()
        armed = false
        observations.removeAll(keepingCapacity: false)
    }

    private func pruneObservations() {
        let cutoff = Date().addingTimeInterval(-observationRetentionSeconds)
        let expiredIds = observations.compactMap { id, observation in
            observation.createdAt < cutoff ? id : nil
        }
        for id in expiredIds { observations.removeValue(forKey: id) }
        let overflow = observations.count - (maximumObservations - 1)
        if overflow > 0 {
            for (id, _) in observations.sorted(by: { $0.value.createdAt < $1.value.createdAt }).prefix(overflow) {
                observations.removeValue(forKey: id)
            }
        }
    }
}

private func response(id: Int, result: Any) -> [String: Any] {
    ["jsonrpc": "2.0", "id": id, "result": result]
}

private func response(id: Int, error: String, message: String) -> [String: Any] {
    ["jsonrpc": "2.0", "id": id, "error": ["code": error, "message": message]]
}

private func targetWire(
    targetId: String,
    targetGeneration: String,
    label: String,
    replyObservation: Bool
) -> [String: Any] {
    [
        "targetId": targetId,
        "targetGeneration": targetGeneration,
        "label": label,
        "capabilities": [
            "draftInsertion": true,
            "explicitSend": true,
            "replyObservation": replyObservation,
        ],
    ]
}

private func sameElement(_ lhs: AXUIElement?, _ rhs: AXUIElement?) -> Bool {
    switch (lhs, rhs) {
    case (nil, nil):
        return true
    case let (left?, right?):
        return CFEqual(left, right)
    default:
        return false
    }
}

private func isCapability(_ value: String) -> Bool {
    value.count == 43 && value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
}

private func safeIdentifier(_ value: Any?) -> String? {
    guard let text = value as? String,
          text.count >= 1,
          text.count <= 160,
          text.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", options: .regularExpression) != nil else { return nil }
    return text
}

private func safeDigest(_ value: Any?) -> String? {
    guard let text = value as? String,
          text.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
    return text
}

private func safeText(_ value: Any?, maximum: Int) -> String? {
    guard let text = value as? String,
          !text.isEmpty,
          text.count <= maximum,
          text.range(of: "[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]", options: .regularExpression) == nil else { return nil }
    return text
}

private func boundedLabel(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return String((trimmed.isEmpty ? "Agent window" : trimmed).prefix(160))
}

private func controlLabel(_ element: AXUIElement, fallback: String) -> String {
    let values: [String] = [
        attribute(element, kAXTitleAttribute) as String? ?? "",
        attribute(element, kAXDescriptionAttribute) as String? ?? "",
        attribute(element, kAXHelpAttribute) as String? ?? "",
    ]
    let first = values.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    return boundedLabel(first ?? fallback)
}

private func boundedTargetLabel(
    appName: String,
    windowTitle: String,
    composer: AXUIElement,
    send: AXUIElement
) -> String {
    let app = String(boundedLabel(appName).prefix(32))
    let window = String(boundedLabel(windowTitle).prefix(48))
    let composerLabel = String(controlLabel(composer, fallback: "Agent composer").prefix(24))
    let sendLabel = String(controlLabel(send, fallback: "Send").prefix(20))
    return boundedLabel("\(app) — \(window) [\(composerLabel) → \(sendLabel)]")
}

private func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

private func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value as? T
}

private func optionalStringValue(_ element: AXUIElement) -> String? {
    attribute(element, kAXValueAttribute) as String?
}

private func stringValue(_ element: AXUIElement) -> String {
    optionalStringValue(element) ?? ""
}

private func setStringValue(_ element: AXUIElement, _ value: String) -> Bool {
    AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef) == .success
}

private func isWritable(_ element: AXUIElement) -> Bool {
    let role: String = attribute(element, kAXRoleAttribute) ?? ""
    let subrole: String = attribute(element, kAXSubroleAttribute) ?? ""
    let metadata = "\(role) \(subrole) \(searchableText(element))".lowercased()
    if metadata.contains("secure") || metadata.contains("password") { return false }
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
}

private func supportsPress(_ element: AXUIElement) -> Bool {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
          let actions = names as? [String] else { return false }
    return actions.contains(kAXPressAction)
}

private func processIsSameLaunch(_ pid: pid_t, _ launchDate: Date) -> Bool {
    guard let application = NSRunningApplication(processIdentifier: pid),
          !application.isTerminated,
          let currentLaunchDate = application.launchDate else { return false }
    return currentLaunchDate == launchDate
}

private func element(_ element: AXUIElement, belongsTo expectedPid: pid_t) -> Bool {
    var actualPid: pid_t = 0
    return AXUIElementGetPid(element, &actualPid) == .success && actualPid == expectedPid
}

private func validateOwnedComposer(_ profile: Profile) -> Bool {
    processIsSameLaunch(profile.pid, profile.launchDate)
        && element(profile.window, belongsTo: profile.pid)
        && element(profile.composer, belongsTo: profile.pid)
        && matchesStableIdentity(profile.composer, profile.composerIdentity)
        && isAgentComposer(profile.composer, knownAgentSurface: profile.knownAgentSurface)
}

private func isForbiddenApplication(_ app: NSRunningApplication) -> Bool {
    let identity = "\(app.bundleIdentifier ?? "") \(app.localizedName ?? "")".lowercased()
    return [
        "semaframe",
        "com.apple.terminal",
        "terminal",
        "iterm",
        "warp",
        "system settings",
        "system preferences",
        "securityagent",
        "loginwindow",
    ].contains(where: identity.contains)
}

private func isKnownAgentApplication(_ app: NSRunningApplication) -> Bool {
    ["com.openai.codex", "com.openai.chat"].contains((app.bundleIdentifier ?? "").lowercased())
}

private func windowScore(_ window: AXUIElement) -> Int {
    var score = 0
    let subrole: String = attribute(window, kAXSubroleAttribute) ?? ""
    let title: String = attribute(window, kAXTitleAttribute) ?? ""
    let isMain: Bool = attribute(window, kAXMainAttribute) ?? false
    let isFocused: Bool = attribute(window, kAXFocusedAttribute) ?? false
    if isMain { score += 10_000 }
    if isFocused { score += 5_000 }
    if subrole == kAXStandardWindowSubrole { score += 1_000 }
    if !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { score += 100 }
    return score
}

private func searchableText(_ element: AXUIElement) -> String {
    let values: [String] = [
        attribute(element, kAXIdentifierAttribute) as String? ?? "",
        attribute(element, kAXTitleAttribute) as String? ?? "",
        attribute(element, kAXDescriptionAttribute) as String? ?? "",
        attribute(element, kAXHelpAttribute) as String? ?? "",
    ]
    return values.joined(separator: " ").lowercased()
}

private func stableControlIdentity(
    _ element: AXUIElement,
    allowSemanticFallback: Bool = false
) -> ControlIdentity? {
    let nativeIdentifier: String = attribute(element, kAXIdentifierAttribute) ?? ""
    let role: String = attribute(element, kAXRoleAttribute) ?? ""
    let subrole: String = attribute(element, kAXSubroleAttribute) ?? ""
    var normalized = nativeIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
    if normalized.isEmpty && allowSemanticFallback {
        let values: [(String, String)] = [
            ("title", attribute(element, kAXTitleAttribute) as String? ?? ""),
            ("description", attribute(element, kAXDescriptionAttribute) as String? ?? ""),
            ("help", attribute(element, kAXHelpAttribute) as String? ?? ""),
        ]
        if let fallback = values.first(where: { !$0.1.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            normalized = "semantic:\(fallback.0):\(fallback.1.trimmingCharacters(in: .whitespacesAndNewlines))"
        }
    } else if !normalized.isEmpty {
        normalized = "axid:\(normalized)"
    }
    guard !normalized.isEmpty,
          normalized.count <= 256,
          !role.isEmpty else { return nil }
    return ControlIdentity(identifier: normalized, role: role, subrole: subrole)
}

private func matchesStableIdentity(_ element: AXUIElement, _ expected: ControlIdentity) -> Bool {
    stableControlIdentity(
        element,
        allowSemanticFallback: expected.identifier.hasPrefix("semantic:")
    ) == expected
}

private func containsSemanticToken(_ text: String, _ tokens: [String]) -> Bool {
    let escaped = tokens.map(NSRegularExpression.escapedPattern).joined(separator: "|")
    return text.range(
        of: "(?:^|[^a-z0-9])(?:\(escaped))(?:[^a-z0-9]|$)",
        options: .regularExpression
    ) != nil
}

private func isAgentComposer(_ element: AXUIElement, knownAgentSurface: Bool) -> Bool {
    let role: String = attribute(element, kAXRoleAttribute) ?? ""
    guard role == kAXTextAreaRole || role == kAXTextFieldRole,
          isWritable(element),
          stableControlIdentity(element, allowSemanticFallback: true) != nil else { return false }
    let text = searchableText(element)
    let semanticMatch = containsSemanticToken(text, ["message", "prompt", "composer", "chat", "ask"])
        || knownAgentSurface && text.contains("do anything")
    return semanticMatch
        && !containsSemanticToken(text, ["search", "filter", "find", "password", "credential"])
}

private func isExplicitSendControl(_ element: AXUIElement) -> Bool {
    let role: String = attribute(element, kAXRoleAttribute) ?? ""
    guard role == kAXButtonRole,
          supportsPress(element),
          stableControlIdentity(element, allowSemanticFallback: true) != nil else { return false }
    let text = searchableText(element)
    return containsSemanticToken(text, ["send", "submit"])
        && !containsSemanticToken(text, [
            "stop", "cancel", "delete", "close", "feedback", "report", "invite", "share",
        ])
}

private func parentChain(from element: AXUIElement, maximumDepth: Int = 12) -> [(AXUIElement, Int)] {
    var result: [(AXUIElement, Int)] = []
    var current = element
    for depth in 1...maximumDepth {
        guard let parent: AXUIElement = attribute(current, kAXParentAttribute) else { break }
        if result.contains(where: { CFEqual($0.0, parent) }) { break }
        result.append((parent, depth))
        current = parent
    }
    return result
}

private func nearestCommonInteractionRoot(
    composer: AXUIElement,
    send: AXUIElement,
    window: AXUIElement
) -> (root: AXUIElement, composerDepth: Int, sendDepth: Int)? {
    let composerParents = parentChain(from: composer)
    let sendParents = parentChain(from: send)
    var best: (root: AXUIElement, composerDepth: Int, sendDepth: Int)?
    for (composerParent, composerDepth) in composerParents {
        guard composerDepth <= 6, !CFEqual(composerParent, window) else { continue }
        for (sendParent, sendDepth) in sendParents where sendDepth <= 6 && CFEqual(composerParent, sendParent) {
            guard composerDepth + sendDepth <= 10 else { continue }
            if best == nil || composerDepth + sendDepth < best!.composerDepth + best!.sendDepth {
                best = (composerParent, composerDepth, sendDepth)
            }
        }
    }
    return best
}

private func elementFrame(_ element: AXUIElement) -> CGRect? {
    guard let positionValue: AXValue = attribute(element, kAXPositionAttribute),
          let sizeValue: AXValue = attribute(element, kAXSizeAttribute) else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue, .cgPoint, &position),
          AXValueGetValue(sizeValue, .cgSize, &size),
          position.x.isFinite,
          position.y.isFinite,
          size.width.isFinite,
          size.height.isFinite,
          size.width > 0,
          size.height > 0 else { return nil }
    return CGRect(origin: position, size: size)
}

private func rectGap(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
    let horizontal = max(0, max(lhs.minX - rhs.maxX, rhs.minX - lhs.maxX))
    let vertical = max(0, max(lhs.minY - rhs.maxY, rhs.minY - lhs.maxY))
    return hypot(horizontal, vertical)
}

private func frameContains(_ outer: CGRect, _ inner: CGRect, tolerance: CGFloat = 4) -> Bool {
    outer.insetBy(dx: -tolerance, dy: -tolerance).contains(inner)
}

private func hasDefensibleInteractionGeometry(
    composer: AXUIElement,
    send: AXUIElement,
    interactionRoot: AXUIElement,
    window: AXUIElement
) -> Bool {
    guard let composerFrame = elementFrame(composer),
          let sendFrame = elementFrame(send),
          let rootFrame = elementFrame(interactionRoot),
          let windowFrame = elementFrame(window),
          composerFrame.width >= 20,
          composerFrame.height >= 16,
          sendFrame.width <= 240,
          sendFrame.height <= 160,
          frameContains(rootFrame, composerFrame),
          frameContains(rootFrame, sendFrame) else { return false }

    // A window-sized common ancestor proves only that two controls happen to
    // share a window. It is not a defensible composer/Send binding.
    if rootFrame.width >= windowFrame.width * 0.92
        && rootFrame.height >= windowFrame.height * 0.92 {
        return false
    }
    let allowedGap = min(220, max(96, composerFrame.height * 2.5))
    guard rectGap(composerFrame, sendFrame) <= allowedGap else { return false }
    // Keep the Send control in the composer's local horizontal/vertical band;
    // this rejects unrelated toolbar, Run, and feedback controls.
    let horizontalBand = composerFrame.insetBy(dx: -220, dy: 0)
    let verticalBand = composerFrame.insetBy(dx: 0, dy: -160)
    return horizontalBand.minX <= sendFrame.midX
        && sendFrame.midX <= horizontalBand.maxX
        && verticalBand.minY <= sendFrame.midY
        && sendFrame.midY <= verticalBand.maxY
}

private func boundInteraction(
    composer: AXUIElement,
    send: AXUIElement,
    window: AXUIElement
) -> (root: AXUIElement, score: Int)? {
    guard let common = nearestCommonInteractionRoot(composer: composer, send: send, window: window),
          hasDefensibleInteractionGeometry(
            composer: composer,
            send: send,
            interactionRoot: common.root,
            window: window
          ),
          let composerFrame = elementFrame(composer),
          let sendFrame = elementFrame(send) else { return nil }
    let proximity = max(0, 220 - Int(rectGap(composerFrame, sendFrame).rounded()))
    let ancestry = max(0, 120 - (common.composerDepth + common.sendDepth) * 12)
    return (common.root, proximity + ancestry)
}

private func validateBoundInteraction(
    pid: pid_t,
    knownAgentSurface: Bool,
    window: AXUIElement,
    composer: AXUIElement,
    send: AXUIElement,
    composerIdentity: ControlIdentity,
    sendIdentity: ControlIdentity,
    interactionRoot: AXUIElement
) -> Bool {
    guard element(window, belongsTo: pid),
          element(composer, belongsTo: pid),
          element(send, belongsTo: pid),
          element(interactionRoot, belongsTo: pid),
          matchesStableIdentity(composer, composerIdentity),
          matchesStableIdentity(send, sendIdentity),
          isAgentComposer(composer, knownAgentSurface: knownAgentSurface),
          isExplicitSendControl(send),
          let current = boundInteraction(composer: composer, send: send, window: window) else { return false }
    return CFEqual(current.root, interactionRoot)
}

private func findControls(in root: AXUIElement, knownAgentSurface: Bool) -> BoundControls? {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var cursor = 0
    var composers: [(AXUIElement, Int)] = []
    var sends: [(AXUIElement, Int)] = []
    while cursor < queue.count && cursor < maximumTraversalNodes {
        let (element, depth) = queue[cursor]
        cursor += 1
        let role: String = attribute(element, kAXRoleAttribute) ?? ""
        let text = searchableText(element)
        if (role == kAXTextAreaRole || role == kAXTextFieldRole)
            && isAgentComposer(element, knownAgentSurface: knownAgentSurface) {
            var score = role == kAXTextAreaRole ? 20 : 10
            if containsSemanticToken(text, ["message", "prompt", "composer", "chat", "ask"]) { score += 80 }
            composers.append((element, score))
        }
        if role == kAXButtonRole && isExplicitSendControl(element) {
            let score = containsSemanticToken(text, ["send"]) ? 120 : 100
            sends.append((element, score))
        }
        if depth < 40 {
            let children: [AXUIElement] = attribute(element, kAXChildrenAttribute) ?? []
            queue.append(contentsOf: children.prefix(100).map { ($0, depth + 1) })
        }
    }
    var candidates: [BoundControls] = []
    for (composer, composerScore) in composers {
        for (send, sendScore) in sends {
            guard let composerIdentity = stableControlIdentity(composer, allowSemanticFallback: true),
                  let sendIdentity = stableControlIdentity(send, allowSemanticFallback: true),
                  let binding = boundInteraction(composer: composer, send: send, window: root) else { continue }
            candidates.append(BoundControls(
                composer: composer,
                send: send,
                composerIdentity: composerIdentity,
                sendIdentity: sendIdentity,
                interactionRoot: binding.root,
                score: composerScore + sendScore + binding.score
            ))
        }
    }
    let ranked = candidates.sorted { $0.score > $1.score }
    guard let best = ranked.first else { return nil }
    if ranked.count > 1 {
        let runnerUp = ranked[1]
        let sameExactPair = CFEqual(best.composer, runnerUp.composer)
            && CFEqual(best.send, runnerUp.send)
            && CFEqual(best.interactionRoot, runnerUp.interactionRoot)
        if best.score - runnerUp.score < controlPairAmbiguityMargin && !sameExactPair {
            // Two similarly plausible forms are not safe to auto-select. The
            // desktop user must choose a surface that exposes one clear pair.
            return nil
        }
    }
    return best
}

private func element(_ element: AXUIElement, isDescendantOf ancestor: AXUIElement, maximumDepth: Int = 12) -> Bool {
    if CFEqual(element, ancestor) { return true }
    return parentChain(from: element, maximumDepth: maximumDepth).contains { CFEqual($0.0, ancestor) }
}

private func responseRootHasSemantics(_ element: AXUIElement) -> Bool {
    let role: String = attribute(element, kAXRoleAttribute) ?? ""
    guard ![kAXButtonRole, kAXTextAreaRole, kAXTextFieldRole, kAXStaticTextRole].contains(role),
          stableControlIdentity(element) != nil else { return false }
    return containsSemanticToken(
        searchableText(element),
        ["conversation", "messages", "responses", "transcript", "thread", "history"]
    )
}

private func responseRootIsTiedToInteraction(
    responseRoot: AXUIElement,
    interactionRoot: AXUIElement,
    composer: AXUIElement,
    window: AXUIElement
) -> Bool {
    guard !element(responseRoot, isDescendantOf: interactionRoot),
          !element(interactionRoot, isDescendantOf: responseRoot),
          nearestCommonInteractionRoot(
            composer: responseRoot,
            send: interactionRoot,
            window: window
          ) != nil,
          let responseFrame = elementFrame(responseRoot),
          let composerFrame = elementFrame(composer),
          let windowFrame = elementFrame(window),
          responseFrame.height >= 100,
          responseFrame.width >= min(240, composerFrame.width * 0.6),
          responseFrame.maxY <= composerFrame.maxY + 40 else { return false }
    let overlap = max(0, min(responseFrame.maxX, composerFrame.maxX) - max(responseFrame.minX, composerFrame.minX))
    guard overlap >= min(responseFrame.width, composerFrame.width) * 0.4 else { return false }
    return !(responseFrame.width >= windowFrame.width * 0.92
        && responseFrame.height >= windowFrame.height * 0.92)
}

private func responseMessageKind(_ element: AXUIElement) -> ResponseMessageKind? {
    let text = searchableText(element)
    if containsSemanticToken(text, ["assistant", "response", "agent"]) { return .assistant }
    if containsSemanticToken(text, ["user", "human"]) { return .user }
    if containsSemanticToken(text, ["message"]) { return .ambiguous }
    return nil
}

private func responseMessageKey(_ identity: ControlIdentity) -> String {
    "\(identity.role)\u{1f}\(identity.subrole)\u{1f}\(identity.identifier)"
}

private func boundedText(from root: AXUIElement) -> String {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var cursor = 0
    var parts: [String] = []
    var characters = 0
    while cursor < queue.count && cursor < maximumTraversalNodes && characters < maximumTextCharacters {
        let (element, depth) = queue[cursor]
        cursor += 1
        let role: String = attribute(element, kAXRoleAttribute) ?? ""
        if role == kAXStaticTextRole || role == kAXTextAreaRole {
            let value = stringValue(element).trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty {
                parts.append(value)
                characters += value.count + 1
            }
        }
        if depth < 40 {
            let children: [AXUIElement] = attribute(element, kAXChildrenAttribute) ?? []
            queue.append(contentsOf: children.prefix(120).map { ($0, depth + 1) })
        }
    }
    return String(parts.joined(separator: "\n").prefix(maximumTextCharacters))
}

private func responseSnapshot(from root: AXUIElement) -> ResponseSnapshot? {
    let children: [AXUIElement] = attribute(root, kAXChildrenAttribute) ?? []
    var queue: [(AXUIElement, Int)] = children.prefix(120).map { ($0, 1) }
    var cursor = 0
    var messages: [String: ResponseMessage] = [:]
    var order: [String] = []
    var characters = 0
    while cursor < queue.count && cursor < maximumTraversalNodes && characters < maximumTextCharacters {
        let (element, depth) = queue[cursor]
        cursor += 1
        if let kind = responseMessageKind(element),
           let identity = stableControlIdentity(element) {
            let text = boundedText(from: element).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                let key = responseMessageKey(identity)
                guard messages[key] == nil else { return nil }
                messages[key] = ResponseMessage(kind: kind, text: text)
                order.append(key)
                characters += text.count
                continue
            }
        }
        if depth < 20 {
            let descendants: [AXUIElement] = attribute(element, kAXChildrenAttribute) ?? []
            queue.append(contentsOf: descendants.prefix(120).map { ($0, depth + 1) })
        }
    }
    guard !messages.isEmpty else { return nil }
    return ResponseSnapshot(messages: messages, order: order)
}

private func findResponseRoot(
    interactionRoot: AXUIElement,
    composer: AXUIElement,
    window: AXUIElement
) -> (root: AXUIElement, identity: ControlIdentity)? {
    var queue: [(AXUIElement, Int)] = [(window, 0)]
    var cursor = 0
    var candidates: [(AXUIElement, ControlIdentity, Int)] = []
    while cursor < queue.count && cursor < maximumTraversalNodes {
        let (element, depth) = queue[cursor]
        cursor += 1
        if CFEqual(element, interactionRoot) { continue }
        if responseRootHasSemantics(element),
           let identity = stableControlIdentity(element),
           responseRootIsTiedToInteraction(
            responseRoot: element,
            interactionRoot: interactionRoot,
            composer: composer,
            window: window
           ),
           responseSnapshot(from: element) != nil,
           let frame = elementFrame(element) {
            let semanticScore = containsSemanticToken(searchableText(element), ["responses", "messages"])
                ? 180 : 140
            let localityScore = max(0, 200 - Int(frame.height / 10))
            candidates.append((element, identity, semanticScore + localityScore))
        }
        if depth < 30 {
            let children: [AXUIElement] = attribute(element, kAXChildrenAttribute) ?? []
            queue.append(contentsOf: children.prefix(120).map { ($0, depth + 1) })
        }
    }
    let ranked = candidates.sorted { $0.2 > $1.2 }
    guard let best = ranked.first else { return nil }
    if ranked.count > 1,
       best.2 - ranked[1].2 < 24,
       !element(best.0, isDescendantOf: ranked[1].0),
       !element(ranked[1].0, isDescendantOf: best.0) {
        return nil
    }
    return (best.0, best.1)
}

private func validateOptionalResponseRoot(
    pid: pid_t,
    window: AXUIElement,
    composer: AXUIElement,
    interactionRoot: AXUIElement,
    responseRoot: AXUIElement?,
    responseRootIdentity: ControlIdentity?
) -> Bool {
    if responseRoot == nil || responseRootIdentity == nil {
        return responseRoot == nil && responseRootIdentity == nil
    }
    guard let responseRoot, let responseRootIdentity else { return false }
    return element(responseRoot, belongsTo: pid)
        && matchesStableIdentity(responseRoot, responseRootIdentity)
        && responseRootHasSemantics(responseRoot)
        && responseRootIsTiedToInteraction(
            responseRoot: responseRoot,
            interactionRoot: interactionRoot,
            composer: composer,
            window: window
        )
}

private enum ResponseDelta {
    case waiting
    case reply(String)
    case ambiguous
}

private func responseDelta(
    baseline: ResponseSnapshot,
    current: ResponseSnapshot,
    sentDraft: String
) -> ResponseDelta {
    for key in baseline.messages.keys where current.messages[key] == nil { return .ambiguous }
    let retainedOrder = current.order.filter { baseline.messages[$0] != nil }
    guard retainedOrder == baseline.order else { return .ambiguous }
    let baselineTailIndex = baseline.order.last.flatMap { current.order.firstIndex(of: $0) } ?? -1
    var replies: [String] = []
    var sawUserEcho = false
    var sawAssistant = false
    for (index, key) in current.order.enumerated() {
        guard let currentMessage = current.messages[key] else { return .ambiguous }
        let prior = baseline.messages[key]
        if let prior, prior.kind != currentMessage.kind { return .ambiguous }
        if prior?.text == currentMessage.text { continue }
        // Existing response branches changing after Send cannot be attributed
        // safely to this request. New attributed messages must append after
        // the complete baseline, not appear inside an unrelated branch.
        guard prior == nil, index > baselineTailIndex else { return .ambiguous }
        switch currentMessage.kind {
        case .user, .ambiguous:
            guard !sawUserEcho, !sawAssistant, currentMessage.text == sentDraft else { return .ambiguous }
            sawUserEcho = true
        case .assistant:
            let reply = currentMessage.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !reply.isEmpty, reply != sentDraft else { return .ambiguous }
            sawAssistant = true
            replies.append(reply)
        }
    }
    if replies.isEmpty { return .waiting }
    guard replies.count == 1 else { return .ambiguous }
    return .reply(String(replies[0].prefix(maximumTextCharacters)))
}

private func readExactly(_ handle: FileHandle, count: Int) -> Data? {
    var result = Data()
    while result.count < count {
        let chunk = handle.readData(ofLength: count - result.count)
        if chunk.isEmpty { return result.isEmpty ? nil : result }
        result.append(chunk)
    }
    return result
}

private func readFrame() -> Any? {
    guard let header = readExactly(FileHandle.standardInput, count: 4), header.count == 4 else { return nil }
    let length = header.withUnsafeBytes { raw -> UInt32 in
        raw.loadUnaligned(as: UInt32.self).bigEndian
    }
    guard length >= 2 && length <= maximumFrameBytes,
          let payload = readExactly(FileHandle.standardInput, count: Int(length)),
          payload.count == Int(length) else { return nil }
    return try? JSONSerialization.jsonObject(with: payload, options: [])
}

private func writeFrame(_ value: Any) -> Bool {
    guard JSONSerialization.isValidJSONObject(value),
          let payload = try? JSONSerialization.data(withJSONObject: value, options: []),
          payload.count >= 2,
          payload.count <= maximumFrameBytes else { return false }
    var length = UInt32(payload.count).bigEndian
    var frame = Data(bytes: &length, count: 4)
    frame.append(payload)
    do {
        try FileHandle.standardOutput.write(contentsOf: frame)
        return true
    } catch {
        return false
    }
}

// The Node owner is the only lifecycle authority. Terminal/process-group
// signals may reach both parent and helper at once; keep the helper alive long
// enough to receive the parent's authenticated shutdown request, or to observe
// stdin EOF and run the same digest-checked cleanup. Ignoring SIGPIPE ensures a
// lost stdout reader also reaches cleanupBeforeExit instead of terminating in
// the kernel.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGPIPE, SIG_IGN)

private let runtime = RelayRuntime()
while let request = readFrame() {
    if !writeFrame(runtime.handle(request)) { break }
    if runtime.shouldExit { break }
}
runtime.cleanupBeforeExit()
