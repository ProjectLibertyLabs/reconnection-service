FROM node:18

WORKDIR /app

# Start the application
CMD ["npm", "run", "start:dev:docker"]
