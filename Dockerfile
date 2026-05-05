FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

RUN npm install -g pnpm@latest

COPY pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY artifacts/slot-hunter/package.json ./artifacts/slot-hunter/

RUN pnpm install --filter @workspace/slot-hunter --frozen-lockfile --ignore-scripts

RUN npx playwright install chromium

COPY artifacts/slot-hunter/ ./artifacts/slot-hunter/

CMD ["pnpm", "--filter", "@workspace/slot-hunter", "run", "start"]
