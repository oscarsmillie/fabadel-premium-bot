# Use official Node.js LTS image
FROM node:20-slim

# Create working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy rest of the code
COPY . .

# Expose port (Cloud Run expects PORT env variable)
ENV PORT 8080
EXPOSE 8080

# Start the bot
CMD ["node", "index.js"]
