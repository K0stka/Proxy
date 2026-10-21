FROM node:26-alpine3.24
ARG PROXY_FILES_UID=1000
ARG PROXY_GIT_SSH_PATH=
ARG PROXY_SECURITY_REFRESH
RUN apk upgrade --no-cache && apk add --no-cache git openssh-client ca-certificates setpriv \
    && addgroup -g 10000 proxy && mkdir /ipc /sites \
    && if ! getent passwd "$PROXY_FILES_UID" >/dev/null; then adduser -D -H -u "$PROXY_FILES_UID" -G proxy files; fi
# Preserve ~ expansion in the VPS user's existing SSH config.
RUN if [ -n "$PROXY_GIT_SSH_PATH" ]; then \
      awk -F: -v OFS=: -v uid="$PROXY_FILES_UID" -v home="${PROXY_GIT_SSH_PATH%/*}" '$3 == uid { $6 = home } { print }' /etc/passwd >/tmp/passwd \
      && cat /tmp/passwd >/etc/passwd && rm /tmp/passwd; \
    fi
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY shared ./shared
COPY edge/sites.js ./edge/sites.js
COPY files ./files
COPY --chmod=755 containers/start.sh /usr/local/bin/proxy-start
COPY --chmod=755 containers/git-ssh.sh /usr/local/bin/proxy-git-ssh
USER 0:10000
ENTRYPOINT ["proxy-start", "files"]
CMD ["node", "files/main.js"]

LABEL org.krychlic.proxy.managed=true
