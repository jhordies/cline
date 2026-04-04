# Cline Remote Bridge — Signaling Server

A tiny HTTP server (~100 lines) that helps the VSCode extension and mobile app
establish a WebRTC P2P connection. It only handles the ~2KB handshake — it never
sees any Cline messages or task content.

## Deploy on Synology NAS with Docker

### Option A: Synology Container Manager (GUI)

1. Copy this folder to your NAS (e.g. via File Station to `/docker/cline-signal/`)

2. Open **Container Manager** → **Project** → **Create**

3. Set the project path to `/docker/cline-signal/`

4. It will detect `docker-compose.yml` and deploy automatically

5. The server will be available at `http://YOUR-NAS-IP:3000`

### Option B: SSH command line

```bash
# SSH into your NAS
ssh admin@YOUR-NAS-IP

# Copy files (or use File Station)
mkdir -p /volume1/docker/cline-signal
# ... copy server.mjs, package.json, Dockerfile, docker-compose.yml

cd /volume1/docker/cline-signal
docker compose up -d --build

# Verify it's running
curl http://localhost:3000/health
# → {"ok":true,"sessions":0}
```

### Option C: Pre-built image (no build needed)

If you don't want to build on the NAS, build on your PC and push to Docker Hub:

```bash
# On your PC
cd c:\temp\remotecline\signaling-server
docker build -t YOUR-DOCKERHUB-USERNAME/cline-signal:latest .
docker push YOUR-DOCKERHUB-USERNAME/cline-signal:latest
```

Then in `docker-compose.yml`, replace `build: .` with:
```yaml
image: YOUR-DOCKERHUB-USERNAME/cline-signal:latest
```

And on the NAS:
```bash
docker compose pull && docker compose up -d
```

---

## Configure Cline

Once the server is running, update the signaling URL in VSCode:

1. Open Cline Settings → **Remote Access** tab
2. Enable remote access (tick the checkbox)
3. Set **Signaling server URL** to: `http://YOUR-NAS-IP:3000`
4. Click **Save**
5. Click **Show pairing QR code**
6. Scan with the mobile app

### Accessing from outside your home network

If you want to connect from mobile data (not just WiFi):

**Option 1: Synology DDNS + port forwarding**
- Enable DDNS in Synology Control Panel → External Access
- Forward port 3000 on your router to the NAS
- Use `http://yourname.synology.me:3000` as the signaling URL

**Option 2: Synology QuickConnect** (not suitable — only works for Synology apps)

**Option 3: Tailscale** (recommended for security)
- Install Tailscale on both the NAS and your phone
- Use the NAS's Tailscale IP as the signaling URL
- No port forwarding needed, encrypted

---

## Security note

The signaling server has no authentication by default. Anyone who knows your
NAS IP and port can register a session. This is fine for home use — the actual
Cline communication goes through the P2P WebRTC channel which is DTLS-encrypted.

For extra security, add a simple token check:
- Set `SECRET_TOKEN=your-secret` environment variable in docker-compose.yml
- The server will require `?token=your-secret` on all requests
- Update the signaling URL in Cline settings to include the token

---

## Troubleshooting

**Health check fails:**
```bash
docker logs cline-signal
```

**Port already in use:**
Change `3000:3000` to `3001:3000` in docker-compose.yml and use port 3001 in Cline settings.

**Container restarts:**
Check logs: `docker logs cline-signal --tail 50`
