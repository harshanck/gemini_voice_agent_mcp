type Msg =
    | { type: "push"; pcm16: ArrayBuffer; sampleRate: number }
    | { type: "clear" }

class PlaybackProcessor extends AudioWorkletProcessor {
    private q: Float32Array[] = []
    private qi = 0
    private inRate = 24000

    constructor() {
        super()
        this.port.onmessage = (e: MessageEvent<Msg>) => {
            const m = e.data
            if (m.type === "clear") {
                this.q = []
                this.qi = 0
                return
            }
            if (m.type === "push") {
                this.inRate = m.sampleRate
                const s16 = new Int16Array(m.pcm16)
                const f32 = new Float32Array(s16.length)
                for (let i = 0; i < s16.length; i++) f32[i] = s16[i] / 32768
                this.q.push(f32)
            }
        }
    }

    private nextSample(): number {
        while (this.q.length > 0) {
            const cur = this.q[0]
            if (this.qi < cur.length) {
                const v = cur[this.qi]
                this.qi++
                return v
            }
            this.q.shift()
            this.qi = 0
        }
        return 0
    }

    process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
        const out = outputs[0]
        const ch0 = out[0]
        if (!ch0) return true

        const outRate = sampleRate
        const ratio = this.inRate / outRate

        let phase = 0
        for (let i = 0; i < ch0.length; i++) {
            phase += ratio
            while (phase >= 1) {
                phase -= 1
                this._last = this.nextSample()
            }
            const next = this._peek()
            ch0[i] = this._last * (1 - phase) + next * phase
        }

        for (let c = 1; c < out.length; c++) out[c].set(ch0)
        return true
    }

    private _last = 0
    private _peek(): number {
        if (this.q.length === 0) return this._last
        const cur = this.q[0]
        const idx = Math.min(this.qi, cur.length - 1)
        return cur[idx]
    }
}

registerProcessor("playback-processor", PlaybackProcessor)
