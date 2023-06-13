FROM node:18-alpine3.17 as build

# TODO: The deployment docker image should install the reconnection
#       service from NPM rather than building from source
WORKDIR /app
COPY package*.json ./
RUN npm install

# Build / Copy the rest of the application files to the container and build
COPY . .
RUN npm run build

from node:18-alpine3.17 as base

# Copy the built files from the build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./

from node:18-alpine3.17 as singleton

# Copy all files from the base stage
COPY --from=base . .

# Install Redis on top of the base image
RUN apk add --no-cache redis
EXPOSE 6379

# Start Redis service
CMD ["redis-server"]

# Start the application
CMD [ "npm", "start" ]
