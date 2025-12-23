# Node + g++ + time 이 있는 이미지
FROM node:20-bookworm

# C++ 컴파일러와 time 설치
RUN apt-get update && \
    apt-get install -y g++ time && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
