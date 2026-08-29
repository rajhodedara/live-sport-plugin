FROM node:22-slim

WORKDIR /app

# Copy package configs and install dependencies
COPY package*.json ./
RUN npm install

# Install the standalone resolver's own dependencies
COPY resolver/package*.json ./resolver/
RUN cd resolver && npm install --omit=dev

# Copy source code and assets
COPY . .

# Build the bundled distribution
RUN npm run build

# Configure runtime environment
ENV PORT=7000
ENV NODE_ENV=production
EXPOSE 7000

# Start server directly with node
CMD ["node", "dist/index.js"]

