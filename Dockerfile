FROM node:18-slim

# Dependencias necesarias para Chromium (Puppeteer) y para procesar imagenes (Jimp)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    libnss3 \
    libatk-bridge2.0-0 \
    libxss1 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Le decimos a Puppeteer que use el Chromium ya instalado en el sistema
# en vez de intentar descargar el suyo (mas rapido y mas liviano)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "index.js"]
