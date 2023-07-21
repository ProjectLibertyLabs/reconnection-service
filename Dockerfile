FROM --platform=linux/amd64 node:18 as build

# TODO: The deployment docker image should install the reconnection
#       service from NPM rather than building from source
WORKDIR /app
COPY package*.json ./
RUN npm install

# Build / Copy the rest of the application files to the container and build
COPY . .
RUN npm run build

FROM  --platform=linux/amd64 node:18 as base

# Copy the built files from the build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/tsconfig.json ./
EXPOSE 3000

FROM  --platform=linux/amd64 node:18 as standalone

# Copy all files from the base stage
COPY --from=base . .

# Install Redis on top of the base image
RUN apt-get -y update
RUN apt-get -y install redis
RUN sed -e 's/^appendonly .*$/appendonly yes/' /etc/redis/redis.conf > /etc/redis/redis.conf.appendonly
RUN mv /etc/redis/redis.conf.appendonly /etc/redis/redis.conf

EXPOSE 3000

# Start the application
ENTRYPOINT service redis-server start && npm start

