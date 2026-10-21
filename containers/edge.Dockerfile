FROM alpine/git:latest AS bouncer
RUN git clone https://github.com/crowdsecurity/lua-cs-bouncer.git /bouncer \
    && cd /bouncer && git checkout 92a8617ede3b781c33cd39e73734505597e318fd \
    && git clone --branch v0.17.2 --depth 1 https://github.com/ledgetech/lua-resty-http.git /http \
    && git clone --branch v0.15 --depth 1 https://github.com/openresty/lua-resty-string.git /string
FROM node:26-alpine3.24
ARG PROXY_SECURITY_REFRESH
RUN apk upgrade --no-cache && apk add --no-cache nginx nginx-mod-stream nginx-mod-http-lua lua5.1-cjson openssl ca-certificates setpriv \
    && addgroup -g 10000 proxy && adduser -D -H -u 10002 -G proxy edge \
    && mkdir -p /ipc /runtime /tls /sites && chown 10002:10000 /ipc /runtime \
    && chown 10003:10000 /tls && chmod 2770 /ipc && chmod 2750 /tls
COPY --from=bouncer /bouncer/lib /usr/local/share/lua/5.1
COPY --from=bouncer /http/lib /usr/local/share/lua/5.1
COPY --from=bouncer /string/lib /usr/local/share/lua/5.1
COPY --from=bouncer /bouncer/LICENSE /usr/share/licenses/lua-cs-bouncer/LICENSE
COPY --from=bouncer /http/LICENSE /usr/share/licenses/lua-resty-http/LICENSE
COPY --from=bouncer /string/README.markdown /usr/share/licenses/lua-resty-string/README.markdown
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY edge ./edge
COPY shared ./shared
COPY containers/handoff-agent.js ./containers/handoff-agent.js
COPY containers/edge-entrypoint.sh /usr/local/bin/proxy-as-edge
COPY --chmod=755 containers/start.sh /usr/local/bin/proxy-start
RUN chmod 755 /usr/local/bin/proxy-as-edge
USER 0:10000
ENTRYPOINT ["proxy-start", "edge"]
CMD ["node", "edge/main.js"]

LABEL org.krychlic.proxy.managed=true
