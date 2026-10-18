FROM certbot/dns-cloudflare:latest
USER root
RUN apk upgrade --no-cache && apk add --no-cache openssl setpriv \
    && addgroup -g 10000 proxy && adduser -D -H -u 10003 -G proxy certificates \
    && mkdir -p /certbot /tls /cert-status /cert-requests \
    && chown -R 10003:10000 /certbot /tls /cert-status /cert-requests \
    && chmod 2750 /tls /cert-status && chmod 2770 /cert-requests
COPY certificates/worker.py /app/worker.py
COPY --chmod=755 containers/start.sh /usr/local/bin/proxy-start
USER 0:10000
ENTRYPOINT ["proxy-start", "certificates"]
CMD ["python", "/app/worker.py"]

LABEL org.krychlic.proxy.managed=true
