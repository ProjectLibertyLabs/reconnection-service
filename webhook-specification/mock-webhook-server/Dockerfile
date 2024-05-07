FROM node:20 as build

# TODO: The deployment docker image should install the reconnection
#       service from NPM rather than building from source
WORKDIR /app
# RUN npm install

EXPOSE 3001

ENTRYPOINT npm install && npm start

VOLUME [ "/app" ]
