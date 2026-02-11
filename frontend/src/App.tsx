import { useEffect, useMemo, useRef, useState } from "react"
import { RelayWS } from "./lib/wsClient"
import { bytesToB64, b64ToBytes } from "./lib/b64"
import { f32ToPcm16LE, resampleLinear } from "./lib/pcm"

type Status = "idle" | "connecting" | "connected"

export default function App() {
    const wsUrl = import.meta.env.VITE_WS_URL as string
    const relay = useMemo(() => new RelayWS(), [])

    const [status, setStatus] = useState<Status>("idle")
    const [log, setLog] = useState("")
    const [systemInstruction, setSystemInstruction] = useState("You are a helpful and friendly salon voice assistant.")
    const [model, setModel] = useState("")
    const [text, setText] = useState("")

    const audioCtxRef = useRef<AudioContext | null>(null)
    const micStreamRef = useRef<MediaStream | null>(null)
    const captureNodeRef = useRef<AudioWorkletNode | null>(null)
    const playNodeRef = useRef<AudioWorkletNode | null>(null)

    const micRateRef = useRef<number>(48000)
    const chunkF32Ref = useRef<Float32Array[]>([])
    const sendingRef = useRef(false)

    function append(s: string) {
        setLog((p) => (p ? p + "\n" + s : s))
    }

    async function setupAudio() {
        const ctx = new AudioContext()
        audioCtxRef.current = ctx

        await ctx.audioWorklet.addModule(new URL("./audio/captureWorklet.ts", import.meta.url))
        await ctx.audioWorklet.addModule(new URL("./audio/playbackWorklet.ts", import.meta.url))

        const playNode = new AudioWorkletNode(ctx, "playback-processor")
        playNode.connect(ctx.destination)
        playNodeRef.current = playNode

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        })
        micStreamRef.current = stream

        const source = ctx.createMediaStreamSource(stream)
        const captureNode = new AudioWorkletNode(ctx, "capture-processor", { numberOfInputs: 1, numberOfOutputs: 0 })
        captureNode.port.onmessage = (e) => onMicChunk(e.data as Float32Array)
        source.connect(captureNode)
        captureNodeRef.current = captureNode

        micRateRef.current = ctx.sampleRate
    }

    async function teardownAudio() {
        try { captureNodeRef.current?.disconnect() } catch { }
        try { playNodeRef.current?.disconnect() } catch { }
        captureNodeRef.current = null
        playNodeRef.current = null

        const s = micStreamRef.current
        if (s) s.getTracks().forEach((t) => t.stop())
        micStreamRef.current = null

        const ctx = audioCtxRef.current
        if (ctx) await ctx.close()
        audioCtxRef.current = null
    }

    function onMicChunk(chunk: Float32Array) {
        if (!relay.isOpen()) return
        chunkF32Ref.current.push(chunk)
        if (!sendingRef.current) flushMic()
    }

    async function flushMic() {
        if (sendingRef.current) return
        sendingRef.current = true
        try {
            const targetRate = 16000
            while (chunkF32Ref.current.length > 0 && relay.isOpen()) {
                const frames = chunkF32Ref.current.splice(0, 6)
                const len = frames.reduce((a, f) => a + f.length, 0)
                const merged = new Float32Array(len)
                let o = 0
                for (const f of frames) {
                    merged.set(f, o)
                    o += f.length
                }
                const down = resampleLinear(merged, micRateRef.current, targetRate)
                const pcm16 = f32ToPcm16LE(down)
                const b = new Uint8Array(pcm16.buffer)
                relay.send({ type: "audio", data: bytesToB64(b), mime_type: "audio/pcm;rate=16000" })
                await new Promise((r) => setTimeout(r, 10))
            }
        } finally {
            sendingRef.current = false
        }
    }

    function handleServerMessage(m: any) {
        if (m.type === "ready") {
            setModel(m.model || "")
            append(`ready: ${m.model}`)
            return
        }
        if (m.type === "text") {
            append(`ai: ${m.text}`)
            return
        }
        if (m.type === "audio") {
            const bytes = b64ToBytes(m.data)
            const rate = parseRate(m.mime_type) ?? 24000
            playNodeRef.current?.port.postMessage({ type: "push", pcm16: bytes.buffer, sampleRate: rate }, [bytes.buffer])
            return
        }
        if (m.type === "interrupted") {
            playNodeRef.current?.port.postMessage({ type: "clear" })
            append("interrupted by server")
            return
        }
        if (m.type === "error") {
            append(`error: ${m.message}`)
            return
        }
    }

    function parseRate(mime: string): number | null {
        const m = /rate=(\d+)/.exec(mime || "")
        if (!m) return null
        return Number(m[1]) || null
    }

    async function connect() {
        if (status !== "idle") return
        setStatus("connecting")
        append("connecting...")

        try {
            await setupAudio()
            relay.connect(
                wsUrl,
                (m) => handleServerMessage(m),
                () => {
                    append("socket closed")
                    setStatus("idle")
                }
            )
            setTimeout(() => {
                relay.send({
                    type: "config",
                    system_instruction: systemInstruction,
                    response_modalities: ["AUDIO"]
                })
            }, 0)
            setStatus("connected")
            append("connected")
        } catch (e: any) {
            append(`connect failed: ${String(e?.message || e)}`)
            setStatus("idle")
            await teardownAudio()
            relay.close()
        }
    }

    async function disconnect() {
        relay.close()
        await teardownAudio()
        setStatus("idle")
        append("disconnected")
    }

    function sendText() {
        const t = text.trim()
        if (!t) return
        relay.send({ type: "text", text: t })
        append(`you: ${t}`)
        setText("")
    }

    function interrupt() {
        relay.send({ type: "interrupt" })
        playNodeRef.current?.port.postMessage({ type: "clear" })
        append("interrupt")
    }

    useEffect(() => {
        return () => {
            relay.close()
            teardownAudio()
        }
    }, [])

    return (
        <div className="wrap">
            <h2>Salon Voice Assistant</h2>

            <div className="card">
                <div className="row">
                    <button className="btn" onClick={connect} disabled={status !== "idle"}>
                        Start
                    </button>
                    <button className="btn secondary" onClick={disconnect} disabled={status === "idle"}>
                        Stop
                    </button>
                    <button className="btn secondary" onClick={interrupt} disabled={status === "idle"}>
                        Interrupt
                    </button>
                    <span className="pill">WS: {status}</span>
                    <span className="pill">Model: {model || "-"}</span>
                </div>

                <div style={{ marginTop: 12 }}>
                    <div className="small">System instruction</div>
                    <input
                        className="input"
                        value={systemInstruction}
                        onChange={(e) => setSystemInstruction(e.target.value)}
                        disabled={status !== "idle"}
                    />
                </div>

                <div style={{ marginTop: 12 }}>
                    <div className="small">Send text (optional)</div>
                    <div className="row">
                        <input
                            className="input"
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            onKeyDown={(e) => (e.key === "Enter" ? sendText() : null)}
                            disabled={status === "idle"}
                        />
                        <button className="btn secondary" onClick={sendText} disabled={status === "idle"}>
                            Send
                        </button>
                    </div>
                </div>

                <div className="log">{log || "…"}</div>
            </div>
        </div>
    )
}
