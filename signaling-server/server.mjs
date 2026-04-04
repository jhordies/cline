/**
 * Cline Remote Bridge — WebRTC Signaling Server
 *
 * Exchanges SDP offers/answers and ICE candidates between
 * the VSCode extension (cline-core) and the mobile app.
 *
 * This server never sees any Cline messages — it only routes
 * the ~2KB WebRTC handshake data needed to establish a P2P connection.
 *
 * Usage:
 *   node server.mjs
 *   PORT=3000 node server.mjs
 */

import { createServer } from "http"
import { WebSocketServer } from "ws"

const PORT = parseInt(process.env.PORT || "3000", 10)
const TTL_MS = 60 * 60 * 1000 // 1 hour — sessions expire after this

// In-memory session store
// { instanceId -> { offer, answer, iceCandidates[], registeredAt, ws? } }
const sessions = new Map()

// Cleanup expired sessions every 10 minutes
setInterval(() => {
	const now = Date.now()
	for (const [id, session] of sessions) {
		if (now - session.registeredAt > TTL_MS) {
			sessions.delete(id)
			console.log(`[cleanup] Expired session: ${id}`)
		}
	}
}, 10 * 60 * 1000)

const httpServer = createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`)
	const instanceId = url.searchParams.get("instanceId") || ""

	// CORS headers
	res.setHeader("Access-Control-Allow-Origin", "*")
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	res.setHeader("Access-Control-Allow-Headers", "Content-Type")

	if (req.method === "OPTIONS") {
		res.writeHead(204)
		res.end()
		return
	}

	let body = ""
	req.on("data", (chunk) => (body += chunk))
	req.on("end", () => {
		try {
			const data = body ? JSON.parse(body) : {}
			handleRequest(url.pathname, req.method, instanceId, data, res)
		} catch (e) {
			res.writeHead(400, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Invalid JSON" }))
		}
	})
})

function handleRequest(path, method, instanceId, data, res) {
	const json = (obj, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" })
		res.end(JSON.stringify(obj))
	}

	// POST /register — cline-core registers its instanceId
	if (path === "/register" && method === "POST") {
		const id = data.instanceId || instanceId
		if (!id) return json({ error: "instanceId required" }, 400)
		sessions.set(id, { offer: null, answer: null, iceCandidates: [], registeredAt: Date.now() })
		console.log(`[register] ${id}`)
		return json({ ok: true })
	}

	// POST /offer — cline-core posts its SDP offer
	if (path === "/offer" && method === "POST") {
		const id = data.instanceId || instanceId
		const session = sessions.get(id)
		if (!session) return json({ error: "Session not found" }, 404)
		session.offer = data.sdp
		session.iceCandidates = [] // reset on new offer
		console.log(`[offer] ${id}`)
		return json({ ok: true })
	}

	// GET /offer — mobile fetches the SDP offer
	if (path === "/offer" && method === "GET") {
		const session = sessions.get(instanceId)
		if (!session) return json({ error: "Session not found" }, 404)
		if (!session.offer) return json({ error: "No offer yet" }, 404)
		return json({ sdp: session.offer })
	}

	// POST /answer — mobile posts its SDP answer
	if (path === "/answer" && method === "POST") {
		const id = data.instanceId || instanceId
		const session = sessions.get(id)
		if (!session) return json({ error: "Session not found" }, 404)
		session.answer = data.sdp
		console.log(`[answer] ${id}`)
		return json({ ok: true })
	}

	// GET /answer — cline-core fetches the SDP answer
	if (path === "/answer" && method === "GET") {
		const session = sessions.get(instanceId)
		if (!session) return json({ error: "Session not found" }, 404)
		if (!session.answer) return json({ error: "No answer yet" }, 404)
		return json({ sdp: session.answer })
	}

	// POST /ice — either side posts ICE candidates
	if (path === "/ice" && method === "POST") {
		const id = data.instanceId || instanceId
		const session = sessions.get(id)
		if (!session) return json({ error: "Session not found" }, 404)
		if (data.candidate) {
			session.iceCandidates.push({ candidate: data.candidate, from: data.from || "unknown" })
		}
		return json({ ok: true })
	}

	// GET /ice — either side fetches ICE candidates (filtered by sender)
	if (path === "/ice" && method === "GET") {
		const session = sessions.get(instanceId)
		if (!session) return json({ error: "Session not found" }, 404)
		const from = new URL(`http://x${req.url}`).searchParams.get("from") || ""
		// Return candidates NOT from the requester (i.e. from the other side)
		const candidates = session.iceCandidates.filter((c) => c.from !== from).map((c) => c.candidate)
		return json({ candidates })
	}

	// GET /health
	if (path === "/health") {
		return json({ ok: true, sessions: sessions.size })
	}

	json({ error: "Not found" }, 404)
}

httpServer.listen(PORT, () => {
	console.log(`Cline signaling server running on port ${PORT}`)
	console.log(`Health check: http://localhost:${PORT}/health`)
})
