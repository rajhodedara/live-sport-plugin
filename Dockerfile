FROM node:22-slim

# Install system deps for Playwright Chromium and xvfb for headed browser support
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    xvfb \
    xauth \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install curl_cffi for Cloudflare TLS bypass (using --break-system-packages for Debian Bookworm)
RUN pip3 install curl_cffi --break-system-packages

WORKDIR /app

# Copy package files and install all dependencies
COPY package*.json ./
RUN npm install

# Install only Chromium for Playwright (skip Firefox/WebKit to save ~400MB)
RUN npx playwright install --with-deps chromium

# Copy the rest of the application code
COPY . .

# Build the bundled output in dist/
RUN npm run build

# Set default port
ENV PORT=7000
EXPOSE 7000

# Copy the run script
COPY run.sh ./
RUN chmod +x run.sh

# Start the application with xvfb to provide a virtual display for headed Chromium
CMD ["./run.sh"]
