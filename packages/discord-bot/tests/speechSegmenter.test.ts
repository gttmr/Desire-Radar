import { describe, expect, it } from 'vitest';
import { SpeechSegmenter } from '../src/services/speechSegmenter.js';

describe('SpeechSegmenter', () => {
  it('drops tiny chunks', () => {
    const seg = new SpeechSegmenter(100, 1000);
    const out = seg.normalize(Buffer.alloc(50));
    expect(out).toBeNull();
  });

  it('caps oversized chunks', () => {
    const seg = new SpeechSegmenter(100, 1000);
    const out = seg.normalize(Buffer.alloc(2000));
    expect(out).not.toBeNull();
    expect(out?.length).toBe(1000);
  });

  it('keeps valid chunks', () => {
    const seg = new SpeechSegmenter(100, 1000);
    const out = seg.normalize(Buffer.alloc(500));
    expect(out?.length).toBe(500);
  });
});
