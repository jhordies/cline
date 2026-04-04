FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY server.mjs ./
EXPOSE 3000
CMD ["node", "server.mjs"]
