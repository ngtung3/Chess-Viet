FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY index.html tsconfig.json vite.config.ts tailwind.config.js postcss.config.js ./
COPY src ./src
EXPOSE 3000
CMD ["npm", "run", "dev"]
