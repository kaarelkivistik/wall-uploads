FROM node:6.2.2

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY . /usr/src/app

ENTRYPOINT [ "node", "src/app.js" ]