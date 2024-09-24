FROM node:20 AS build

# TODO: The deployment docker image should install the reconnection
#       service from NPM rather than building from source
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Build / Copy the rest of the application files to the container and build
COPY . .
RUN npm run build

FROM build AS app-only

EXPOSE 3000

ENTRYPOINT npm run start:api:prod

FROM build AS standalone

# Install Redis on top of the base image
RUN apt-get -y update
RUN apt-get -y install redis
RUN sed -e 's/^appendonly .*$/appendonly yes/' /etc/redis/redis.conf > /etc/redis/redis.conf.appendonly
RUN mv /etc/redis/redis.conf.appendonly /etc/redis/redis.conf

ENV REDIS_URL=redis://localhost:6379

VOLUME [ "/var/lib/redis" ]

# Start the application
ENTRYPOINT service redis-server start && npm run start:api:prod
