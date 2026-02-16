class MonoProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) {
      return true;
    }

    const frameLength = channels[0].length;
    const mixed = new Float32Array(frameLength);
    const channelCount = channels.length;

    for (let i = 0; i < frameLength; i += 1) {
      let sum = 0;
      for (let c = 0; c < channelCount; c += 1) {
        sum += channels[c][i] || 0;
      }
      mixed[i] = sum / channelCount;
    }

    this.port.postMessage(mixed, [mixed.buffer]);
    return true;
  }
}

registerProcessor('mono-processor', MonoProcessor);
