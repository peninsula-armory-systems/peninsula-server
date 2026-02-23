FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ src/
COPY scripts/ scripts/
COPY docker-entrypoint.sh /usr/local/bin/

EXPOSE 4875

ENTRYPOINT ["docker-entrypoint.sh"]
