FROM nginx:stable-alpine AS nginx
FROM node:26-alpine3.24
RUN apk upgrade --no-cache && apk add --no-cache pcre2 openssl ca-certificates setpriv \
    && addgroup -g 10000 proxy && adduser -D -H -u 10002 -G proxy edge \
    && mkdir -p /ipc /runtime /tls /sites && chown 10002:10000 /ipc /runtime \
    && chown 10003:10000 /tls && chmod 2770 /ipc && chmod 2750 /tls
COPY --from=nginx /usr/sbin/nginx /usr/sbin/nginx
COPY --from=nginx /etc/nginx/mime.types /etc/nginx/mime.types
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY edge ./edge
COPY shared ./shared
COPY containers/edge-entrypoint.sh /usr/local/bin/proxy-as-edge
COPY --chmod=755 containers/start.sh /usr/local/bin/proxy-start
RUN chmod 755 /usr/local/bin/proxy-as-edge && chmod -R a+rX /app
USER 0:10000
ENTRYPOINT ["proxy-start", "edge"]
CMD ["node", "edge/main.js"]

LABEL org.krychlic.proxy.managed=true
