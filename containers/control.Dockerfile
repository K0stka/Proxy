FROM node:26.7.0-alpine3.24@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.js ./
COPY ui ./ui
COPY public ./public
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26.7.0-alpine3.24@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019
WORKDIR /app
RUN apk add --no-cache setpriv \
    && addgroup -g 10000 proxy && adduser -D -H -u 10001 -G proxy control \
    && mkdir /state /ipc /cert-status /cert-requests /cert-policy \
    && chown 10001:10000 /state /cert-policy && chown 10002:10000 /ipc \
    && chown 10003:10000 /cert-status /cert-requests \
    && chmod 2770 /ipc /cert-requests && chmod 2750 /cert-status /cert-policy
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY --chmod=755 containers/start.sh /usr/local/bin/proxy-start
USER 0:10000
ENV PROXY_STATE=/state PROXY_LISTEN_HOST=0.0.0.0
EXPOSE 3001
ENTRYPOINT ["proxy-start", "control"]
CMD ["node", "server/main.js"]
