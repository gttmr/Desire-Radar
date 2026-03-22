export class SpeechSegmenter {
  constructor(
    private readonly minBytes = 3200,
    private readonly maxBytes = 32000 * 20
  ) {}

  // Keeps mock behavior simple: discard tiny chunks, cap oversized chunks.
  normalize(pcmChunk: Buffer): Buffer | null {
    if (pcmChunk.length < this.minBytes) {
      return null;
    }
    if (pcmChunk.length > this.maxBytes) {
      return pcmChunk.subarray(0, this.maxBytes);
    }
    return pcmChunk;
  }
}
