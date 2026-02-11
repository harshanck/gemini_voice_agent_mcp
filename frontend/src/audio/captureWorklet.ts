class CaptureProcessor extends AudioWorkletProcessor {
    process(inputs: Float32Array[][]) {
        const input = inputs[0]
        if (!input || input.length === 0) return true
        const ch0 = input[0]
        if (!ch0 || ch0.length === 0) return true
        const copy = new Float32Array(ch0.length)
        copy.set(ch0)
        this.port.postMessage(copy, [copy.buffer])
        return true
    }
}

registerProcessor("capture-processor", CaptureProcessor)
