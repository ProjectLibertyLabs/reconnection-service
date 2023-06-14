FROM node:18-alpine3.17

WORKDIR /app

# Do a clean install of packages to make sure any native addons are rebuilt for the target architecture
COPY package*.json ./
RUN npm ci

# Start the application
CMD ["npm", "run", "start:dev"]
