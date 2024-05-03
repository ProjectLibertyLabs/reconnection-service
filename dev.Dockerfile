FROM node:20

WORKDIR /app

# Start the application
CMD ["npm", "run", "start:dev:docker"]
