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

# Create non-root user
RUN useradd -m -u 1000 -s /bin/bash runner

WORKDIR /workspace

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules

RUN chown -R runner:runner /workspace

USER runner

ENV NODE_ENV=production

# ANTHROPIC_API_KEY is injected at runtime via container environment
ENTRYPOINT ["node", "dist/runner/index.js"]
