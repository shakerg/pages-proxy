FROM node:20

RUN apt-get update && apt-get install -y sqlite3 build-essential python3

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --omit=dev && \
    npm rebuild sqlite3

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]