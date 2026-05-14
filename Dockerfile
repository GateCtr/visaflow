FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

RUN npm install -g pnpm@10.32.1

COPY pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json package.json ./
COPY artifacts/slot-hunter/ ./artifacts/slot-hunter/

RUN pnpm install --filter @workspace/slot-hunter --frozen-lockfile

RUN useradd -m -u 1001 slothunter && chown -R slothunter:slothunter /app

USER slothunter

CMD ["pnpm", "--filter", "@workspace/slot-hunter", "run", "start"]
