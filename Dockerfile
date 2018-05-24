FROM node:8

WORKDIR /src
RUN apt-get update \
 && apt-get install -y --force-yes --no-install-recommends\
      jq \
 && rm -rf /var/lib/apt/lists/*;
ADD package.json .
ADD package-lock.json .
RUN npm install
ADD . .

CMD ["./bin/hubot", "--adapter", "slack"]
