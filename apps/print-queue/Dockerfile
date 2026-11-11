FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 TZ=Asia/Bangkok DB_PATH=/data/data.db UPLOAD_DIR=/data/uploads
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
