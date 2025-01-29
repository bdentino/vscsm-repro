FROM node:22-alpine

ADD . /app
WORKDIR /app
RUN npm install

ENTRYPOINT ["npm"]
CMD ["run", "start:dev"]
