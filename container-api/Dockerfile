FROM node:20-alpine
# Links the published image to our repo on GitHub
LABEL org.opencontainers.image.source="https://github.com/dsingh10-umd/group9-communication-app"
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]