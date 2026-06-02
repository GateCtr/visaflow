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

# Install Chrome for Puppeteer (after dependencies are installed)
RUN pnpm exec puppeteer browsers install chrome
# Use Puppeteer's installed Chrome (path matches our package.json puppeteer version)
ENV PUPPETEER_EXECUTABLE_PATH=/app/.puppeteer-cache/chrome/linux-149.0.7827.22/chrome-linux64/chrome

# Chromium is already installed in the base Playwright image
# No need to install it again

COPY artifacts/slot-hunter ./artifacts/slot-hunter

# Exécuter en utilisateur non-root — réduit la surface d'attaque
# en cas de compromission du process Playwright.
RUN useradd -m -u 1001 slothunter && chown -R slothunter:slothunter /app
USER slothunter

CMD ["pnpm", "--filter", "@workspace/slot-hunter", "run", "start"]
