# Stage 1: Build
# ANTHROPIC_API_KEY and CLAUDE_RUN_CONFIG are injected at runtime — never baked in
FROM node:20-slim AS build

WORKDIR /app

COPY package.json ./

# Standalone tsconfig for the container build (../../tsconfig.base.json won't exist here)
RUN printf '{\n\
  "compilerOptions": {\n\
    "target": "ES2022",\n\
    "module": "NodeNext",\n\
    "moduleResolution": "NodeNext",\n\
    "strict": true,\n\
    "skipLibCheck": true,\n\
    "outDir": "dist",\n\
    "rootDir": "src",\n\
    "declaration": true\n\
  },\n\
  "include": ["src"]\n\
}\n' > tsconfig.build.json

RUN npm install --ignore-scripts

COPY src/ ./src/

RUN npx tsc --project tsconfig.build.json

# Stage 2: Runtime
# Non-root user prevents container privilege escalation
FROM node:20-slim AS runtime

# Runner code lives in /app — separate from /workspace so bind-mounting
# the agent workspace doesn't shadow the runner's dist/ and node_modules/.
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules

# /workspace is the agent's working directory, mounted per run via Binds.
RUN mkdir -p /workspace

# node:20-slim ships with a 'node' user at uid 1000 — use it directly
RUN chown -R node:node /app /workspace

USER node

ENV NODE_ENV=production

# ANTHROPIC_API_KEY is injected at runtime via container environment
ENTRYPOINT ["node", "/app/dist/runner/index.js"]
