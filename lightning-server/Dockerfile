FROM node:20-slim

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Create cache directory and set permissions
RUN mkdir -p cache && chown -R node:node /app

# Switch to non-root user
USER node

# Expose the port (Cloud Run defaults to 8080)
EXPOSE 8080

CMD [ "node", "index.js" ]
