FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

RUN npm install -g pnpm@10

COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml ./
COPY .npmrc ./
COPY tsconfig.base.json ./
COPY tsconfig.json ./

COPY artifacts/slot-hunter/package.json ./artifacts/slot-hunter/package.json

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Skip browser installation in prepare:browsers script
ENV VERCEL=true
# Skip browser download during playwright installation
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Set Puppeteer cache dir to a location accessible by slothunter user
ENV PUPPETEER_CACHE_DIR=/app/.puppeteer-cache

RUN pnpm install --frozen-lockfile --filter @workspace/slot-hunter

COPY artifacts/slot-hunter ./artifacts/slot-hunter

# Create a symlink to Chromium binary (handles version numbers automatically!)
RUN for dir in /ms-playwright/chromium-*; do \
  if [ -d "$dir" ]; then \
    for bin in "$dir/chrome-linux/chrome" "$dir/chrome-linux64/chrome"; do \
      if [ -f "$bin" ]; then \
        ln -sf "$bin" /usr/local/bin/chromium; \
        break 2; \
      fi; \
    done; \
  fi; \
done
# Tell Puppeteer to use our symlink!
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium

# Exécuter en utilisateur non-root — réduit la surface d'attaque
# en cas de compromission du process Playwright.
RUN useradd -m -u 1001 slothunter && chown -R slothunter:slothunter /app
USER slothunter

CMD ["pnpm", "--filter", "@workspace/slot-hunter", "run", "start"]
