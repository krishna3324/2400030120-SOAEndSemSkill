FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY servers ./servers

EXPOSE 3000 8080
