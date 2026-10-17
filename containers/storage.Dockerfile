FROM node:26.7.0-alpine3.24@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019
COPY containers/init-storage.mjs /init-storage.mjs
USER 0:10000
CMD ["node", "/init-storage.mjs"]
