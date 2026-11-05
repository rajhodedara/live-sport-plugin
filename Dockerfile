FROM node:22-slim

WORKDIR /app

# Copy package configs and install dependencies
COPY package*.json ./
RUN npm install

# Copy source code and assets
COPY . .

# Install internal resolver dependencies
RUN cd resolver && npm install

# Build the bundled distribution
# Install pinned official ICU timezone data before the candidate build.
# No downloads or timezone mutation occur when the application starts.
RUN npm run timezone:prepare
ENV ICU_TIMEZONE_FILES_DIR=/app/.timezone-data/2026f-le
RUN npm run build:local

# Configure runtime environment
ENV PORT=7000
ENV NODE_ENV=production
EXPOSE 7000

# Start server directly with node
CMD ["node", "dist/index.js"]

