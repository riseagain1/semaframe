#!/usr/bin/env swift

import Foundation
import ImageIO
import Vision

let repositoryRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let requestedRoot = CommandLine.arguments.dropFirst().first ?? "artifacts/qa-english"
let scanRoot = URL(fileURLWithPath: requestedRoot, relativeTo: repositoryRoot).standardizedFileURL
let supportedExtensions = Set(["png", "jpg", "jpeg"])
let targetFolders = Set([
  "pump-landscape",
  "pump-vertical",
  "furniture-landscape",
  "traffic-landscape",
  "traffic-vertical",
])

guard let enumerator = FileManager.default.enumerator(
  at: scanRoot,
  includingPropertiesForKeys: [.isRegularFileKey],
  options: [.skipsHiddenFiles]
) else {
  fputs("Could not enumerate \(scanRoot.path). Render QA stills first.\n", stderr)
  exit(1)
}

let imageURLs = enumerator.compactMap { item -> URL? in
  guard let url = item as? URL,
        supportedExtensions.contains(url.pathExtension.lowercased()),
        targetFolders.contains(url.deletingLastPathComponent().lastPathComponent),
        !url.lastPathComponent.contains("contact-sheet")
  else { return nil }
  return url
}.sorted { $0.path < $1.path }

guard !imageURLs.isEmpty else {
  fputs("No English QA stills found under \(scanRoot.path).\n", stderr)
  exit(1)
}

func containsHan(_ text: String) -> Bool {
  text.unicodeScalars.contains { scalar in
    (0x3400...0x4DBF).contains(scalar.value) ||
      (0x4E00...0x9FFF).contains(scalar.value) ||
      (0xF900...0xFAFF).contains(scalar.value)
  }
}

var findings: [(URL, String)] = []
var scanned = 0

for imageURL in imageURLs {
  guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    fputs("Could not decode \(imageURL.path).\n", stderr)
    exit(1)
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["en-US", "zh-Hans"]
  request.minimumTextHeight = 0.008

  do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  } catch {
    fputs("OCR failed for \(imageURL.path): \(error)\n", stderr)
    exit(1)
  }

  scanned += 1
  for observation in request.results ?? [] {
    guard let text = observation.topCandidates(1).first?.string, containsHan(text) else { continue }
    findings.append((imageURL, text))
  }
}

if !findings.isEmpty {
  fputs("Visible CJK text was detected in the English render QA set:\n", stderr)
  for (url, text) in findings {
    fputs("- \(url.path): \(text)\n", stderr)
  }
  exit(1)
}

print("OCR checked \(scanned) English QA stills: no visible CJK text detected.")
