export function f32ToPcm16LE(input: Float32Array): Int16Array {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
        let x = input[i]
        if (x > 1) x = 1
        if (x < -1) x = -1
        out[i] = (x < 0 ? x * 32768 : x * 32767) | 0
    }
    return out
}

export function pcm16LEToF32(input: Int16Array): Float32Array {
    const out = new Float32Array(input.length)
    for (let i = 0; i < input.length; i++) out[i] = input[i] / 32768
    return out
}

export function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
    if (inRate === outRate) return input
    const ratio = outRate / inRate
    const outLen = Math.max(1, Math.floor(input.length * ratio))
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
        const src = i / ratio
        const i0 = Math.floor(src)
        const i1 = Math.min(i0 + 1, input.length - 1)
        const t = src - i0
        out[i] = input[i0] * (1 - t) + input[i1] * t
    }
    return out
}
