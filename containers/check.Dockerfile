FROM node:26-alpine3.24
RUN apk upgrade --no-cache && apk add --no-cache docker-cli docker-cli-compose git python3
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run check
RUN python3 -m unittest discover -s scripts -p test_security_update.py -v
CMD ["node", "scripts/test-containers.js"]
LABEL org.krychlic.proxy.managed=true
