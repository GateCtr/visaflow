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
# Tell Puppeteer to use Playwright's Chromium (already installed)
ENV PUPPETEER_EXECUTABLE_PATH=/ms-playwright/chromium-1142/chrome

RUN pnpm install --frozen-lockfile --filter @workspace/slot-hunter

# Chromium is already installed in the base Playwright image
# No need to install it again

COPY artifacts/slot-hunter ./artifacts/slot-hunter

# Exécuter en utilisateur non-root — réduit la surface d'attaque
# en cas de compromission du process Playwright.
RUN useradd -m -u 1001 slothunter && chown -R slothunter:slothunter /app
USER slothunter

CMD ["pnpm", "--filter", "@workspace/slot-hunter", "run", "start"]
