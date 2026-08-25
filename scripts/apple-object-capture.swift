#!/usr/bin/env swift

import Foundation
import RealityKit
import Darwin

private let protocolVersion = 1

private enum CliError: Error, LocalizedError {
    case invalidArguments(String)
    case unsupported
    case invalidInput(String)
    case invalidOutput(String)
    case reconstruction(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let message),
             .invalidInput(let message),
             .invalidOutput(let message),
             .reconstruction(let message):
            return message
        case .unsupported:
            return "Apple Object Capture is not supported on this Mac"
        }
    }
}

private enum Command {
    case probe
    case reconstruct(input: URL, output: URL, detail: PhotogrammetrySession.Request.Detail, detailName: String)
}

private func emit(_ payload: [String: Any]) {
    var object = payload
    object["version"] = protocolVersion
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
        let fallback = "{\"message\":\"Failed to encode progress event\",\"type\":\"error\",\"version\":1}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func fail(_ error: Error, code: Int32) -> Int32 {
    let message: String
    if let cliError = error as? CliError {
        message = cliError.errorDescription ?? "Object Capture failed"
    } else {
        // Framework and file-system errors can embed input or temporary paths.
        // Keep the stdout protocol path-free; the Node host owns diagnostics.
        message = "Object Capture failed"
    }
    emit(["type": "error", "message": message])
    return code
}

private func parseCommand(_ arguments: [String]) throws -> Command {
    if arguments == ["--probe"] {
        return .probe
    }
    if arguments.contains("--probe") {
        throw CliError.invalidArguments("--probe cannot be combined with reconstruction arguments")
    }

    var values: [String: String] = [:]
    var index = 0
    let allowed = Set(["--input", "--output", "--detail"])
    while index < arguments.count {
        let key = arguments[index]
        guard allowed.contains(key) else {
            throw CliError.invalidArguments("Unknown command-line argument")
        }
        guard values[key] == nil else {
            throw CliError.invalidArguments("Duplicate command-line argument")
        }
        guard index + 1 < arguments.count else {
            throw CliError.invalidArguments("Missing value for \(key)")
        }
        values[key] = arguments[index + 1]
        index += 2
    }

    guard let inputPath = values["--input"], !inputPath.isEmpty,
          let outputPath = values["--output"], !outputPath.isEmpty,
          let detailName = values["--detail"] else {
        throw CliError.invalidArguments("Expected --input <directory> --output <directory> --detail <preview|reduced|medium|full>")
    }

    let detail: PhotogrammetrySession.Request.Detail
    switch detailName {
    case "preview": detail = .preview
    case "reduced": detail = .reduced
    case "medium": detail = .medium
    case "full": detail = .full
    default:
        throw CliError.invalidArguments("Unsupported reconstruction detail")
    }

    return .reconstruct(
        input: URL(fileURLWithPath: inputPath, isDirectory: true).standardizedFileURL,
        output: URL(fileURLWithPath: outputPath, isDirectory: true).standardizedFileURL,
        detail: detail,
        detailName: detailName
    )
}

private func prepareDirectories(input: URL, output: URL) throws {
    let fileManager = FileManager.default
    var isInputDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: input.path, isDirectory: &isInputDirectory), isInputDirectory.boolValue else {
        throw CliError.invalidInput("Input must be an existing directory")
    }
    guard fileManager.isReadableFile(atPath: input.path) else {
        throw CliError.invalidInput("Input directory is not readable")
    }
    let inputValues = try input.resourceValues(forKeys: [.isSymbolicLinkKey])
    guard inputValues.isSymbolicLink != true else {
        throw CliError.invalidInput("Input directory must not be a symbolic link")
    }

    let canonicalInput = input.resolvingSymlinksInPath().standardizedFileURL.pathComponents
    let canonicalOutputParent = output.deletingLastPathComponent().resolvingSymlinksInPath()
    let canonicalOutput = canonicalOutputParent
        .appendingPathComponent(output.lastPathComponent, isDirectory: true)
        .standardizedFileURL.pathComponents
    var sharedPrefix = 0
    for (inputComponent, outputComponent) in zip(canonicalInput, canonicalOutput) {
        guard inputComponent == outputComponent else { break }
        sharedPrefix += 1
    }
    guard sharedPrefix < min(canonicalInput.count, canonicalOutput.count) else {
        throw CliError.invalidOutput("Input and output directories must not overlap")
    }

    var isOutputDirectory: ObjCBool = false
    if fileManager.fileExists(atPath: output.path, isDirectory: &isOutputDirectory) {
        guard isOutputDirectory.boolValue else {
            throw CliError.invalidOutput("Output path exists and is not a directory")
        }
        let values = try output.resourceValues(forKeys: [.isSymbolicLinkKey])
        guard values.isSymbolicLink != true else {
            throw CliError.invalidOutput("Output directory must not be a symbolic link")
        }
        let children = try fileManager.contentsOfDirectory(atPath: output.path)
        guard children.isEmpty else {
            throw CliError.invalidOutput("Output directory must be empty")
        }
    } else {
        try fileManager.createDirectory(at: output, withIntermediateDirectories: true)
    }
}

private func findObj(in directory: URL) -> URL? {
    let fileManager = FileManager.default
    guard let enumerator = fileManager.enumerator(
        at: directory,
        includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
        options: [.skipsHiddenFiles, .skipsPackageDescendants]
    ) else { return nil }

    var matches: [URL] = []
    var visited = 0
    for case let url as URL in enumerator {
        visited += 1
        if visited > 100_000 { break }
        guard url.pathExtension.lowercased() == "obj" else { continue }
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true,
              values.isSymbolicLink != true else { continue }
        matches.append(url.standardizedFileURL)
    }
    return matches.sorted { $0.path < $1.path }.first
}

@available(macOS 14.0, *)
private func stageName(_ stage: PhotogrammetrySession.Output.ProcessingStage?) -> String? {
    guard let stage else { return nil }
    switch stage {
    case .preProcessing: return "pre_processing"
    case .imageAlignment: return "image_alignment"
    case .pointCloudGeneration: return "point_cloud_generation"
    case .meshGeneration: return "mesh_generation"
    case .textureMapping: return "texture_mapping"
    case .optimization: return "optimization"
    @unknown default: return "unknown"
    }
}

private func reconstruct(input: URL, output: URL, detail: PhotogrammetrySession.Request.Detail, detailName: String) async -> Int32 {
    guard #available(macOS 13.0, *), PhotogrammetrySession.isSupported else {
        return fail(CliError.unsupported, code: 3)
    }

    do {
        try prepareDirectories(input: input, output: output)
        let session = try PhotogrammetrySession(input: input)
        let request = PhotogrammetrySession.Request.modelFile(url: output, detail: detail)
        emit(["type": "started", "detail": detailName])
        try session.process(requests: [request])

        var requestCompleted = false
        for try await event in session.outputs {
            switch event {
            case .inputComplete:
                emit(["type": "progress_info", "stage": "input_complete"])
            case .requestProgress(_, let fractionComplete):
                emit(["type": "progress", "progress": min(1, max(0, fractionComplete))])
            case .requestProgressInfo(_, let info):
                if #available(macOS 14.0, *) {
                    var payload: [String: Any] = ["type": "progress_info"]
                    if let seconds = info.estimatedRemainingTime, seconds.isFinite, seconds >= 0 {
                        payload["estimatedRemainingSeconds"] = seconds
                    }
                    if let stage = stageName(info.processingStage) {
                        payload["stage"] = stage
                    }
                    emit(payload)
                }
            case .invalidSample(let id, let reason):
                // Framework reasons can include a source filename. Preserve the
                // sample id but keep the JSONL protocol free of photo paths.
                _ = reason
                emit(["type": "invalid_sample", "sampleId": id, "message": "Object Capture rejected an input sample"])
            case .skippedSample(let id):
                emit(["type": "skipped_sample", "sampleId": id])
            case .automaticDownsampling:
                emit(["type": "warning", "message": "Object Capture automatically downsampled the input images"])
            case .stitchingIncomplete:
                emit(["type": "warning", "message": "Object Capture reported incomplete stitching"])
            case .requestError(_, let error):
                _ = error
                return fail(CliError.reconstruction("Object Capture reconstruction failed"), code: 4)
            case .requestComplete(_, let result):
                guard case .modelFile(let url) = result else {
                    return fail(CliError.reconstruction("Object Capture returned an unexpected result"), code: 4)
                }
                requestCompleted = true
                _ = url
                emit(["type": "progress_info", "stage": "model_file_ready"])
            case .processingCancelled:
                return fail(CliError.reconstruction("Object Capture processing was cancelled"), code: 5)
            case .processingComplete:
                guard requestCompleted else {
                    return fail(CliError.reconstruction("Object Capture completed without a model result"), code: 4)
                }
                guard let obj = findObj(in: output) else {
                    return fail(CliError.reconstruction("Object Capture did not produce an OBJ model"), code: 6)
                }
                _ = obj
                emit(["type": "complete", "progress": 1.0])
                return 0
            @unknown default:
                emit(["type": "warning", "message": "Object Capture emitted an unknown event"])
            }
        }
        return fail(CliError.reconstruction("Object Capture ended before processing completed"), code: 4)
    } catch {
        return fail(error, code: 4)
    }
}

private func run() async -> Int32 {
    do {
        switch try parseCommand(Array(CommandLine.arguments.dropFirst())) {
        case .probe:
            if #available(macOS 13.0, *) {
                emit([
                    "type": "probe",
                    "supported": PhotogrammetrySession.isSupported,
                    "platform": "macos",
                ])
            } else {
                emit([
                    "type": "probe",
                    "supported": false,
                    "platform": "macos",
                    "reason": "Apple Object Capture requires macOS 13 or later",
                ])
            }
            return 0
        case .reconstruct(let input, let output, let detail, let detailName):
            return await reconstruct(input: input, output: output, detail: detail, detailName: detailName)
        }
    } catch {
        return fail(error, code: 2)
    }
}

Task {
    exit(await run())
}
dispatchMain()
