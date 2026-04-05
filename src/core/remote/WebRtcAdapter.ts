import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { Duplex } from "stream"

/**
 * WebRtcAdapter manages the P2P WebRTC connection between cline-core and the mobile app.
 *
 * Flow:
 * 1. Register with signaling server
 * 2. Poll for SDP offer from mobile app
 * 3. Create RTCPeerConnection, set remote description, create answer
 * 4. Post answer to signaling server
 * 5. Exchange ICE candidates
 * 6. On data channel open — pipe to ProtoBus gRPC server
 */
export class WebRtcAdapter {
	private static instance: WebRtcAdapter | null = null

	private _isPeerConnected = false
	private _connectedSinceTs = 0
	private _instanceId: string
	private _signalingUrl: string
	private _sharedKey: string
	private _stopped = false
	private _pollTimer: NodeJS.Timeout | null = null
	private _pc: any = null // RTCPeerConnection from node-datachannel

	private constructor(instanceId: string, signalingUrl: string, sharedKey: string) {
		this._instanceId = instanceId
		this._signalingUrl = signalingUrl
		this._sharedKey = sharedKey
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	static async start(instanceId: string, signalingUrl: string, sharedKey: string): Promise<WebRtcAdapter> {
		if (WebRtcAdapter.instance) {
			await WebRtcAdapter.stop()
		}
		const adapter = new WebRtcAdapter(instanceId, signalingUrl, sharedKey)
		WebRtcAdapter.instance = adapter
		adapter._connect().catch((err) => Logger.error("[WebRtcAdapter] Connection error:", err))
		return adapter
	}

	static async stop(): Promise<void> {
		if (WebRtcAdapter.instance) {
			await WebRtcAdapter.instance._disconnect()
			WebRtcAdapter.instance = null
		}
	}

	static getInstance(): WebRtcAdapter | null {
		return WebRtcAdapter.instance
	}

	isPeerConnected(): boolean {
		return this._isPeerConnected
	}

	getConnectedSinceTs(): number {
		return this._connectedSinceTs
	}

	// ─── Internal ─────────────────────────────────────────────────────────────

	private async _connect(): Promise<void> {
		Logger.log(`[WebRtcAdapter] Starting — instanceId=${this._instanceId} signalingUrl=${this._signalingUrl}`)

		// Step 1: Register with the signaling server
		try {
			const res = await fetch(`${this._signalingUrl}/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ instanceId: this._instanceId }),
			})
			if (!res.ok) {
				Logger.error(`[WebRtcAdapter] Registration failed: ${res.status}`)
				this._scheduleReconnect()
				return
			}
			Logger.log("[WebRtcAdapter] Registered with signaling server — waiting for mobile peer")
		} catch (err) {
			Logger.error("[WebRtcAdapter] Failed to reach signaling server:", err)
			this._scheduleReconnect()
			return
		}

		// Step 2: Poll for SDP offer
		this._startPolling()
	}

	private _startPolling(): void {
		if (this._stopped) return

		const poll = async () => {
			if (this._stopped) return
			try {
				const res = await fetch(`${this._signalingUrl}/offer?instanceId=${encodeURIComponent(this._instanceId)}`)
				if (res.ok) {
					const data = (await res.json()) as { sdp?: string; error?: string }
					if (data.sdp) {
						Logger.log("[WebRtcAdapter] Received SDP offer from mobile — creating answer")
						await this._handleOffer(data.sdp)
						return // Stop polling — connection in progress
					}
				}
			} catch {
				// Signaling server unreachable — will retry
			}
			// Poll every 3 seconds
			if (!this._stopped && !this._isPeerConnected) {
				this._pollTimer = setTimeout(poll, 3_000)
			}
		}

		poll()
	}

	private async _handleOffer(offerSdp: string): Promise<void> {
		try {
			// Dynamically import node-datachannel to avoid load errors if not installed
			const nodeDataChannel = await import("node-datachannel")
			const { PeerConnection } = nodeDataChannel

			this._pc = new PeerConnection("cline-remote", {
				iceServers: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
			})

			// Collect local ICE candidates and send to signaling server
			this._pc.onLocalCandidate((candidate: string, mid: string) => {
				if (this._stopped) return
				fetch(`${this._signalingUrl}/ice`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						instanceId: this._instanceId,
						candidate,
						mid,
						from: "vscode",
					}),
				}).catch(() => {})
			})

			// Handle incoming data channel from mobile (mobile is the offerer, creates the channel)
			this._pc.onDataChannel((dc: any) => {
				Logger.log(`[WebRtcAdapter] Data channel received: ${dc.getLabel()}`)
				if (dc.getLabel() !== "grpc") return

				dc.onOpen(() => {
					Logger.log("[WebRtcAdapter] Data channel open — P2P connection established!")
					this._isPeerConnected = true
					this._connectedSinceTs = Date.now()
					this._pipeDataChannelToGrpc(dc)
				})

				dc.onClosed(() => {
					Logger.log("[WebRtcAdapter] Data channel closed")
					this._isPeerConnected = false
					this._connectedSinceTs = 0
					// Re-register and wait for new connection
					if (!this._stopped) {
						this._scheduleReconnect()
					}
				})
			})

			// Set remote description (the offer from mobile)
			this._pc.setRemoteDescription(offerSdp, "offer")

			// Create and set local description (our answer)
			const answer = this._pc.localDescription()
			if (!answer) {
				Logger.error("[WebRtcAdapter] Failed to create answer")
				return
			}

			Logger.log("[WebRtcAdapter] Posting SDP answer to signaling server")
			await fetch(`${this._signalingUrl}/answer`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					instanceId: this._instanceId,
					sdp: answer.sdp,
				}),
			})

			// Poll for ICE candidates from mobile
			this._pollIceCandidates()
		} catch (err) {
			Logger.error("[WebRtcAdapter] Failed to handle offer:", err)
			this._scheduleReconnect()
		}
	}

	private _pollIceCandidates(): void {
		if (this._stopped || !this._pc) return

		const poll = async () => {
			if (this._stopped || this._isPeerConnected) return
			try {
				const res = await fetch(
					`${this._signalingUrl}/ice?instanceId=${encodeURIComponent(this._instanceId)}&from=vscode`,
				)
				if (res.ok) {
					const data = (await res.json()) as { candidates?: Array<{ candidate: string; mid: string }> }
					if (data.candidates) {
						for (const c of data.candidates) {
							try {
								// Server returns raw candidate strings
								const candidateStr = typeof c === "string" ? c : (c as any).candidate
								this._pc.addRemoteCandidate(candidateStr, "0")
							} catch {
								// Ignore invalid candidates
							}
						}
					}
				}
			} catch {
				// Ignore
			}
			if (!this._stopped && !this._isPeerConnected) {
				setTimeout(poll, 1_000)
			}
		}

		poll()
	}

	private _pipeDataChannelToGrpc(dc: any): void {
		// Create a Node.js Duplex stream from the WebRTC data channel
		// This allows the ProtoBus gRPC server to use it as a TCP-like connection
		const stream = new Duplex({
			read() {},
			write(chunk, _encoding, callback) {
				try {
					dc.sendMessageBinary(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
					callback()
				} catch (err) {
					callback(err as Error)
				}
			},
		})

		dc.onMessage((msg: Buffer | string) => {
			const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg)
			stream.push(buf)
		})

		dc.onClosed(() => {
			stream.push(null)
			stream.destroy()
		})

		// Inject the stream into the ProtoBus gRPC server
		// The server treats it as a new TCP connection
		try {
			const { getProtobusServer } = require("../../standalone/protobus-service")
			const server = getProtobusServer()
			if (server) {
				server.emit("connection", stream)
				Logger.log("[WebRtcAdapter] Stream injected into ProtoBus gRPC server")
			} else {
				Logger.error("[WebRtcAdapter] ProtoBus server not available")
			}
		} catch (err) {
			Logger.error("[WebRtcAdapter] Failed to inject stream into gRPC server:", err)
		}
	}

	private _scheduleReconnect(): void {
		if (this._stopped) return
		Logger.log("[WebRtcAdapter] Reconnecting in 30s...")
		this._pollTimer = setTimeout(() => this._connect(), 30_000)
	}

	private async _disconnect(): Promise<void> {
		this._stopped = true
		if (this._pollTimer) {
			clearTimeout(this._pollTimer)
			this._pollTimer = null
		}
		if (this._pc) {
			try {
				this._pc.close()
			} catch {
				// Ignore
			}
			this._pc = null
		}
		this._isPeerConnected = false
		this._connectedSinceTs = 0
		Logger.log("[WebRtcAdapter] Stopped")
	}
}
