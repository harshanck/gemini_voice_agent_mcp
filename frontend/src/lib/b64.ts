export function bytesToB64(bytes: Uint8Array): string {
    let s = ""
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(s)
}

export function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
}
