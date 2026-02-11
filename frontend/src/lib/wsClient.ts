export type ClientOut =
    | { type: "config"; system_instruction?: string; response_modalities?: string[]; model?: string }
    | { type: "audio"; data: string; mime_type: string }
    | { type: "text"; text: string }
    | { type: "interrupt" }
    | { type: "ping" }

export type ServerIn =
    | { type: "ready"; model: string }
    | { type: "audio"; data: string; mime_type: string }
    | { type: "text"; text: string }
    | { type: "interrupted" }
    | { type: "error"; message: string }
    | { type: "pong" }

export class RelayWS {
    private ws: WebSocket | null = null
    private onMsg: ((m: ServerIn) => void) | null = null
    private onCloseCb: (() => void) | null = null

    connect(url: string, onMsg: (m: ServerIn) => void, onClose: () => void) {
        this.onMsg = onMsg
        this.onCloseCb = onClose
        this.ws = new WebSocket(url)
        this.ws.onmessage = (e) => {
            try {
                const m = JSON.parse(e.data) as ServerIn
                this.onMsg?.(m)
            } catch { }
        }
        this.ws.onclose = () => this.onCloseCb?.()
    }

    send(msg: ClientOut) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
        this.ws.send(JSON.stringify(msg))
    }

    close() {
        try { this.ws?.close() } catch { }
        this.ws = null
    }

    isOpen() {
        return this.ws?.readyState === WebSocket.OPEN
    }
}
