# BASE
FROM node:20.17.0 as base

WORKDIR /home/node/app

COPY package*.json ./

RUN npm i

COPY . .

# PRODUCTION
FROM base as production

ENV NODE_PATH=./build

RUN npm run build