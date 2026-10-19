FROM node:26-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.js ./
COPY ui ./ui
COPY shared ./shared
COPY containers/handoff-agent.js ./containers/handoff-agent.js
COPY public ./public
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26-alpine3.24
WORKDIR /app
ARG PROXY_SECURITY_REFRESH
RUN apk upgrade --no-cache && apk add --no-cache setpriv \
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
COPY containers/handoff-agent.js ./containers/handoff-agent.js
COPY --chmod=755 containers/start.sh /usr/local/bin/proxy-start
RUN chmod -R a+rX /app
USER 0:10000
ENV PROXY_STATE=/state PROXY_LISTEN_HOST=0.0.0.0
EXPOSE 3001
ENTRYPOINT ["proxy-start", "control"]
CMD ["node", "server/main.js"]

LABEL org.krychlic.proxy.managed=true
