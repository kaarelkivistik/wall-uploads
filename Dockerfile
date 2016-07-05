FROM node:6.2.2

ENV NPM_CONFIG_LOGLEVEL=error

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY . /usr/src/app
RUN npm install

ENTRYPOINT [ "node", "src/app.js" ]