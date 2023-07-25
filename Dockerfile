FROM --platform=linux/amd64 node:18 as build

# TODO: The deployment docker image should install the reconnection
#       service from NPM rather than building from source
WORKDIR /app
COPY package*.json ./
RUN npm install

# Build / Copy the rest of the application files to the container and build
COPY . .
RUN npm run build

FROM build as base

EXPOSE 3000

ENTRYPOINT npm start

FROM base as standalone

# Install Redis on top of the base image
RUN apt-get -y update
RUN apt-get -y install redis
RUN sed -e 's/^appendonly .*$/appendonly yes/' /etc/redis/redis.conf > /etc/redis/redis.conf.appendonly
RUN mv /etc/redis/redis.conf.appendonly /etc/redis/redis.conf

# Start the application
ENTRYPOINT service redis-server start && npm start
