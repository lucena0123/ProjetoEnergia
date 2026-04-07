FROM node:20-alpine
WORKDIR /app
ARG NEXT_PUBLIC_MAP_STYLE_URL="https://tiles.openfreemap.org/styles/liberty"
ARG NEXT_PUBLIC_API_URL="http://localhost:3001"
ENV NEXT_PUBLIC_MAP_STYLE_URL=$NEXT_PUBLIC_MAP_STYLE_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
