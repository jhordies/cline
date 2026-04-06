/**
 * Cline Remote Bridge — WebRTC Signaling + TURN Server
 *
 * Exchanges SDP offers/answers and ICE candidates between
 * the VSCode extension (cline-core) and the mobile app.
 *
 * Also runs an embedded TURN server so peers can connect
 * across different networks (not just LAN).
 *
 * This server never sees any Cline messages — it only routes
 * the ~2KB WebRTC handshake data needed to establish a P2P connection,
 * and relays encrypted WebRTC media/data when direct P2P fails.
 *
 * Usage:
 *   node server.mjs
 *   PORT=3000 TURN_PORT=3478 TURN_SECRET=mysecret node server.mjs
 *
 * Environment variables:
 *   PORT          HTTP signaling port (default: 3000)
 *   TURN_PORT     TURN server UDP/TCP port (default: 3478)
 *   TURN_SECRET   Shared secret for HMAC credential generation (default: random)
 *   TURN_REALM    TURN realm (default: cline.bot)
 *   PUBLIC_IP     Public IP for TURN relay (auto-detected if not set)
 */

import { createHmac, randomBytes } from "crypto"
import { createServer } from "http"
import { createRequire } from "module"

const require = createRequire(import.meta.url)

const PORT = Number.parseInt(process.env.PORT || "3000", 10)
const TURN_PORT = Number.parseInt(process.env.TURN_PORT || "3478", 10)
const TURN_REALM = process.env.TURN_REALM || "cline.bot"
// Secret used to generate short-lived TURN credentials (HMAC-SHA1 per RFC 8489)
const TURN_SECRET = process.env.TURN_SECRET || randomBytes(32).toString("hex")
const TURN_CREDENTIAL_TTL = 24 * 60 * 60 // 24 hours in seconds
const TTL_MS = 60 * 60 * 1000 // 1 hour — sessions expire after this

if (!process.env.TURN_SECRET) {
	console.log(`[turn] No TURN_SECRET set — generated ephemeral secret (restarts will invalidate credentials)`)
}

// ─── TURN Server ─────────────────────────────────────────────────────────────

const turnServerHost = process.env.PUBLIC_IP || null

// Start TURN server
const Turn = require("node-turn")
const turnServer = new Turn({
	listeningPort: TURN_PORT,
	authMech: "long-term",
	credentials: {}, // We'll validate dynamically via the credential check below
	realm: TURN_REALM,
	debugLevel: "ERROR",
})

// Override credential check to use HMAC-based time-limited credentials
// Username format: "<expiry-unix-timestamp>"
// Password: base64(HMAC-SHA1(secret, username))
turnServer.checkCredentials = (username, password) => {
	try {
		const expiry = Number.parseInt(username, 10)
		if (Number.isNaN(expiry) || Date.now() / 1000 > expiry) {
			return false // expired
		}
		const expected = createHmac("sha1", TURN_SECRET).update(username).digest("base64")
		return expected === password
	} catch {
		return false
	}
}

turnServer.start()
console.log(`[turn] TURN server listening on port ${TURN_PORT} (realm: ${TURN_REALM})`)

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate short-lived TURN credentials using HMAC-SHA1.
 * Compatible with the standard time-limited credential mechanism.
 */
function generateTurnCredentials() {
	const expiry = Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL
	const username = String(expiry)
	const password = createHmac("sha1", TURN_SECRET).update(username).digest("base64")
	return { username, password, ttl: TURN_CREDENTIAL_TTL }
}

// ─── In-memory session store ──────────────────────────────────────────────────
// { instanceId -> { offer, answer, iceCandidates[], registeredAt } }
const sessions = new Map()

// Cleanup expired sessions every 10 minutes
setInterval(
	() => {
		const now = Date.now()
		for (const [id, session] of sessions) {
			if (now - session.registeredAt > TTL_MS) {
				sessions.delete(id)
				console.log(`[cleanup] Expired session: ${id}`)
			}
		}
	},
	10 * 60 * 1000,
)

// ─── HTTP Signaling Server ────────────────────────────────────────────────────

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
			handleRequest(url.pathname, req.method, instanceId, data, res, req)
		} catch (e) {
			res.writeHead(400, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Invalid JSON" }))
		}
	})
})

function handleRequest(path, method, instanceId, data, res, req) {
	const json = (obj, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" })
		res.end(JSON.stringify(obj))
	}

	// GET /turn-credentials — returns short-lived TURN credentials
	// Both cline-core and the mobile app call this before initiating WebRTC
	if (path === "/turn-credentials" && method === "GET") {
		const creds = generateTurnCredentials()
		const host = turnServerHost || req.headers.host?.split(":")[0] || "localhost"
		return json({
			urls: [`turn:${host}:${TURN_PORT}`, `turn:${host}:${TURN_PORT}?transport=tcp`],
			username: creds.username,
			credential: creds.password,
			ttl: creds.ttl,
		})
	}

	// POST /register — cline-core registers its instanceId
	if (path === "/register" && method === "POST") {
		const id = data.instanceId || instanceId
		if (!id) return json({ error: "instanceId required" }, 400)
		const existing = sessions.get(id)
		if (existing) {
			// Refresh TTL but preserve any pending offer/ICE from mobile
			existing.registeredAt = Date.now()
			console.log(`[register] ${id} (refreshed, offer=${!!existing.offer})`)
		} else {
			sessions.set(id, { offer: null, answer: null, iceCandidates: [], registeredAt: Date.now() })
			console.log(`[register] ${id} (new)`)
		}
		return json({ ok: true })
	}

	// POST /offer — mobile posts its SDP offer
	if (path === "/offer" && method === "POST") {
		const id = data.instanceId || instanceId
		if (!id) return json({ error: "instanceId required" }, 400)
		let session = sessions.get(id)
		if (!session) {
			// Auto-create session so mobile can post offer before cline-core registers
			session = { offer: null, answer: null, iceCandidates: [], registeredAt: Date.now() }
			sessions.set(id, session)
		}
		session.offer = data.sdp
		session.answer = null // reset answer when new offer arrives
		session.iceCandidates = [] // reset ICE on new offer
		console.log(`[offer] ${id}`)
		return json({ ok: true })
	}

	// GET /offer — cline-core polls for the SDP offer
	if (path === "/offer" && method === "GET") {
		const session = sessions.get(instanceId)
		if (!session) return json({ error: "Session not found" }, 404)
		if (!session.offer) return json({ error: "No offer yet" }, 404)
		return json({ sdp: session.offer })
	}

	// POST /offer/consume — cline-core clears the offer after processing it
	if (path === "/offer/consume" && method === "POST") {
		const id = data.instanceId || instanceId
		const session = sessions.get(id)
		if (!session) return json({ error: "Session not found" }, 404)
		session.offer = null
		console.log(`[offer/consume] ${id}`)
		return json({ ok: true })
	}

	// POST /answer — cline-core posts its SDP answer
	if (path === "/answer" && method === "POST") {
		const id = data.instanceId || instanceId
		const session = sessions.get(id)
		if (!session) return json({ error: "Session not found" }, 404)
		session.answer = data.sdp
		console.log(`[answer] ${id}`)
		return json({ ok: true })
	}

	// GET /answer — mobile polls for the SDP answer
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
			session.iceCandidates.push({ candidate: data.candidate, mid: data.mid || "0", from: data.from || "unknown" })
		}
		return json({ ok: true })
	}

	// GET /ice — either side fetches ICE candidates (filtered by sender)
	if (path === "/ice" && method === "GET") {
		const session = sessions.get(instanceId)
		if (!session) return json({ error: "Session not found" }, 404)
		const from = new URL(`http://x${req.url}`).searchParams.get("from") || ""
		// Return candidates NOT from the requester (i.e. from the other side)
		const candidates = session.iceCandidates
			.filter((c) => c.from !== from)
			.map((c) => ({ candidate: c.candidate, mid: c.mid || "0" }))
		return json({ candidates })
	}

	// GET /health
	if (path === "/health") {
		return json({ ok: true, sessions: sessions.size, turnPort: TURN_PORT })
	}

	json({ error: "Not found" }, 404)
}

httpServer.listen(PORT, () => {
	console.log(`Cline signaling server running on port ${PORT}`)
	console.log(`Health check: http://localhost:${PORT}/health`)
	console.log(`TURN credentials: http://localhost:${PORT}/turn-credentials`)
})
