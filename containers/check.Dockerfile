FROM node:26-alpine3.24
RUN apk upgrade --no-cache && apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git python3
ENV DOCKER_BUILDKIT=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN chmod -R a+rX /app \
    && mkdir -p /app/dist /app/node_modules/.vite-temp \
    && chown node:node /app/dist /app/node_modules/.vite-temp
# Dependency code runs without permission to modify the later Docker orchestrator.
USER node
RUN npm run check
RUN python3 -m unittest discover -s scripts -p test_security_update.py -v
USER root
CMD ["node", "scripts/test-containers.js"]
LABEL org.krychlic.proxy.managed=true
