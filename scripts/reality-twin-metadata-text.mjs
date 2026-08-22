/**
 * Convert a metadata field that may contain simple markup into inert plain text.
 *
 * This is deliberately a single-pass extractor, not an HTML sanitizer or entity
 * decoder. Markup is discarded, control bytes are removed, and encoded entities
 * remain encoded so untrusted input cannot become active markup after a second
 * decoding step.
 */
export function realityTwinMetadataText(value) {
  const input = String(value).normalize("NFC");
  const output = [];
  let insideTag = false;

  for (const character of input) {
    if (character === "<") {
      insideTag = true;
      continue;
    }
    if (insideTag) {
      if (character === ">") insideTag = false;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint >= 0 && codePoint < 0x20)
      && character !== "\t"
      && character !== "\n"
      && character !== "\r") continue;
    output.push(character);
  }

  return output.join("").replace(/\s+/gu, " ").trim();
}
