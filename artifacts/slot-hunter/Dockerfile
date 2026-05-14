FROM mcr.microsoft.com/playwright:v1.49.0-jammy

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
ENV VERCEL=true  # Skip browser installation in prepare:browsers script
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1  # Skip browser download during playwright installation

RUN pnpm install --frozen-lockfile --filter @workspace/slot-hunter

# Chromium is already installed in the base Playwright image
# No need to install it again

COPY artifacts/slot-hunter ./artifacts/slot-hunter

# Exécuter en utilisateur non-root — réduit la surface d'attaque
# en cas de compromission du process Playwright.
RUN useradd -m -u 1001 slothunter && chown -R slothunter:slothunter /app
USER slothunter

CMD ["pnpm", "--filter", "@workspace/slot-hunter", "run", "start"]
