FROM proxy-edge:latest
USER root
RUN apk add --no-cache openssl && chown 10002:10000 /tls
COPY test /app/test
USER 0:10000
ENV PROXY_LINUX_TEST=true
CMD ["node", "--test", "test/linux.test.js"]
