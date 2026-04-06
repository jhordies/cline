import type { Controller } from "@/core/controller"
import { getRequestRegistry, handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import type { WebviewMessage } from "@/shared/WebviewMessage"

/**
 * WebRtcAdapter manages the P2P WebRTC connection between cline-core and the mobile app.
 *
 * Flow:
 * 1. Register with signaling server
 * 2. Poll for SDP offer from mobile app
 * 3. Create RTCPeerConnection, set remote description, create answer
 * 4. Post answer to signaling server
 * 5. Exchange ICE candidates
 * 6. On data channel open — bridge JSON gRPC messages to handleGrpcRequest
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
	private _controller: Controller | null = null
	private _handshakeTimer: NodeJS.Timeout | null = null

	private constructor(instanceId: string, signalingUrl: string, sharedKey: string) {
		this._instanceId = instanceId
		this._signalingUrl = signalingUrl
		this._sharedKey = sharedKey
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	static async start(
		instanceId: string,
		signalingUrl: string,
		sharedKey: string,
		controller?: Controller,
	): Promise<WebRtcAdapter> {
		if (WebRtcAdapter.instance) {
			await WebRtcAdapter.stop()
		}
		const adapter = new WebRtcAdapter(instanceId, signalingUrl, sharedKey)
		adapter._controller = controller ?? null
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

	setController(controller: Controller): void {
		this._controller = controller
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
						// Consume the offer so a future reconnect doesn't re-process it
						await fetch(`${this._signalingUrl}/offer/consume`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ instanceId: this._instanceId }),
						}).catch(() => {})
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
		// Close any existing peer connection before creating a new one
		if (this._pc) {
			try {
				this._pc.close()
			} catch {
				// Ignore
			}
			this._pc = null
		}

		try {
			// Dynamically import node-datachannel to avoid load errors if not installed
			const nodeDataChannel = await import("node-datachannel")
			const { PeerConnection } = nodeDataChannel

			this._pc = new PeerConnection("cline-remote", {
				iceServers: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
			})

			// Handle local description (answer) — called when answer is ready
			this._pc.onLocalDescription((sdp: string, type: string) => {
				if (type !== "answer") return
				Logger.log("[WebRtcAdapter] Answer SDP ready — posting to signaling server")
				fetch(`${this._signalingUrl}/answer`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						instanceId: this._instanceId,
						sdp,
					}),
				})
					.then(() => Logger.log("[WebRtcAdapter] Answer posted successfully"))
					.catch((err) => Logger.error("[WebRtcAdapter] Failed to post answer:", err))

				// Start polling for ICE candidates from mobile
				this._pollIceCandidates()
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

			// Detect ICE/connection failures so we can reconnect even if the data
			// channel never opens (e.g. ICE timeout, network change mid-handshake).
			this._pc.onStateChange((state: string) => {
				Logger.log(`[WebRtcAdapter] PeerConnection state: ${state}`)
				if (state === "failed" || state === "closed" || state === "disconnected") {
					this._clearHandshakeTimer()
					if (!this._isPeerConnected && !this._stopped) {
						Logger.warn(`[WebRtcAdapter] PeerConnection entered "${state}" before data channel opened — reconnecting`)
						this._scheduleReconnect()
					}
				}
			})

			// Handle incoming data channel from mobile (mobile is the offerer, creates the channel)
			this._pc.onDataChannel((dc: any) => {
				Logger.log(`[WebRtcAdapter] Data channel received: ${dc.getLabel()}`)
				if (dc.getLabel() !== "grpc") return

				dc.onOpen(() => {
					Logger.log("[WebRtcAdapter] Data channel open — P2P connection established!")
					this._clearHandshakeTimer()
					this._isPeerConnected = true
					this._connectedSinceTs = Date.now()
					// _bridgeDataChannel registers its own onClosed that handles both
					// subscription cleanup and reconnect scheduling.
					this._bridgeDataChannel(dc)
				})
			})

			// Set remote description — this triggers async answer generation via onLocalDescription
			Logger.log("[WebRtcAdapter] Setting remote description (offer)")
			this._pc.setRemoteDescription(offerSdp, "offer")

			// Safety net: if the data channel never opens within 30s, give up and retry
			this._startHandshakeTimer()
		} catch (err) {
			Logger.error("[WebRtcAdapter] Failed to handle offer:", err)
			this._scheduleReconnect()
		}
	}

	private _pollIceCandidates(): void {
		if (this._stopped || !this._pc) return

		const seen = new Set<string>()

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
								const candidateStr = typeof c === "string" ? c : (c as any).candidate
								if (seen.has(candidateStr)) continue
								seen.add(candidateStr)
								this._pc.addRemoteCandidate(candidateStr, c.mid || "0")
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

	/**
	 * Bridges the WebRTC data channel to the gRPC handler.
	 *
	 * The VSCode extension doesn't use a TCP gRPC server — it handles gRPC calls
	 * via handleGrpcRequest() directly. The mobile app sends WebviewMessage JSON
	 * over the data channel, and we route them through the same handler, sending
	 * ExtensionMessage JSON responses back over the channel.
	 */
	private _bridgeDataChannel(dc: any): void {
		// Track all streaming request IDs registered through this connection so we
		// can cancel them (cleaning up subscriptions in activeStateSubscriptions,
		// activePartialMessageSubscriptions, etc.) when the channel closes.
		// Without this, stale responseStream closures pointing at the dead data
		// channel linger in the subscription sets and swallow all future updates.
		const connectionRequestIds = new Set<string>()

		const send = (msg: ExtensionMessage) => {
			try {
				const json = JSON.stringify(msg)
				Logger.log(`[WebRtcAdapter] → sending ${json.length}b: type=${(msg as any).type ?? "unknown"}`)
				dc.sendMessage(json)
			} catch (err) {
				Logger.error("[WebRtcAdapter] Failed to send message over data channel:", err)
			}
		}

		const postMessageToWebview = (msg: ExtensionMessage): Promise<boolean> => {
			send(msg)
			return Promise.resolve(true)
		}

		dc.onMessage((raw: Buffer | string) => {
			try {
				const text = typeof raw === "string" ? raw : raw.toString("utf8")
				Logger.log(`[WebRtcAdapter] ← received ${text.length}b: ${text.substring(0, 120)}`)
				const message = JSON.parse(text) as WebviewMessage

				if (!this._controller) {
					Logger.error("[WebRtcAdapter] No controller available to handle message")
					return
				}

				if (message.type === "grpc_request" && message.grpc_request) {
					const req = message.grpc_request
					Logger.log(`[WebRtcAdapter] dispatching gRPC: ${req.service}/${req.method} streaming=${req.is_streaming}`)
					// Track streaming requests so we can cancel them on disconnect
					if (req.is_streaming && req.request_id) {
						connectionRequestIds.add(req.request_id)
					}
					handleGrpcRequest(this._controller, postMessageToWebview, req).catch((err) =>
						Logger.error("[WebRtcAdapter] gRPC request error:", err),
					)
				} else if (message.type === "grpc_request_cancel" && message.grpc_request_cancel) {
					connectionRequestIds.delete(message.grpc_request_cancel.request_id)
					handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel).catch((err) =>
						Logger.error("[WebRtcAdapter] gRPC cancel error:", err),
					)
				} else {
					Logger.warn(
						`[WebRtcAdapter] Unknown message type: "${message.type}" — full message: ${text.substring(0, 200)}`,
					)
				}
			} catch (err) {
				Logger.error("[WebRtcAdapter] Failed to parse message:", err)
			}
		})

		dc.onClosed(() => {
			Logger.log("[WebRtcAdapter] Data channel closed")
			this._isPeerConnected = false
			this._connectedSinceTs = 0

			// Cancel all streaming subscriptions from this connection so their
			// responseStream closures are removed from the subscription sets.
			// This prevents state/partial-message updates from being sent to the
			// dead channel and silently dropped after a reconnect.
			if (connectionRequestIds.size > 0) {
				Logger.log(`[WebRtcAdapter] Cleaning up ${connectionRequestIds.size} streaming subscription(s) on channel close`)
				const registry = getRequestRegistry()
				for (const requestId of connectionRequestIds) {
					registry.cancelRequest(requestId)
				}
				connectionRequestIds.clear()
			}

			if (!this._stopped) {
				this._scheduleReconnect()
			}
		})

		Logger.log("[WebRtcAdapter] Data channel bridged to gRPC handler")
	}

	private _startHandshakeTimer(): void {
		this._clearHandshakeTimer()
		this._handshakeTimer = setTimeout(() => {
			if (!this._isPeerConnected && !this._stopped) {
				Logger.warn("[WebRtcAdapter] Handshake timed out — reconnecting")
				this._scheduleReconnect()
			}
		}, 30_000)
	}

	private _clearHandshakeTimer(): void {
		if (this._handshakeTimer) {
			clearTimeout(this._handshakeTimer)
			this._handshakeTimer = null
		}
	}

	private _scheduleReconnect(): void {
		if (this._stopped) return
		// Clear any existing poll or reconnect timer before scheduling a new one
		if (this._pollTimer) {
			clearTimeout(this._pollTimer)
			this._pollTimer = null
		}
		Logger.log("[WebRtcAdapter] Reconnecting in 5s...")
		this._pollTimer = setTimeout(() => this._connect(), 5_000)
	}

	private async _disconnect(): Promise<void> {
		this._stopped = true
		this._clearHandshakeTimer()
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
