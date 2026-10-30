export class NativeOcr {
  async recognize(source, centeredOnly = true) {
    if (typeof globalThis.TextDetector !== 'function') {
      throw new Error('Chrome native OCR (TextDetector) is unavailable. Try enabling chrome://flags/#enable-experimental-web-platform-features and restarting Chrome, or select PaddleOCR. Availability depends on Chrome and the OS.');
    }
    this.detector ??= new globalThis.TextDetector();
    let results;
    try {
      results = await this.detector.detect(source);
    } catch (e) {
      throw new Error(`Chrome native OCR failed: ${e.message}. Select PaddleOCR if this platform does not support TextDetector.`);
    }
    const lines = results
      .filter((item) => typeof item.rawValue === 'string' && item.boundingBox?.width > 0 && item.boundingBox?.height > 0)
      .filter((item) => !centeredOnly
        || Math.abs(item.boundingBox.x + item.boundingBox.width / 2 - source.width / 2) <= source.width * 0.15)
      .sort((a, b) => a.boundingBox.y - b.boundingBox.y || a.boundingBox.x - b.boundingBox.x);
    return { raw: lines.map((item) => item.rawValue).join('\n'), boxes: lines.map((item) => item.boundingBox) };
  }
}
