FROM node:26.7.0-alpine3.24@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019
RUN apk add --no-cache nginx=1.30.4-r1 nginx-mod-stream=1.30.4-r1 ca-certificates setpriv \
    && addgroup -g 10000 proxy && adduser -D -H -u 10002 -G proxy edge \
    && mkdir -p /ipc /runtime /tls /sites && chown 10002:10000 /ipc /runtime \
    && chown 10003:10000 /tls && chmod 2770 /ipc && chmod 2750 /tls
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY edge ./edge
COPY shared ./shared
COPY containers/edge-entrypoint.sh /usr/local/bin/proxy-as-edge
COPY --chmod=755 containers/start.sh /usr/local/bin/proxy-start
RUN chmod 755 /usr/local/bin/proxy-as-edge
USER 0:10000
ENTRYPOINT ["proxy-start", "edge"]
CMD ["node", "edge/main.js"]
