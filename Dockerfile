FROM node:18-alpine

WORKDIR /app

# Copiar e instalar dependencias del backend
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copiar código del backend y frontend
COPY backend/ ./backend/
COPY control_gastos_app/ ./control_gastos_app/

# Crear directorios de datos (se montarán como volúmenes)
RUN mkdir -p /app/backend/data /app/backend/uploads/tickets /app/backend/uploads/extractos

EXPOSE 3000

WORKDIR /app/backend
CMD ["node", "server.js"]
