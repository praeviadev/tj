# Stage 1: Preparation of assets
FROM node:18-alpine as assets-prep
WORKDIR /app

# Copy all static UI components
COPY index.html ./index.html
COPY login.html ./login.html
COPY tj.html ./tj.html


# Stage 2: Production environment
FROM node:18-alpine as production
WORKDIR /app

# Copy package.json and install production dependencies (Express, Express-Session)
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev

# Copy the Node.js production server logic
COPY server.js ./
COPY db.js ./

# Copy prepared UI assets into the public directory for the server to serve
COPY --from=assets-prep /app/index.html ./public/index.html
COPY --from=assets-prep /app/login.html ./public/login.html
COPY --from=assets-prep /app/tj.html ./public/tj.html

# Create non-root user for production security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
RUN chown -R nodejs:nodejs /app
USER nodejs

# Expose port 3000 to match your Traefik load balancer config
EXPOSE 3000

# Launch the Covenant Protocol
CMD ["node", "server.js"]