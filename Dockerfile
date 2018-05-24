FROM node:8

WORKDIR /src
ADD package.json .
ADD package-lock.json .
RUN npm install
ADD . .

CMD ["./bin/hubot", "--adapter", "slack"]
