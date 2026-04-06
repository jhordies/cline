FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY server.mjs ./
EXPOSE 3000
# TURN server ports (UDP + TCP)
EXPOSE 3478/udp
EXPOSE 3478/tcp
CMD ["node", "server.mjs"]
